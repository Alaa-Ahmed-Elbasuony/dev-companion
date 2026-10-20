// Derives realtime connections and messages from ordinary HTTP requests that
// carry a realtime protocol: Socket.IO/Engine.IO long polling, SignalR
// negotiation, long polling and the client-to-server half of the SignalR SSE
// transport. The HTTP entries stay in the request list as well.
import { endpointOf, fnv1a } from '../analysis/realtime/decode';
import { isNegotiateUrl, looksLikeSignalR, signalRConnectionToken } from '../analysis/realtime/signalr';
import {
  decodeEngineIoPacket,
  parseSocketIoUrl,
  sidFromOpenPacket,
  splitPollingPayload,
} from '../analysis/realtime/socketio';
import type {
  EntryBodies,
  NetworkDraft,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  Settings,
} from '../shared/types';
import { safeUrl } from '../shared/util';
import type { EntryStore } from '../storage/database';
import type { ProtocolHint, RealtimeIngestor, RealtimeOwner } from './realtime-ingest';
import { socketIoPollingConnectionId } from './realtime-ingest';

export function signalRPollingConnectionId(sessionId: string, token: string) {
  return `sr-poll:${sessionId}:${fnv1a(token)}`;
}

/** Finds a SignalR negotiate request for the hub that `url` belongs to, shortly before `at`. */
export async function findNegotiate(store: EntryStore, sessionId: string, url: string, at: number) {
  const target = safeUrl(url);
  if (!target) return undefined;
  const hubPath = target.pathname.replace(/\/+$/, '');
  const entries = await store.listEntries({ sessionId });
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.startedAt > at || at - e.startedAt > 60_000) continue;
    if (e.method !== 'POST' || !isNegotiateUrl(e.url)) continue;
    const u = safeUrl(e.url);
    if (u && u.host === target.host && u.pathname.replace(/\/negotiate$/i, '') === hubPath) return e;
  }
  return undefined;
}

interface DeriveInput {
  draft: NetworkDraft;
  /** Raw (pre-redaction) bodies; message content is redacted by the realtime ingestor. */
  bodies: EntryBodies | undefined;
  owner: RealtimeOwner;
  settings: Settings;
}

export class TransportDeriver {
  constructor(
    private readonly store: EntryStore,
    private readonly realtime: RealtimeIngestor,
  ) {}

  /** Returns the number of realtime messages derived from the request. */
  async derive(input: DeriveInput): Promise<number> {
    const { draft } = input;
    if (draft.state === 'pending') return 0;
    const sio = parseSocketIoUrl(draft.url);
    if (sio?.transport === 'polling') return this.socketIoPolling(input, sio.eio, sio.sid);
    if (isNegotiateUrl(draft.url)) return 0;
    const token = signalRConnectionToken(draft.url);
    if (token) return this.signalRHttp(input, token);
    return 0;
  }

  private connectionDraft(
    input: DeriveInput,
    id: string,
    patch: Partial<RealtimeConnectionDraft>,
  ): RealtimeConnectionDraft {
    const { draft } = input;
    return {
      id,
      pageId: draft.pageId,
      pageUrl: draft.pageUrl,
      transport: 'polling',
      url: draft.url,
      state: 'open',
      createdAt: draft.startedAt,
      openedAt: draft.responseAt ?? draft.endedAt,
      warnings: [],
      source: 'derived',
      ...patch,
    };
  }

  private async emitMessages(
    input: DeriveInput,
    connectionId: string,
    direction: 'in' | 'out',
    texts: string[],
  ): Promise<number> {
    const { draft, owner, settings } = input;
    let n = 0;
    for (const [i, text] of texts.entries()) {
      const message: RealtimeMessageDraft = {
        id: `${draft.id}:${direction}:${i}`,
        connectionId,
        direction,
        // Sent payloads leave when the request starts; received ones arrive with the response.
        timestamp: (direction === 'out' ? draft.startedAt : (draft.endedAt ?? draft.startedAt)) + i * 0.001,
        opcode: 'text',
        text,
        source: 'derived',
        note: `Derived from ${draft.method} request ${draft.id}`,
      };
      if (await this.realtime.ingestMessage(message, owner, settings)) n++;
    }
    return n;
  }

  private async lifecycle(input: DeriveInput, connectionId: string, note: string, kind: 'error' | 'close') {
    const { draft, owner, settings } = input;
    await this.realtime.ingestMessage(
      {
        id: `${draft.id}:${kind}`,
        connectionId,
        direction: 'none',
        timestamp: draft.endedAt ?? draft.startedAt,
        opcode: 'lifecycle',
        lifecycle: kind,
        note,
        source: 'derived',
      },
      owner,
      settings,
    );
  }

  private async socketIoPolling(input: DeriveInput, eio: number, urlSid: string | undefined) {
    const { draft, bodies, owner, settings } = input;
    const outgoing = draft.method === 'POST';
    const text = (outgoing ? bodies?.request?.text : bodies?.response?.text) ?? '';
    let packets: string[] = [];
    let splitError: string | undefined;
    try {
      packets = splitPollingPayload(text, eio);
    } catch (err) {
      splitError = String(err instanceof Error ? err.message : err);
    }
    let sid = urlSid;
    if (!sid && !outgoing) {
      const decoded = packets.flatMap((p) => {
        try {
          return [decodeEngineIoPacket(p, eio)];
        } catch {
          return [];
        }
      });
      sid = sidFromOpenPacket(decoded);
    }
    if (!sid) return 0;
    const id = socketIoPollingConnectionId(owner.sessionId, sid);
    const failed = draft.state !== 'complete' || (draft.status ?? 0) >= 400;
    const hint: ProtocolHint = { protocol: 'socket.io', evidence: 'EIO query parameter (polling transport)' };
    await this.realtime.ingestConnection(
      this.connectionDraft(input, id, {
        state: failed ? 'failed' : 'open',
        errorMessage: failed
          ? `Polling request ${draft.id} failed (${draft.status ?? draft.state})`
          : undefined,
      }),
      owner,
      settings,
      hint,
    );
    if (failed) {
      await this.lifecycle(
        input,
        id,
        `Polling ${draft.method} failed: ${draft.status ?? draft.state}`,
        'error',
      );
      return 0;
    }
    if (splitError) {
      await this.realtime.ingestMessage(
        {
          id: `${draft.id}:${outgoing ? 'out' : 'in'}:raw`,
          connectionId: id,
          direction: outgoing ? 'out' : 'in',
          timestamp: outgoing ? draft.startedAt : (draft.endedAt ?? draft.startedAt),
          opcode: 'text',
          text,
          note: `Polling payload could not be split: ${splitError}`,
          source: 'derived',
        },
        owner,
        settings,
      );
      return 1;
    }
    return this.emitMessages(input, id, outgoing ? 'out' : 'in', packets);
  }

  private async signalRHttp(input: DeriveInput, token: string) {
    const { draft, bodies, owner, settings } = input;
    const outgoing = draft.method === 'POST';
    const text = (outgoing ? bodies?.request?.text : bodies?.response?.text) ?? '';
    const negotiate = await findNegotiate(this.store, owner.sessionId, draft.url, draft.startedAt);
    if (!negotiate && !looksLikeSignalR(text)) return 0;

    // SSE transport: sends are POSTs to the same URL as the EventSource.
    const endpoint = endpointOf(draft.url);
    const sse = (await this.store.listConnections({ tabId: owner.tabId })).find(
      (c) =>
        c.sessionId === owner.sessionId &&
        c.transport === 'eventsource' &&
        endpointOf(c.url) === endpoint &&
        signalRConnectionToken(c.url) === token,
    );
    const hint: ProtocolHint = {
      protocol: 'signalr',
      evidence: negotiate ? `negotiate request ${negotiate.id}` : 'JSON Hub Protocol record framing',
      negotiateEntryId: negotiate?.id,
    };
    let id: string;
    if (sse && outgoing) {
      id = sse.id;
    } else {
      id = signalRPollingConnectionId(owner.sessionId, token);
      const closing = draft.method === 'DELETE';
      const failed = draft.state !== 'complete' || (draft.status ?? 0) >= 400;
      await this.realtime.ingestConnection(
        this.connectionDraft(input, id, {
          state: closing ? 'closed' : failed && draft.status !== 204 ? 'failed' : 'open',
          closedAt: closing ? draft.endedAt : undefined,
          errorMessage: failed ? `Request ${draft.id} failed (${draft.status ?? draft.state})` : undefined,
        }),
        owner,
        settings,
        hint,
      );
      if (closing) {
        await this.lifecycle(input, id, 'Client closed the long-polling connection (DELETE)', 'close');
        return 0;
      }
      if (failed && draft.status !== 204) {
        await this.lifecycle(
          input,
          id,
          `Long-polling ${draft.method} failed: ${draft.status ?? draft.state}`,
          'error',
        );
        return 0;
      }
    }
    if (!text) return 0;
    return this.emitMessages(input, id, outgoing ? 'out' : 'in', [text]);
  }
}
