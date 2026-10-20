// Observes EventSource (server-sent events) connections from the main world.
//
// - The constructor is replaced by a Proxy (identity, statics and prototype are
//   unchanged) and the stream is observed with passive listeners; the page
//   still owns the only connection and nothing is read or cancelled.
// - Unnamed events ("message") are always observed. Named events ("event:"
//   lines) are only dispatched to listeners of that type, so they are observed
//   for exactly the types the page itself subscribes to.
// - Reconnection is automatic in EventSource: an error while readyState is
//   CONNECTING means the browser is retrying; CLOSED means it gave up.
import type { LifecycleKind, RealtimeConnectionDraft } from '../shared/types';
import { truncateText, utf8Length } from '../shared/util';
import type { RecorderContext } from './context';
import { monotonicClock } from './context';

interface Tracked {
  draft: RealtimeConnectionDraft;
  announced: boolean;
  observedTypes: Set<string>;
  everOpened: boolean;
}

export const NAMED_EVENTS_NOTE =
  'Named events are observed only for event types the page listens to; enable advanced capture to see all events';

interface EventSourceHost {
  EventSource?: typeof EventSource;
}

const CONNECTING = 0;
const CLOSED = 2;

export function installEventSourceRecorder(host: EventSourceHost, ctx: RecorderContext): () => void {
  const Original = host.EventSource;
  if (typeof Original !== 'function' || !Original.prototype) return () => undefined;
  const proto = Original.prototype;
  // addEventListener is inherited from EventTarget.prototype; the wrapper is an own
  // property of EventSource.prototype, so it only affects EventSource instances.
  const hadOwnAdd = Object.prototype.hasOwnProperty.call(proto, 'addEventListener');
  const originalAdd = proto.addEventListener;
  const originalClose = proto.close;
  const stamp = monotonicClock(ctx.now);
  const tracked = new WeakMap<EventSource, Tracked>();

  const enabled = () => {
    const cfg = ctx.config();
    return cfg.enabled && cfg.captureRealtime !== false;
  };
  const announce = (t: Tracked) => {
    t.announced = true;
    ctx.emit({ type: 'rt-connection', connection: { ...t.draft, warnings: [...t.draft.warnings] } });
  };
  const emit = (t: Tracked, message: Record<string, unknown>) => {
    if (!enabled()) return;
    if (!t.announced) {
      t.draft.warnings.push(
        'Recording started after this stream was opened; earlier events were not observed',
      );
      announce(t);
    }
    ctx.emit({
      type: 'rt-message',
      message: {
        id: ctx.newId(),
        connectionId: t.draft.id,
        timestamp: stamp(),
        source: 'main-world',
        ...message,
      } as never,
    });
  };
  const lifecycle = (t: Tracked, kind: LifecycleKind, note?: string) =>
    emit(t, { direction: 'none', opcode: 'lifecycle', lifecycle: kind, note });

  const observeType = (es: EventSource, t: Tracked, type: string) => {
    if (t.observedTypes.has(type)) return;
    t.observedTypes.add(type);
    Reflect.apply(originalAdd, es, [
      type,
      (event: Event) => {
        try {
          const e = event as MessageEvent;
          const data = typeof e.data === 'string' ? e.data : String(e.data);
          const maxBytes = ctx.config().maxFrameBytes ?? 64 * 1024;
          const size = utf8Length(data);
          const { text, truncated } = truncateText(data, maxBytes);
          emit(t, {
            direction: 'in',
            opcode: 'text',
            size,
            text,
            truncated: truncated || undefined,
            sse: { type, lastEventId: e.lastEventId || undefined },
          });
        } catch {
          /* ignore */
        }
      },
    ]);
  };

  const attach = (es: EventSource, url: string, withCredentials: boolean) => {
    const t: Tracked = {
      draft: {
        id: ctx.newId(),
        pageId: ctx.pageId,
        pageUrl: ctx.pageUrl(),
        transport: 'eventsource',
        url,
        state: 'connecting',
        createdAt: ctx.now(),
        warnings: [
          NAMED_EVENTS_NOTE,
          ...(withCredentials ? ['withCredentials: cookies are sent cross-origin'] : []),
        ],
        source: 'main-world',
      },
      announced: false,
      observedTypes: new Set(),
      everOpened: false,
    };
    tracked.set(es, t);
    if (enabled()) {
      announce(t);
      lifecycle(t, 'connecting');
    }
    Reflect.apply(originalAdd, es, [
      'open',
      () => {
        try {
          const reconnected = t.everOpened;
          t.everOpened = true;
          t.draft.state = 'open';
          t.draft.openedAt ??= ctx.now();
          if (enabled()) announce(t);
          lifecycle(t, 'open', reconnected ? 'Reconnected (EventSource retried automatically)' : undefined);
        } catch {
          /* ignore */
        }
      },
    ]);
    Reflect.apply(originalAdd, es, [
      'error',
      () => {
        try {
          if (es.readyState === CONNECTING) {
            t.draft.state = 'reconnecting';
            if (enabled()) announce(t);
            lifecycle(
              t,
              'reconnecting',
              'Stream interrupted; the browser is reconnecting (retry interval is not exposed to pages)',
            );
          } else if (es.readyState === CLOSED) {
            t.draft.state = t.everOpened ? 'closed' : 'failed';
            t.draft.closedAt = ctx.now();
            t.draft.errorMessage = t.everOpened
              ? 'Stream closed by an error; the browser will not reconnect'
              : 'Connection failed (HTTP error, wrong Content-Type, or network failure); the browser will not retry';
            if (enabled()) announce(t);
            lifecycle(t, 'error', t.draft.errorMessage);
          } else {
            lifecycle(t, 'error', 'Error event while the stream was open');
          }
        } catch {
          /* ignore */
        }
      },
    ]);
    observeType(es, t, 'message');
  };

  const Wrapped = new Proxy(Original, {
    construct(target, args: unknown[], newTarget: unknown) {
      const es = Reflect.construct(target, args, newTarget as typeof EventSource) as EventSource;
      try {
        attach(es, es.url, es.withCredentials === true);
      } catch {
        /* never break the page */
      }
      return es;
    },
  });

  const addEventListener = function (
    this: EventSource,
    ...args: Parameters<EventSource['addEventListener']>
  ) {
    const result = Reflect.apply(originalAdd, this, args) as void;
    try {
      const t = tracked.get(this);
      const type = args[0];
      if (t && typeof type === 'string' && type !== 'open' && type !== 'error') observeType(this, t, type);
    } catch {
      /* ignore */
    }
    return result;
  } as EventSource['addEventListener'];

  const close = function (this: EventSource) {
    const result = Reflect.apply(originalClose, this, []) as void;
    try {
      const t = tracked.get(this);
      if (t && t.draft.state !== 'closed' && t.draft.state !== 'failed') {
        t.draft.state = 'closed';
        t.draft.closedAt = ctx.now();
        if (enabled()) announce(t);
        lifecycle(t, 'close', 'close() called by the page');
      }
    } catch {
      /* ignore */
    }
    return result;
  };

  proto.addEventListener = addEventListener;
  proto.close = close;
  host.EventSource = Wrapped;
  return () => {
    if (host.EventSource === Wrapped) host.EventSource = Original;
    if (proto.addEventListener === addEventListener) {
      if (hadOwnAdd) proto.addEventListener = originalAdd;
      else delete (proto as { addEventListener?: unknown }).addEventListener;
    }
    if (proto.close === close) proto.close = originalClose;
  };
}
