// Optional "advanced capture" through the Chrome DevTools Protocol
// (chrome.debugger). Off by default; enabled per recording tab by the user.
// Chrome shows its own "started debugging this browser" banner while attached,
// and attaching fails when another debugger (e.g. an open DevTools on some
// versions) conflicts.
//
// It is a second producer of the same drafts as the main-world recorder and
// feeds the same Ingestor, which merges duplicate observations. It adds
// what the page cannot observe: every SSE event type (not only the ones the page
// subscribes to), the document's redirect chain and response headers. Sockets
// created before the debugger attached are not reported by CDP.
import { createRedactor, redactHeaders } from '../analysis/redaction';
import type { AdvancedCaptureResult, PageMessage } from '../shared/messages';
import type {
  HeaderPair,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RecordingState,
  Settings,
} from '../shared/types';
import { createId, originOf } from '../shared/util';
import type { EntryStore } from '../storage/database';

const PROTOCOL_VERSION = '1.3';
const META_KEY = 'cdpRequestMeta';
const FLUSH_MS = 100;

export interface AdvancedCaptureDeps {
  store: EntryStore;
  settings: () => Promise<Settings>;
  recording: (tabId: number) => Promise<RecordingState | null>;
  setAdvancedFlag: (tabId: number, advanced: boolean) => Promise<void>;
  ingest: (tabId: number, events: PageMessage[]) => Promise<unknown>;
  onChanged: () => void;
}

/** What later CDP events of a request need but do not repeat (persisted for worker restarts). */
interface RequestMeta {
  /** Wall-clock ms minus CDP monotonic ms. */
  offset?: number;
  url?: string;
  transport?: RealtimeConnectionDraft['transport'];
}

interface Pending {
  events: PageMessage[];
  timer?: ReturnType<typeof setTimeout>;
}

type Params = Record<string, unknown>;

/** Bytes encoded by a base64 string (CDP sends binary frame payloads base64-encoded). */
export function base64Size(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function cdpConnectionId(tabId: number, requestId: string) {
  return `cdp:${tabId}:${requestId}`;
}

function headersFrom(obj: unknown): HeaderPair[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>)
    .slice(0, 200)
    .map(([name, value]) => ({ name: name.toLowerCase(), value: String(value) }));
}

const DOCUMENT_HEADERS = [
  'server-timing',
  'traceparent',
  'tracestate',
  'traceresponse',
  'x-request-id',
  'x-correlation-id',
  'x-nextjs-cache',
  'x-nextjs-prerender',
  'x-vercel-cache',
  'cf-cache-status',
  'age',
  'cache-control',
  'content-type',
  'x-powered-by',
];

export class AdvancedCapture {
  private readonly pending = new Map<number, Pending>();
  private meta: Record<string, RequestMeta> | null = null;
  private readonly redirects = new Map<string, { url: string; status: number }[]>();

  constructor(private readonly deps: AdvancedCaptureDeps) {}

  private async loadMeta() {
    if (!this.meta) {
      const data = await chrome.storage.session.get(META_KEY);
      this.meta = (data[META_KEY] as Record<string, RequestMeta> | undefined) ?? {};
    }
    return this.meta;
  }

  private async getMeta(tabId: number, requestId: string): Promise<RequestMeta | undefined> {
    return (await this.loadMeta())[`${tabId}:${requestId}`];
  }

  private async setMeta(tabId: number, requestId: string, patch: RequestMeta) {
    const meta = await this.loadMeta();
    const key = `${tabId}:${requestId}`;
    meta[key] = { ...meta[key], ...patch };
    const keys = Object.keys(meta);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete meta[k];
    await chrome.storage.session.set({ [META_KEY]: meta });
  }

  /** Converts a CDP MonotonicTime (seconds) to epoch milliseconds. */
  private async wallTime(tabId: number, requestId: string, monotonic: unknown): Promise<number> {
    if (typeof monotonic !== 'number') return Date.now();
    const offset = (await this.getMeta(tabId, requestId))?.offset;
    return offset !== undefined ? monotonic * 1000 + offset : Date.now();
  }

  static async hasPermission(): Promise<boolean> {
    try {
      return await chrome.permissions.contains({ permissions: ['debugger'] });
    } catch {
      return false;
    }
  }

  async enable(tabId: number): Promise<AdvancedCaptureResult> {
    const rec = await this.deps.recording(tabId);
    if (!rec) return { ok: false, reason: 'not-recording', message: 'Start recording this tab first.' };
    if (!(await AdvancedCapture.hasPermission())) {
      return {
        ok: false,
        reason: 'permission-required',
        message: 'Advanced capture needs the "debugger" permission. Reload the extension to apply it.',
      };
    }
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      // Already attached by us (e.g. after a worker restart): keep going.
      if (!/already attached/i.test(message)) {
        return { ok: false, reason: 'attach-failed', message: `Could not attach the debugger: ${message}` };
      }
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: 0 });
    } catch (err) {
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      return { ok: false, reason: 'attach-failed', message: `Network.enable failed: ${String(err)}` };
    }
    await this.deps.setAdvancedFlag(tabId, true);
    await this.note(
      rec,
      'Advanced capture attached (chrome.debugger); Chrome shows a debugging banner while it is on',
    );
    this.deps.onChanged();
    return { ok: true, attached: true };
  }

  async disable(tabId: number, reason = 'Advanced capture turned off'): Promise<void> {
    const rec = await this.deps.recording(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    await this.flush(tabId);
    if (rec?.advanced) {
      await this.deps.setAdvancedFlag(tabId, false);
      await this.note(rec, reason);
    }
    this.deps.onChanged();
  }

  /** On worker start: drop the flag for tabs where the debugger is no longer attached. */
  async reconcile(states: RecordingState[]): Promise<void> {
    const flagged = states.filter((s) => s.advanced);
    if (!flagged.length) return;
    let attached = new Set<number>();
    try {
      const targets = await chrome.debugger.getTargets();
      attached = new Set(targets.filter((t) => t.attached && t.tabId !== undefined).map((t) => t.tabId!));
    } catch {
      /* permission revoked */
    }
    for (const rec of flagged) {
      if (attached.has(rec.tabId)) continue;
      await this.deps.setAdvancedFlag(rec.tabId, false);
      await this.note(rec, 'Advanced capture is no longer attached; main-world capture continues');
    }
  }

  async onDetach(tabId: number, reason: string) {
    const rec = await this.deps.recording(tabId);
    if (!rec?.advanced) return;
    await this.flush(tabId);
    await this.deps.setAdvancedFlag(tabId, false);
    const why =
      reason === 'canceled_by_user'
        ? 'the debugging banner was dismissed'
        : reason === 'target_closed'
          ? 'the tab was closed'
          : reason;
    await this.note(rec, `Advanced capture detached (${why}); main-world capture continues`);
    this.deps.onChanged();
  }

  private async note(rec: RecordingState, message: string) {
    await this.deps.store.putTimeline({
      id: createId(),
      sessionId: rec.sessionId,
      tabId: rec.tabId,
      origin: rec.origin,
      pageId: '',
      pageUrl: '',
      kind: 'capture',
      timestamp: Date.now(),
      message,
      source: 'cdp',
    });
  }

  private queue(tabId: number, event: PageMessage) {
    let p = this.pending.get(tabId);
    if (!p) {
      p = { events: [] };
      this.pending.set(tabId, p);
    }
    p.events.push(event);
    if (p.events.length >= 200) void this.flush(tabId);
    else p.timer ??= setTimeout(() => void this.flush(tabId), FLUSH_MS);
  }

  async flush(tabId: number) {
    const p = this.pending.get(tabId);
    if (!p) return;
    this.pending.delete(tabId);
    if (p.timer) clearTimeout(p.timer);
    if (!p.events.length) return;
    // Only events of the recorded origin: the user may have navigated the tab elsewhere.
    const rec = await this.deps.recording(tabId);
    let tabOrigin: string;
    try {
      tabOrigin = originOf((await chrome.tabs.get(tabId)).url ?? '');
    } catch {
      return;
    }
    if (!rec || rec.origin !== tabOrigin) return;
    await this.deps.ingest(tabId, p.events);
  }

  /** Queues a connection create/update; returns false when the request is not a known connection. */
  private async connection(tabId: number, requestId: string, patch: Partial<RealtimeConnectionDraft>) {
    const meta = await this.getMeta(tabId, requestId);
    const url = patch.url || meta?.url;
    const transport = patch.transport ?? meta?.transport;
    if (!url || !transport) return false;
    const draft: RealtimeConnectionDraft = {
      id: cdpConnectionId(tabId, requestId),
      pageId: '',
      pageUrl: '',
      state: 'connecting',
      createdAt: Date.now(),
      warnings: [],
      source: 'cdp',
      ...patch,
      url,
      transport,
    };
    this.queue(tabId, { type: 'rt-connection', connection: draft });
    return true;
  }

  private message(
    tabId: number,
    requestId: string,
    patch: Omit<RealtimeMessageDraft, 'id' | 'connectionId' | 'source'>,
  ) {
    this.queue(tabId, {
      type: 'rt-message',
      message: { id: createId(), connectionId: cdpConnectionId(tabId, requestId), source: 'cdp', ...patch },
    });
  }

  /** chrome.debugger.onEvent handler. */
  async onEvent(tabId: number, method: string, params: Params): Promise<void> {
    const rec = await this.deps.recording(tabId);
    if (!rec?.advanced || rec.paused) return;
    const settings = await this.deps.settings();
    const requestId = String(params.requestId ?? '');
    switch (method) {
      case 'Network.webSocketCreated': {
        if (!settings.captureRealtime) return;
        const url = String(params.url ?? '');
        await this.setMeta(tabId, requestId, { url, transport: 'websocket' });
        await this.connection(tabId, requestId, { transport: 'websocket', url });
        return;
      }
      case 'Network.webSocketWillSendHandshakeRequest': {
        if (typeof params.wallTime === 'number' && typeof params.timestamp === 'number') {
          await this.setMeta(tabId, requestId, { offset: params.wallTime * 1000 - params.timestamp * 1000 });
        }
        return;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const response = (params.response ?? {}) as Params;
        const at = await this.wallTime(tabId, requestId, params.timestamp);
        const headers = headersFrom(response.headers);
        const status = Number(response.status);
        await this.connection(tabId, requestId, {
          state: status === 101 ? 'open' : 'failed',
          openedAt: status === 101 ? at : undefined,
          selectedProtocol: headers.find((h) => h.name === 'sec-websocket-protocol')?.value,
          errorMessage: status === 101 ? undefined : `Handshake answered with HTTP ${status}`,
        });
        this.message(tabId, requestId, {
          direction: 'none',
          timestamp: at,
          opcode: 'lifecycle',
          lifecycle: status === 101 ? 'open' : 'error',
          note: `Handshake response HTTP ${status}`,
        });
        return;
      }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        if (!settings.captureRealtime) return;
        const response = (params.response ?? {}) as Params;
        const opcode = Number(response.opcode);
        // 1 = text, 2 = binary; control frames (ping/pong/close) are not reported as data frames.
        if (opcode !== 1 && opcode !== 2) return;
        const payload = String(response.payloadData ?? '');
        const timestamp = await this.wallTime(tabId, requestId, params.timestamp);
        const direction = method === 'Network.webSocketFrameSent' ? 'out' : 'in';
        if (opcode === 2) {
          this.message(tabId, requestId, {
            direction,
            timestamp,
            opcode: 'binary',
            size: base64Size(payload),
            binaryType: 'frame',
          });
        } else {
          this.message(tabId, requestId, {
            direction,
            timestamp,
            opcode: 'text',
            size: new TextEncoder().encode(payload).length,
            text: payload,
          });
        }
        return;
      }
      case 'Network.webSocketFrameError': {
        const timestamp = await this.wallTime(tabId, requestId, params.timestamp);
        this.message(tabId, requestId, {
          direction: 'none',
          timestamp,
          opcode: 'lifecycle',
          lifecycle: 'error',
          note: `Frame error: ${String(params.errorMessage ?? 'unknown')}`,
        });
        return;
      }
      case 'Network.webSocketClosed': {
        const timestamp = await this.wallTime(tabId, requestId, params.timestamp);
        await this.connection(tabId, requestId, { state: 'closed', closedAt: timestamp });
        return;
      }
      case 'Network.requestWillBeSent': {
        const request = (params.request ?? {}) as Params;
        if (params.type === 'EventSource' && settings.captureRealtime) {
          const url = String(request.url ?? '');
          await this.setMeta(tabId, requestId, {
            url,
            transport: 'eventsource',
            offset:
              typeof params.wallTime === 'number' && typeof params.timestamp === 'number'
                ? params.wallTime * 1000 - params.timestamp * 1000
                : undefined,
          });
          await this.connection(tabId, requestId, {
            url,
            createdAt: typeof params.wallTime === 'number' ? params.wallTime * 1000 : Date.now(),
          });
        }
        // Main-frame document navigations: the request id equals the loader id.
        if (params.type === 'Document' && params.requestId === params.loaderId) {
          const redirect = params.redirectResponse as Params | undefined;
          const chain = this.redirects.get(`${tabId}:${requestId}`) ?? [];
          if (redirect) chain.push({ url: String(redirect.url ?? ''), status: Number(redirect.status) });
          else chain.length = 0;
          this.redirects.set(`${tabId}:${requestId}`, chain);
        }
        return;
      }
      case 'Network.eventSourceMessageReceived': {
        if (!settings.captureRealtime) return;
        const data = String(params.data ?? '');
        this.message(tabId, requestId, {
          direction: 'in',
          timestamp: await this.wallTime(tabId, requestId, params.timestamp),
          opcode: 'text',
          size: new TextEncoder().encode(data).length,
          text: data,
          sse: {
            type: String(params.eventName || 'message'),
            lastEventId: params.eventId ? String(params.eventId) : undefined,
          },
        });
        return;
      }
      case 'Network.loadingFailed': {
        if ((await this.getMeta(tabId, requestId))?.transport !== 'eventsource') return;
        await this.connection(tabId, requestId, {
          state: 'failed',
          closedAt: await this.wallTime(tabId, requestId, params.timestamp),
          errorMessage: `Stream request failed: ${String(params.errorText ?? '')}`,
        });
        return;
      }
      case 'Network.responseReceived': {
        if (params.type !== 'Document' || params.requestId !== params.loaderId) return;
        const response = (params.response ?? {}) as Params;
        const headers = headersFrom(response.headers);
        const r = createRedactor(settings.redaction);
        const kept = redactHeaders(
          headers.filter((h) => DOCUMENT_HEADERS.includes(h.name)),
          r,
        ).headers;
        const timing = (response.timing ?? {}) as Params;
        const chain = this.redirects.get(`${tabId}:${requestId}`) ?? [];
        const data: Record<string, string | number | boolean> = {
          url: String(response.url ?? ''),
          status: Number(response.status),
          redirects: chain.length,
          fromDiskCache: response.fromDiskCache === true,
          fromServiceWorker: response.fromServiceWorker === true,
          protocol: String(response.protocol ?? ''),
        };
        if (typeof timing.sendEnd === 'number' && typeof timing.receiveHeadersEnd === 'number') {
          data.serverWaitMs = Math.max(0, Math.round(timing.receiveHeadersEnd - timing.sendEnd));
        }
        chain.forEach((hop, i) => {
          data[`redirect.${i}`] = `${hop.status} ${hop.url}`;
        });
        for (const h of kept) data[`header.${h.name}`] = h.value;
        this.queue(tabId, {
          type: 'timeline',
          event: {
            id: createId(),
            pageId: '',
            pageUrl: String(response.url ?? ''),
            kind: 'navigation',
            timestamp: Date.now(),
            message: `Document response ${data.status}${chain.length ? ` after ${chain.length} redirect(s)` : ''}`,
            detail: 'Observed by advanced capture (CDP)',
            data,
            source: 'cdp',
          },
        });
        return;
      }
    }
  }
}
