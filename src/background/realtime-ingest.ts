// Turns sanitized realtime drafts (from the main-world recorder, CDP, or derived
// from polling requests) into persisted connections and messages: protocol
// detection and decoding, redaction, reconnect/upgrade linking and merging of
// duplicate observations from several capture mechanisms.
import {
  createRedactor,
  redactBodyText,
  redactFreeText,
  redactJsonValue,
  redactUrl,
} from '../analysis/redaction';
import type { Redactor } from '../analysis/redaction';
import {
  CONNECTION_MATCH_WINDOW_MS,
  DEDUP_WINDOW_MS,
  decodeMessage,
  dedupKey,
  detectProtocol,
  endpointOf,
  refineProtocol,
} from '../analysis/realtime/decode';
import { parseSocketIoUrl } from '../analysis/realtime/socketio';
import type {
  DecodedPacket,
  RealtimeConnection,
  RealtimeProtocol,
  RealtimeConnectionDraft,
  RealtimeMessage,
  RealtimeMessageDraft,
  RealtimeState,
  Settings,
} from '../shared/types';
import { utf8Length } from '../shared/util';
import type { EntryStore } from '../storage/database';

export interface RealtimeOwner {
  sessionId: string;
  tabId: number;
  origin: string;
}

const TERMINAL: RealtimeState[] = ['closed', 'failed'];

/** Protocol already known from context (derived transports, negotiate requests). */
export interface ProtocolHint {
  protocol: RealtimeProtocol;
  evidence: string;
  negotiateEntryId?: string;
}

/** Looks up evidence for a SignalR connection (a preceding negotiate request). */
export type NegotiateLookup = (
  sessionId: string,
  url: string,
  at: number,
) => Promise<{ id: string } | undefined>;

/** Connection ids reported by CDP that were merged into a main-world connection. */
export const ALIAS_WARNING_PREFIX = 'Also observed by ';

export function socketIoPollingConnectionId(sessionId: string, sid: string) {
  return `sio-poll:${sessionId}:${sid}`;
}

function mergeState(current: RealtimeState, next: RealtimeState): RealtimeState {
  // Terminal states are final: a late "open" from a slower mechanism never revives a closed socket.
  if (TERMINAL.includes(current)) return current;
  return next;
}

export class RealtimeIngestor {
  /**
   * Reported id -> stored connection id, per worker lifetime: CDP request ids merged into a
   * main-world connection (also persisted as `aliases`) and ids already known to exist.
   */
  private readonly aliasCache = new Map<string, string>();

  constructor(
    private readonly store: EntryStore,
    private readonly negotiateLookup?: NegotiateLookup,
  ) {}

  /** Resolves an id reported by any mechanism to the stored connection id. */
  async resolveConnectionId(tabId: number, id: string): Promise<string | undefined> {
    const cached = this.aliasCache.get(id);
    if (cached) return cached;
    if (await this.store.getConnection(id)) {
      this.aliasCache.set(id, id);
      return id;
    }
    const list = await this.store.listConnections({ tabId });
    const owner = list.find((c) => c.aliases?.includes(id));
    if (owner) this.aliasCache.set(id, owner.id);
    return owner?.id;
  }

  async ingestConnection(
    draft: RealtimeConnectionDraft,
    owner: RealtimeOwner,
    settings: Settings,
    hint?: ProtocolHint,
  ) {
    const r = createRedactor(settings.redaction);
    const url = redactUrl(draft.url, r);
    const pageUrl = redactUrl(draft.pageUrl, r);
    const redacted: RealtimeConnectionDraft = {
      ...draft,
      url: url.url,
      pageUrl: pageUrl.url,
      closeReason: draft.closeReason ? redactFreeText(draft.closeReason, settings.redaction) : undefined,
      errorMessage: draft.errorMessage ? redactFreeText(draft.errorMessage, settings.redaction) : undefined,
    };
    const redactions = url.count + pageUrl.count;

    const targetId = (await this.resolveConnectionId(owner.tabId, draft.id)) ?? draft.id;
    const existing = await this.store.getConnection(targetId);
    if (existing) {
      if (existing.sessionId !== owner.sessionId) return false;
      await this.store.updateConnection(targetId, (current) =>
        current ? this.merge(current, redacted, redactions) : null,
      );
      return true;
    }

    // A connection seen by a second mechanism: merge into the first one.
    const twin = await this.findTwin(redacted, owner);
    if (twin) {
      this.aliasCache.set(draft.id, twin.id);
      await this.store.updateConnection(twin.id, (current) =>
        current
          ? {
              ...this.merge(current, redacted, redactions),
              aliases: [...new Set([...(current.aliases ?? []), draft.id])],
            }
          : null,
      );
      return true;
    }

    const previous = await this.findPrevious(redacted, owner);
    const sio = parseSocketIoUrl(draft.url);
    let protocol = hint?.protocol ?? detectProtocol(draft);
    let protocolEvidence = hint?.evidence ?? (sio ? 'EIO query parameter' : undefined);
    let negotiateEntryId = hint?.negotiateEntryId;
    if (!hint && protocol !== 'socket.io' && this.negotiateLookup) {
      const negotiate = await this.negotiateLookup(owner.sessionId, draft.url, draft.createdAt);
      if (negotiate) {
        protocol = 'signalr';
        protocolEvidence = `negotiate request ${negotiate.id}`;
        negotiateEntryId = negotiate.id;
      }
    }
    // The upgrade's WebSocket can be recorded before the polling handshake response
    // (body reading finishes later): close the polling connection on creation then.
    if (draft.transport === 'polling') {
      const upgrade = (await this.store.listConnections({ tabId: owner.tabId })).find(
        (c) => c.sessionId === owner.sessionId && c.upgradedFrom === draft.id,
      );
      if (upgrade) {
        redacted.state = 'closed';
        redacted.closedAt = upgrade.createdAt;
        redacted.warnings = [...redacted.warnings, `Upgraded to WebSocket (${upgrade.id})`];
      }
    }
    const connection: RealtimeConnection = {
      ...redacted,
      sessionId: owner.sessionId,
      tabId: owner.tabId,
      origin: owner.origin,
      protocol,
      protocolEvidence,
      negotiateEntryId,
      sources: [draft.source],
      reconnectOf: previous?.id,
      attempt: previous ? previous.attempt + 1 : 0,
      upgradedFrom:
        sio?.transport === 'websocket' && sio.sid
          ? socketIoPollingConnectionId(owner.sessionId, sio.sid)
          : undefined,
      inCount: 0,
      outCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      redactions,
    };
    await this.store.putConnection(connection);
    if (connection.upgradedFrom) {
      await this.store.updateConnection(connection.upgradedFrom, (c) =>
        c && !TERMINAL.includes(c.state)
          ? {
              ...c,
              state: 'closed',
              closedAt: c.closedAt ?? draft.createdAt,
              warnings: [...c.warnings, `Upgraded to WebSocket (${connection.id})`],
            }
          : null,
      );
    }
    return true;
  }

  private merge(
    current: RealtimeConnection,
    draft: RealtimeConnectionDraft,
    redactions: number,
  ): RealtimeConnection {
    const state = mergeState(current.state, draft.state);
    return {
      ...current,
      state,
      openedAt: current.openedAt ?? draft.openedAt,
      closedAt: current.closedAt ?? draft.closedAt,
      closeCode: current.closeCode ?? draft.closeCode,
      closeReason: current.closeReason ?? draft.closeReason,
      wasClean: current.wasClean ?? draft.wasClean,
      errorMessage: current.errorMessage ?? draft.errorMessage,
      selectedProtocol: current.selectedProtocol ?? draft.selectedProtocol,
      requestedProtocols: current.requestedProtocols ?? draft.requestedProtocols,
      warnings: [...new Set([...current.warnings, ...draft.warnings])].slice(0, 30),
      sources: current.sources.includes(draft.source) ? current.sources : [...current.sources, draft.source],
      // Main-world observations carry the page id; CDP-only ones do not.
      pageId: current.pageId || draft.pageId,
      redactions: Math.max(current.redactions, redactions),
    };
  }

  /** Same URL, same tab, created within the match window, observed by another mechanism. */
  private async findTwin(draft: RealtimeConnectionDraft, owner: RealtimeOwner) {
    const list = await this.store.listConnections({ tabId: owner.tabId });
    let best: RealtimeConnection | undefined;
    for (const c of list) {
      if (c.sessionId !== owner.sessionId || c.sources.includes(draft.source)) continue;
      if (c.url !== draft.url || c.transport !== draft.transport) continue;
      const delta = Math.abs(c.createdAt - draft.createdAt);
      if (delta > CONNECTION_MATCH_WINDOW_MS) continue;
      if (!best || delta < Math.abs(best.createdAt - draft.createdAt)) best = c;
    }
    return best;
  }

  /** The most recent earlier connection to the same endpoint in the same document. */
  private async findPrevious(draft: RealtimeConnectionDraft, owner: RealtimeOwner) {
    const endpoint = endpointOf(draft.url);
    const list = await this.store.listConnections({ tabId: owner.tabId });
    return list
      .filter(
        (c) =>
          c.sessionId === owner.sessionId &&
          c.id !== draft.id &&
          c.transport === draft.transport &&
          c.createdAt <= draft.createdAt &&
          (c.pageId === draft.pageId || !c.pageId || !draft.pageId) &&
          endpointOf(c.url) === endpoint,
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  async ingestMessage(
    draft: RealtimeMessageDraft,
    owner: RealtimeOwner,
    settings: Settings,
  ): Promise<boolean> {
    return (await this.ingestMessages([draft], owner, settings))[0] ?? false;
  }

  /** Stores a run of messages in one transaction; returns, per draft, whether it was stored. */
  async ingestMessages(
    drafts: RealtimeMessageDraft[],
    owner: RealtimeOwner,
    settings: Settings,
  ): Promise<boolean[]> {
    const results = drafts.map(() => false);
    const items: { index: number; draft: RealtimeMessageDraft; connectionId: string }[] = [];
    for (const [index, draft] of drafts.entries()) {
      const connectionId = await this.resolveConnectionId(owner.tabId, draft.connectionId);
      if (connectionId) items.push({ index, draft, connectionId });
    }
    const stored = await this.store.addMessages(items, async ({ draft, connectionId }, lookup) => {
      let connection = await lookup.connection(connectionId);
      if (!connection || connection.sessionId !== owner.sessionId) return null;

      const protocol = refineProtocol(connection.protocol, draft);
      const changed = protocol !== connection.protocol;
      if (changed)
        connection = { ...connection, protocol, protocolEvidence: 'JSON Hub Protocol record framing' };

      const size = draft.size ?? (draft.text !== undefined ? utf8Length(draft.text) : undefined);
      const key = dedupKey(
        connectionId,
        draft.direction,
        draft.opcode,
        size,
        draft.text,
        draft.lifecycle ?? '',
      );
      const twin = closestTwin(await lookup.sameKey(key), draft);
      if (twin) {
        // Prefer the untruncated copy when the other mechanism saw more of the payload.
        const patch: Partial<RealtimeMessage> =
          twin.truncated && draft.text && !draft.truncated
            ? this.content(draft, protocol, connection.url, settings)
            : {};
        return {
          connection: changed ? connection : undefined,
          update: { ...twin, ...patch, sources: [...twin.sources, draft.source] },
        };
      }
      return {
        connection: changed ? connection : undefined,
        message: {
          ...draft,
          connectionId,
          size,
          sessionId: owner.sessionId,
          tabId: owner.tabId,
          sources: [draft.source],
          dedupKey: key,
          ...this.content(draft, protocol, connection.url, settings),
        },
      };
    });
    stored.forEach((ok, i) => (results[items[i]!.index] = ok));
    return results;
  }

  /** Decoded and redacted payload fields of a message. */
  private content(
    draft: RealtimeMessageDraft,
    protocol: RealtimeConnection['protocol'],
    connectionUrl: string,
    settings: Settings,
  ): Pick<
    RealtimeMessage,
    'text' | 'truncated' | 'decoded' | 'parseError' | 'decodeNote' | 'redactions' | 'note'
  > {
    const r = createRedactor(settings.redaction);
    const result = decodeMessage(protocol, draft, connectionUrl);
    let redactions = 0;
    let text = draft.text;
    if (text !== undefined) {
      const kind = /^\s*[{[]/.test(text) ? 'json' : 'text';
      const res = redactBodyText(text, kind, r);
      text = res.text;
      redactions += res.count;
    }
    let decoded = result.decoded;
    if (decoded) {
      const res = redactDecoded(decoded, r);
      decoded = res.decoded;
      redactions += res.count;
      // Keep decoded structure bounded: drop args/results of very large frames (the raw text remains).
      if (JSON.stringify(decoded).length > settings.maxFrameKB * 1024 * 2) {
        decoded = decoded.map((p) => ({ ...p, args: undefined, result: undefined }));
      }
    }
    return {
      text,
      truncated: draft.truncated,
      decoded,
      parseError: result.parseError,
      decodeNote: result.decodeNote,
      redactions,
      note: draft.note ? redactFreeText(draft.note, settings.redaction) : undefined,
    };
  }
}

/** The closest observation of the same frame by a different mechanism, within the dedup window. */
function closestTwin(candidates: RealtimeMessage[], draft: RealtimeMessageDraft) {
  let best: RealtimeMessage | undefined;
  for (const m of candidates) {
    if (m.sources.includes(draft.source)) continue;
    const delta = Math.abs(m.timestamp - draft.timestamp);
    if (delta > DEDUP_WINDOW_MS) continue;
    if (!best || delta < Math.abs(best.timestamp - draft.timestamp)) best = m;
  }
  return best;
}

export function redactDecoded(
  decoded: DecodedPacket[],
  r: Redactor,
): { decoded: DecodedPacket[]; count: number } {
  let count = 0;
  const out = decoded.map((p) => {
    const next = { ...p };
    if (p.args !== undefined) {
      const res = redactJsonValue(p.args, r);
      next.args = res.value as unknown[];
      count += res.count;
    }
    if (p.result !== undefined) {
      const res = redactJsonValue(p.result, r);
      next.result = res.value;
      count += res.count;
    }
    if (p.error) {
      const res = r.redactString(p.error);
      next.error = res.value;
      count += res.count;
    }
    return next;
  });
  return { decoded: out, count };
}
