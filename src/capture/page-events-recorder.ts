// Records console errors/warnings, uncaught errors, unhandled rejections, route
// changes and selected interactions. Never records form field values.
import type { TimelineDraft, TimelineKind } from '../shared/types';
import { clip } from '../shared/util';
import type { RecorderContext } from './context';

const MAX_MESSAGE = 2000;

/** Safe, bounded string rendering of arbitrary console arguments. */
export function describeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof Element !== 'undefined' && value instanceof Element) {
    const id = value.id ? `#${value.id}` : '';
    return `<${value.tagName.toLowerCase()}${id}>`;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= 3) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .slice(0, 20)
        .map((v) => describeValue(v, depth + 1, seen))
        .join(', ')}${value.length > 20 ? ', …' : ''}]`;
    }
    const entries = Object.keys(value)
      .slice(0, 20)
      .map((k) => `${k}: ${describeValue((value as Record<string, unknown>)[k], depth + 1, seen)}`);
    return `{${entries.join(', ')}}`;
  } catch {
    return '[unserializable]';
  }
}

// Wording used by React/Next.js hydration errors. A match is a hint, not a diagnosis.
const HYDRATION =
  /hydrat|did not match|text content does not match|server rendered html|minified react error #(418|423|425)/i;

export function hydrationTag(message: string): Partial<TimelineDraft> {
  return HYDRATION.test(message)
    ? {
        detail: 'Message matches known hydration-error wording (pattern match, not confirmed)',
        data: { hydrationPattern: true },
      }
    : {};
}

interface PageEventHost {
  console: Console;
  addEventListener: Window['addEventListener'];
  history?: History;
  location: { href: string };
  document?: Document;
}

export interface PageEventsOptions {
  /** False when injected into an already-loaded page: console is then left untouched. */
  wrapConsole: boolean;
}

export function installPageEventsRecorder(
  host: PageEventHost,
  ctx: RecorderContext,
  options: PageEventsOptions = { wrapConsole: true },
): () => void {
  const cleanups: (() => void)[] = [];
  let reentrant = false;

  const emit = (kind: TimelineKind, message: string, extra: Partial<TimelineDraft> = {}) => {
    if (!ctx.config().enabled || reentrant) return;
    reentrant = true;
    try {
      ctx.emit({
        type: 'timeline',
        event: {
          id: ctx.newId(),
          pageId: ctx.pageId,
          pageUrl: ctx.pageUrl(),
          kind,
          timestamp: ctx.now(),
          message: clip(message, MAX_MESSAGE),
          ...extra,
        },
      });
    } catch {
      /* ignore */
    } finally {
      reentrant = false;
    }
  };

  // Console errors and warnings. Wrapping console adds a frame to call stacks,
  // and tools that capture stacks in their own console patch blame whichever
  // wrapper is outermost. So the wrapper is only installed at document_start
  // (beneath any framework patches), never into an already-running page, and is
  // removed when recording or console capture is turned off.
  const consoleWrappers = (
    [
      ['error', 'console-error'],
      ['warn', 'console-warn'],
    ] as const
  ).map(([method, kind]) => {
    let original: Console['error'] | undefined;
    let wrapped: Console['error'] | undefined;
    const install = () => {
      if (wrapped && host.console[method] === wrapped) return;
      const current = host.console[method];
      if (typeof current !== 'function') return;
      original = current;
      const target = current;
      wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          if (ctx.config().captureConsole) {
            const err = args.find((a): a is Error => a instanceof Error);
            const text = args.map((a) => describeValue(a)).join(' ');
            emit(kind, text, {
              stack: err?.stack ? clip(err.stack, 4000) : undefined,
              ...hydrationTag(text),
            });
          }
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, this, args) as void;
      };
      host.console[method] = wrapped;
    };
    // Restores the original only if nothing has wrapped console on top of us;
    // otherwise our wrapper stays in the chain but no longer records.
    const uninstall = () => {
      if (wrapped && original && host.console[method] === wrapped) {
        host.console[method] = original;
        wrapped = undefined;
      }
    };
    return { install, uninstall };
  });
  const syncConsole = () => {
    const cfg = ctx.config();
    for (const w of consoleWrappers) {
      if (options.wrapConsole && cfg.enabled && cfg.captureConsole) w.install();
      else w.uninstall();
    }
  };
  syncConsole();
  ctx.onConfig?.(syncConsole);
  cleanups.push(() => consoleWrappers.forEach((w) => w.uninstall()));

  // Uncaught errors (bubble phase only: resource load errors do not bubble).
  const onError = (event: Event) => {
    const e = event as ErrorEvent;
    if (typeof e.message !== 'string') return;
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    emit('js-error', `${e.message}${where}`, {
      stack: e.error instanceof Error && e.error.stack ? clip(e.error.stack, 4000) : undefined,
      ...hydrationTag(e.message),
    });
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    emit('unhandled-rejection', `Unhandled promise rejection: ${describeValue(reason)}`, {
      stack: reason instanceof Error && reason.stack ? clip(reason.stack, 4000) : undefined,
    });
  };
  host.addEventListener('error', onError);
  host.addEventListener('unhandledrejection', onRejection);

  // Route changes: History API and hash/popstate navigation.
  let lastUrl = host.location.href;
  const checkRoute = (via: string) => {
    const current = host.location.href;
    if (current === lastUrl) return;
    const from = lastUrl;
    lastUrl = current;
    emit('route-change', `Route changed via ${via}`, { detail: `${from} → ${current}` });
  };
  const history = host.history;
  if (history) {
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      const wrapped = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = Reflect.apply(original, this, args) as void;
        try {
          checkRoute(`history.${method}`);
        } catch {
          /* ignore */
        }
        return result;
      };
      history[method] = wrapped;
      cleanups.push(() => {
        if (history[method] === wrapped) history[method] = original;
      });
    }
  }
  const onPopState = () => checkRoute('popstate');
  const onHashChange = () => checkRoute('hashchange');
  host.addEventListener('popstate', onPopState);
  host.addEventListener('hashchange', onHashChange);

  // Form submissions and clicks: structure only, never values.
  const doc = host.document;
  const onSubmit = (event: Event) => {
    if (!ctx.config().captureInteractions) return;
    const form = event.target as HTMLFormElement | null;
    if (!form || typeof form.getAttribute !== 'function') return;
    const name = form.id
      ? `#${form.id}`
      : form.getAttribute('name')
        ? `[name=${form.getAttribute('name')}]`
        : '';
    const method = (form.getAttribute('method') ?? 'get').toUpperCase();
    const action = form.getAttribute('action') ?? '';
    const fields = form.elements?.length ?? 0;
    emit('form-submit', `Form${name} submitted (${method} ${action || '(same URL)'})`, {
      detail: `${fields} field(s); values are not recorded`,
    });
  };
  const onClick = (event: Event) => {
    if (!ctx.config().captureInteractions) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    const el = target.closest(
      'button, a, [role="button"], input[type="submit"], input[type="button"], summary',
    );
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    const label =
      el.getAttribute('aria-label') ??
      (tag === 'input' ? (el as HTMLInputElement).value : el.textContent)?.trim().replace(/\s+/g, ' ') ??
      '';
    const id = el.id ? `#${el.id}` : '';
    emit('click', `Clicked <${tag}${id}> "${clip(label, 60)}"`);
  };
  if (doc) {
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('click', onClick, { capture: true, passive: true });
  }

  return () => {
    cleanups.forEach((fn) => fn());
    const remove = (host as unknown as Window).removeEventListener?.bind(host);
    remove?.('error', onError);
    remove?.('unhandledrejection', onRejection);
    remove?.('popstate', onPopState);
    remove?.('hashchange', onHashChange);
    doc?.removeEventListener('submit', onSubmit, true);
    doc?.removeEventListener('click', onClick, true);
  };
}
