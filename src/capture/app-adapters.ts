// Opt-in application adapters (Settings → Integrations → "Page API and
// notification observer" for an origin). Nothing here runs unless enabled.
//
// - window.__devCompanion: a small API the application can call to report
//   stages the extension cannot observe on its own, e.g. "handler-ran" or
//   "toast-shown". These events are labeled "reported by the page".
// - attachSocketIO(socket) / attachSignalR(connection): register additional
//   listeners through the libraries' public APIs (onAny / onreconnecting...).
//   Application listeners are never wrapped or reordered.
// - A MutationObserver records text that appears in configured notification
//   regions ([role=alert], [role=status], aria-live by default).
import type { CaptureConfig } from '../shared/types';
import { clip } from '../shared/util';
import type { RecorderContext } from './context';

type Detail = Record<string, string | number | boolean>;

export interface DevCompanionPageApi {
  readonly version: 1;
  signal(stage: string, detail?: Record<string, unknown>): void;
  attachSocketIO(socket: unknown): boolean;
  attachSignalR(connection: unknown): boolean;
}

function flat(detail: unknown): Detail | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const out: Detail = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (n++ >= 20) break;
    if (typeof v === 'string') out[clip(k, 60)] = clip(v, 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[clip(k, 60)] = v;
  }
  return n ? out : undefined;
}

interface AdapterHost {
  document?: Document;
  MutationObserver?: typeof MutationObserver;
}

export function installAppAdapters(host: AdapterHost, ctx: RecorderContext): () => void {
  const active = () => {
    const cfg = ctx.config();
    return cfg.enabled && cfg.appAdapters === true;
  };
  const emit = (kind: 'app-signal' | 'ui-notification', message: string, data?: Detail) => {
    if (!active()) return;
    try {
      ctx.emit({
        type: 'timeline',
        event: {
          id: ctx.newId(),
          pageId: ctx.pageId,
          pageUrl: ctx.pageUrl(),
          kind,
          timestamp: ctx.now(),
          message: clip(message, 300),
          data,
          source: 'adapter',
        },
      });
    } catch {
      /* ignore */
    }
  };

  const api: DevCompanionPageApi = Object.freeze({
    version: 1 as const,
    signal(stage: string, detail?: Record<string, unknown>) {
      if (typeof stage !== 'string' || !stage) return;
      emit('app-signal', stage, flat(detail));
    },
    attachSocketIO(socket: unknown) {
      const s = socket as {
        onAny?: (fn: (event: string, ...args: unknown[]) => void) => void;
        onAnyOutgoing?: (fn: (event: string, ...args: unknown[]) => void) => void;
        nsp?: string;
        io?: { on?: (event: string, fn: (arg?: unknown) => void) => void };
      };
      if (!s || typeof s.onAny !== 'function') return false;
      const nsp = typeof s.nsp === 'string' ? s.nsp : '/';
      // onAny listeners run when the client dispatches an event to the application's listeners.
      s.onAny((event, ...args) =>
        emit('app-signal', 'socket.io:dispatched', {
          event: String(event),
          namespace: nsp,
          args: args.length,
        }),
      );
      s.onAnyOutgoing?.((event, ...args) =>
        emit('app-signal', 'socket.io:emitted', { event: String(event), namespace: nsp, args: args.length }),
      );
      for (const ev of ['reconnect_attempt', 'reconnect', 'reconnect_error', 'reconnect_failed']) {
        s.io?.on?.(ev, (arg) =>
          emit('app-signal', `socket.io:${ev}`, {
            namespace: nsp,
            ...(typeof arg === 'number' ? { attempt: arg } : {}),
            ...(arg instanceof Error ? { error: arg.message } : {}),
          }),
        );
      }
      return true;
    },
    attachSignalR(connection: unknown) {
      const c = connection as {
        onreconnecting?: (fn: (err?: Error) => void) => void;
        onreconnected?: (fn: (id?: string) => void) => void;
        onclose?: (fn: (err?: Error) => void) => void;
      };
      if (!c || typeof c.onclose !== 'function') return false;
      c.onreconnecting?.((err) =>
        emit('app-signal', 'signalr:reconnecting', err ? { error: err.message } : undefined),
      );
      c.onreconnected?.(() => emit('app-signal', 'signalr:reconnected'));
      c.onclose((err) => emit('app-signal', 'signalr:closed', err ? { error: err.message } : undefined));
      return true;
    },
  });

  let defined = false;
  const define = () => {
    if (defined) return;
    defined = true;
    try {
      Object.defineProperty(host, '__devCompanion', { value: api, enumerable: false, configurable: true });
    } catch {
      /* ignore */
    }
  };

  // Notification regions.
  let observer: MutationObserver | undefined;
  const seen = new WeakMap<Element, string>();
  const observe = (cfg: CaptureConfig) => {
    const selectors = (cfg.notificationSelectors ?? []).filter(Boolean).join(',');
    if (!selectors || !host.document || typeof host.MutationObserver !== 'function') return;
    const check = (el: Element | null) => {
      if (!el || typeof el.closest !== 'function') return;
      let region: Element | null;
      try {
        region = el.closest(selectors);
      } catch {
        return; // invalid selector from settings
      }
      if (!region) return;
      const text = (region.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (!text || seen.get(region) === text) return;
      seen.set(region, text);
      const role =
        region.getAttribute('role') ?? region.getAttribute('aria-live') ?? region.tagName.toLowerCase();
      emit('ui-notification', clip(text, 300), { region: role });
    };
    observer = new host.MutationObserver((records) => {
      if (!active()) return;
      for (const r of records) {
        if (r.type === 'characterData') check(r.target.parentElement);
        else r.addedNodes.forEach((n) => check(n.nodeType === 1 ? (n as Element) : n.parentElement));
      }
    });
    observer.observe(host.document.documentElement ?? host.document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  const sync = (cfg: CaptureConfig) => {
    if (cfg.enabled && cfg.appAdapters) {
      define();
      if (!observer) observe(cfg);
    } else if (observer) {
      observer.disconnect();
      observer = undefined;
    }
  };
  sync(ctx.config());
  ctx.onConfig?.(sync);
  return () => observer?.disconnect();
}
