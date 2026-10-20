// Observes WebSocket connections and frames from the page's main world.
//
// - The constructor is replaced by a Proxy whose construct trap calls
//   Reflect.construct, so `instanceof`, statics (OPEN, CLOSED...), the
//   prototype and subclassing behave exactly as before.
// - Incoming frames and lifecycle events are observed with passive listeners;
//   the page's own listeners and handlers run unchanged and in the same order.
// - send() and close() are wrapped on the prototype: the original always runs
//   first with the same arguments, and any error it throws is rethrown as-is.
// - Binary payloads are never read; only their type and size are recorded.
import type {
  LifecycleKind,
  MessageDirection,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
} from '../shared/types';
import { truncateText, utf8Length } from '../shared/util';
import type { RecorderContext } from './context';
import { monotonicClock } from './context';

interface Tracked {
  draft: RealtimeConnectionDraft;
  /** The connection record has been sent at least once while recording was enabled. */
  announced: boolean;
}

export const LATE_SOCKET_WARNING =
  'Connection was opened before the recorder was installed; frames before this point were not observed';
export const RECORDING_STARTED_LATE_WARNING =
  'Recording started after this connection was opened; earlier frames were not observed';

type SocketClass = typeof WebSocket;

interface WebSocketHost {
  WebSocket?: SocketClass;
}

export function binaryInfo(data: unknown): { size?: number; binaryType: string } | null {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return { size: data.size, binaryType: 'blob' };
  if (data instanceof ArrayBuffer) return { size: data.byteLength, binaryType: 'arraybuffer' };
  if (ArrayBuffer.isView(data)) return { size: data.byteLength, binaryType: 'typedarray' };
  return null;
}

export function installWebSocketRecorder(host: WebSocketHost, ctx: RecorderContext): () => void {
  const Original = host.WebSocket;
  if (typeof Original !== 'function' || !Original.prototype) return () => undefined;
  const proto = Original.prototype;
  const originalSend = proto.send;
  const originalClose = proto.close;
  const stamp = monotonicClock(ctx.now);
  const tracked = new WeakMap<WebSocket, Tracked>();

  const enabled = () => {
    const cfg = ctx.config();
    return cfg.enabled && cfg.captureRealtime !== false;
  };

  const announce = (t: Tracked) => {
    t.announced = true;
    ctx.emit({ type: 'rt-connection', connection: { ...t.draft, warnings: [...t.draft.warnings] } });
  };

  const emitMessage = (t: Tracked, message: Omit<RealtimeMessageDraft, 'id' | 'connectionId' | 'source'>) => {
    if (!enabled()) return;
    if (!t.announced) {
      if (!t.draft.warnings.includes(LATE_SOCKET_WARNING))
        t.draft.warnings.push(RECORDING_STARTED_LATE_WARNING);
      announce(t);
    }
    ctx.emit({
      type: 'rt-message',
      message: { ...message, id: ctx.newId(), connectionId: t.draft.id, source: 'main-world' },
    });
  };

  const frame = (t: Tracked, direction: MessageDirection, data: unknown, note?: string) => {
    const timestamp = stamp();
    if (typeof data === 'string') {
      const maxBytes = ctx.config().maxFrameBytes ?? 64 * 1024;
      const size = utf8Length(data);
      const { text, truncated } =
        size > maxBytes ? truncateText(data, maxBytes) : { text: data, truncated: false };
      emitMessage(t, {
        direction,
        timestamp,
        opcode: 'text',
        size,
        text,
        truncated: truncated || undefined,
        note,
      });
      return;
    }
    const bin = binaryInfo(data);
    emitMessage(t, {
      direction,
      timestamp,
      opcode: 'binary',
      size: bin?.size,
      binaryType: bin?.binaryType ?? typeof data,
      note,
    });
  };

  const lifecycle = (t: Tracked, kind: LifecycleKind, note?: string) => {
    emitMessage(t, { direction: 'none', timestamp: stamp(), opcode: 'lifecycle', lifecycle: kind, note });
  };

  const updateState = (t: Tracked) => {
    if (enabled()) announce(t);
  };

  const attach = (ws: WebSocket, url: string, protocols: string[] | undefined, late: boolean): Tracked => {
    const t: Tracked = {
      draft: {
        id: ctx.newId(),
        pageId: ctx.pageId,
        pageUrl: ctx.pageUrl(),
        transport: 'websocket',
        url,
        requestedProtocols: protocols?.length ? protocols : undefined,
        state: late && ws.readyState === 1 ? 'open' : 'connecting',
        createdAt: ctx.now(),
        warnings: late ? [LATE_SOCKET_WARNING] : [],
        source: 'main-world',
      },
      announced: false,
    };
    tracked.set(ws, t);
    if (enabled()) {
      announce(t);
      if (!late) lifecycle(t, 'connecting');
    }

    const onOpen = () => {
      try {
        t.draft.state = 'open';
        t.draft.openedAt = ctx.now();
        t.draft.selectedProtocol = ws.protocol || undefined;
        updateState(t);
        lifecycle(t, 'open', ws.protocol ? `Sub-protocol: ${ws.protocol}` : undefined);
      } catch {
        /* never break the page */
      }
    };
    const onMessage = (event: Event) => {
      try {
        frame(t, 'in', (event as MessageEvent).data);
      } catch {
        /* ignore */
      }
    };
    const onError = () => {
      try {
        // The WebSocket API exposes no error detail; the close event that follows carries the code.
        lifecycle(t, 'error', 'WebSocket error event (the browser exposes no further detail to pages)');
      } catch {
        /* ignore */
      }
    };
    const onClose = (event: Event) => {
      try {
        const e = event as CloseEvent;
        const neverOpened = t.draft.openedAt === undefined && t.draft.state === 'connecting';
        t.draft.state = neverOpened ? 'failed' : 'closed';
        t.draft.closedAt = ctx.now();
        t.draft.closeCode = e.code;
        t.draft.closeReason = e.reason || undefined;
        t.draft.wasClean = e.wasClean;
        if (neverOpened) t.draft.errorMessage = 'Connection failed before it opened';
        updateState(t);
        lifecycle(
          t,
          'close',
          `Closed with code ${e.code}${e.reason ? ` (${e.reason})` : ''}${e.wasClean ? '' : ', not clean'}`,
        );
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
    return t;
  };

  const resolveUrl = (raw: unknown): string => {
    const s = String(raw);
    try {
      const u = new URL(s, ctx.pageUrl());
      // Relative http(s) URLs are resolved by the browser to ws(s).
      if (u.protocol === 'http:') u.protocol = 'ws:';
      if (u.protocol === 'https:') u.protocol = 'wss:';
      return u.href;
    } catch {
      return s;
    }
  };

  const Wrapped = new Proxy(Original, {
    construct(target, args: unknown[], newTarget: unknown) {
      const ws = Reflect.construct(target, args, newTarget as SocketClass) as WebSocket;
      try {
        const protocols = args[1];
        const list =
          typeof protocols === 'string'
            ? [protocols]
            : Array.isArray(protocols)
              ? protocols.map(String)
              : undefined;
        attach(ws, ws.url || resolveUrl(args[0]), list, false);
      } catch {
        /* never break the page */
      }
      return ws;
    },
  });

  // Sockets created before installation become visible on their first send()/close().
  const trackedOrLate = (ws: WebSocket): Tracked | undefined => {
    const existing = tracked.get(ws);
    if (existing) return existing;
    if (!enabled()) return undefined;
    return attach(ws, ws.url, ws.protocol ? [ws.protocol] : undefined, true);
  };

  const send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    // Same receiver, same argument, same exceptions: capture happens only after it returns.
    const result = Reflect.apply(originalSend, this, [data]) as void;
    try {
      const t = trackedOrLate(this);
      if (t) {
        const note =
          this.readyState === 1 ? undefined : 'Sent while the socket was not open: the browser discarded it';
        frame(t, 'out', data, note);
      }
    } catch {
      /* ignore */
    }
    return result;
  };

  const close = function (this: WebSocket, ...args: [number?, string?]) {
    const result = Reflect.apply(originalClose, this, args) as void;
    try {
      const t = trackedOrLate(this);
      if (t) {
        const [code, reason] = args;
        lifecycle(
          t,
          'close',
          `close() called by the page${code !== undefined ? ` with code ${code}` : ''}${reason ? ` (${reason})` : ''}`,
        );
      }
    } catch {
      /* ignore */
    }
    return result;
  };

  proto.send = send;
  proto.close = close;
  host.WebSocket = Wrapped;

  return () => {
    if (host.WebSocket === Wrapped) host.WebSocket = Original;
    if (proto.send === send) proto.send = originalSend;
    if (proto.close === close) proto.close = originalClose;
  };
}
