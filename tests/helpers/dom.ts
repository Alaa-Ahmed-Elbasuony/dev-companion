// jsdom gaps for UI component tests: ResizeObserver and the chrome.* surface the
// dashboard hooks subscribe to (no worker, no storage events).
import { vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

export function installDomStubs() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const listeners = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: listeners(),
      sendMessage: vi.fn(async () => undefined),
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    storage: {
      onChanged: listeners(),
      local: { get: vi.fn(async () => ({ settings: DEFAULT_SETTINGS })), set: vi.fn() },
    },
  };
}

/** Sets the scroll position of a (virtualized) scroll container and fires scroll. */
export function scrollTo(el: Element, top: number) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
}
