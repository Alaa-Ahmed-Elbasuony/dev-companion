import { describe, expect, it, vi } from 'vitest';
import { createPageChannel } from '../../src/capture/channel';
import { INSTALL_MARKER, installRecorder } from '../../src/capture/main-world';
import { installPageEventsRecorder } from '../../src/capture/page-events-recorder';
import { BRIDGE_TO_PAGE_EVENT, PAGE_TO_BRIDGE_EVENT } from '../../src/shared/messages';
import { DEFAULT_CAPTURE_CONFIG } from '../../src/shared/settings';
import { FakeXHR } from '../helpers/fake-xhr';
import { makeContext } from '../helpers/recorder';

function fakeWindow() {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.document = new EventTarget();
  win.location = { href: 'https://app.test/' };
  win.fetch = vi.fn(async () => new Response('{}'));
  win.XMLHttpRequest = class extends FakeXHR {};
  win.navigator = { sendBeacon: vi.fn(() => true) };
  win.console = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  win.history = { pushState: vi.fn(), replaceState: vi.fn() };
  return win as unknown as Window & typeof globalThis;
}

const sendConfig = (target: EventTarget, enabled = true) =>
  target.dispatchEvent(
    new CustomEvent(BRIDGE_TO_PAGE_EVENT, {
      detail: JSON.stringify({ type: 'config', config: { ...DEFAULT_CAPTURE_CONFIG, enabled } }),
    }),
  );

describe('main-world installation', () => {
  it('installs only once per document (duplicate instrumentation guard)', () => {
    const win = fakeWindow();
    expect(installRecorder(win)).toBe(true);
    const wrappedFetch = win.fetch;
    const wrappedOpen = win.XMLHttpRequest.prototype.open;
    expect(installRecorder(win)).toBe(false);
    expect(win.fetch).toBe(wrappedFetch);
    expect(win.XMLHttpRequest.prototype.open).toBe(wrappedOpen);
    expect(Object.keys(win)).not.toContain(INSTALL_MARKER.toString());
  });
});

describe('page channel', () => {
  it('sends a ping, queues events until configured, then flushes them in order', () => {
    const doc = new EventTarget();
    const received: unknown[] = [];
    doc.addEventListener(PAGE_TO_BRIDGE_EVENT, (e) =>
      received.push(JSON.parse((e as CustomEvent<string>).detail)),
    );
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    expect(received).toEqual([{ type: 'ping' }]);
    channel.emit({ type: 'hello', pageId: 'p', url: 'u', at: 1 });
    channel.emit({
      type: 'timeline',
      event: { id: '1', pageId: 'p', pageUrl: 'u', kind: 'click', timestamp: 1, message: 'm' },
    });
    expect(received).toHaveLength(1);
    sendConfig(doc, true);
    expect(received.map((m) => (m as { type: string }).type)).toEqual(['ping', 'hello', 'timeline']);
    expect(channel.isConnected()).toBe(true);
  });

  it('drops queued events when recording is disabled', () => {
    const doc = new EventTarget();
    const received: unknown[] = [];
    doc.addEventListener(PAGE_TO_BRIDGE_EVENT, (e) => received.push(e));
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    channel.emit({ type: 'hello', pageId: 'p', url: 'u', at: 1 });
    sendConfig(doc, false);
    channel.emit({ type: 'hello', pageId: 'p', url: 'u', at: 2 });
    expect(received).toHaveLength(1); // only the ping
    expect(channel.config().enabled).toBe(false);
  });

  it('ignores malformed control messages', () => {
    const doc = new EventTarget();
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    doc.dispatchEvent(new CustomEvent(BRIDGE_TO_PAGE_EVENT, { detail: '{not json' }));
    doc.dispatchEvent(new CustomEvent(BRIDGE_TO_PAGE_EVENT, { detail: { type: 'config' } }));
    expect(channel.isConnected()).toBe(false);
  });
});

describe('page events recorder', () => {
  function setup() {
    const win = fakeWindow();
    const t = makeContext();
    const originalError = win.console.error;
    installPageEventsRecorder(win, t.ctx);
    const events = () =>
      t.messages
        .filter((m) => m.type === 'timeline')
        .map((m) => (m as { event: { kind: string; message: string; detail?: string } }).event);
    return { win, t, originalError, events };
  }

  it('records console errors and still calls the original console method', () => {
    const { win, originalError, events } = setup();
    win.console.error('Order failed', { code: 'OUT_OF_STOCK' }, new Error('boom'));
    expect(originalError).toHaveBeenCalledWith('Order failed', { code: 'OUT_OF_STOCK' }, expect.any(Error));
    expect(events()[0]).toMatchObject({ kind: 'console-error' });
    expect(events()[0]!.message).toContain('OUT_OF_STOCK');
    expect(events()[0]!.message).toContain('Error: boom');
  });

  it('leaves console untouched when injected into an already-loaded page', () => {
    const win = fakeWindow();
    const original = win.console.error;
    installPageEventsRecorder(win, makeContext().ctx, { wrapConsole: false });
    expect(win.console.error).toBe(original);
  });

  it('removes the console wrapper when console capture or recording is turned off, and restores it when on', () => {
    const win = fakeWindow();
    const original = win.console.error;
    const listeners: ((c: unknown) => void)[] = [];
    const t = makeContext();
    t.ctx.onConfig = (fn) => listeners.push(fn as (c: unknown) => void);
    installPageEventsRecorder(win, t.ctx);
    expect(win.console.error).not.toBe(original);

    t.setConfig({ captureConsole: false });
    listeners.forEach((fn) => fn(t.ctx.config()));
    expect(win.console.error).toBe(original);

    t.setConfig({ captureConsole: true, enabled: false });
    listeners.forEach((fn) => fn(t.ctx.config()));
    expect(win.console.error).toBe(original);

    t.setConfig({ enabled: true });
    listeners.forEach((fn) => fn(t.ctx.config()));
    expect(win.console.error).not.toBe(original);
  });

  it('stays beneath a framework console patch and stops recording when turned off', () => {
    const win = fakeWindow();
    const original = win.console.error;
    const listeners: ((c: unknown) => void)[] = [];
    const t = makeContext();
    t.ctx.onConfig = (fn) => listeners.push(fn as (c: unknown) => void);
    installPageEventsRecorder(win, t.ctx);
    const ours = win.console.error;
    const framework = vi.fn((...args: unknown[]) => ours(...args));
    win.console.error = framework;

    t.setConfig({ captureConsole: false });
    listeners.forEach((fn) => fn(t.ctx.config()));
    expect(win.console.error).toBe(framework); // the framework patch is not clobbered
    win.console.error('still logged');
    expect(original).toHaveBeenCalledWith('still logged');
    expect(t.messages.filter((m) => m.type === 'timeline')).toHaveLength(0);
  });

  it('records uncaught errors and unhandled rejections without preventing default handling', () => {
    const { win, events } = setup();
    const errorEvent = Object.assign(new Event('error', { cancelable: true }), {
      message: 'x is undefined',
      filename: 'app.js',
      lineno: 3,
      colno: 7,
    });
    win.dispatchEvent(errorEvent);
    const rejection = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: new Error('nope'),
    });
    win.dispatchEvent(rejection);
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(events().map((e) => e.kind)).toEqual(['js-error', 'unhandled-rejection']);
    expect(events()[0]!.message).toContain('app.js:3:7');
  });

  it('records history route changes', () => {
    const { win, events } = setup();
    const push = win.history.pushState;
    (win.location as { href: string }).href = 'https://app.test/orders';
    push.call(win.history, {}, '', '/orders');
    expect(events()[0]).toMatchObject({ kind: 'route-change' });
    expect(events()[0]!.detail).toBe('https://app.test/ → https://app.test/orders');
  });

  it('records clicks and form submissions without field values', () => {
    const { win, events } = setup();
    const button = {
      tagName: 'BUTTON',
      id: 'create-order',
      textContent: '  Create   order ',
      getAttribute: () => null,
      closest: () => button,
    };
    const click = new Event('click');
    Object.defineProperty(click, 'target', { value: button });
    (win.document as unknown as EventTarget).dispatchEvent(click);

    const form = {
      id: 'checkout',
      elements: { length: 3 },
      getAttribute: (n: string) => (n === 'method' ? 'post' : n === 'action' ? '/api/orders' : null),
      password: 'hunter2',
    };
    const submit = new Event('submit');
    Object.defineProperty(submit, 'target', { value: form });
    (win.document as unknown as EventTarget).dispatchEvent(submit);

    expect(events()[0]!.message).toBe('Clicked <button#create-order> "Create order"');
    expect(events()[1]!.message).toBe('Form#checkout submitted (POST /api/orders)');
    expect(JSON.stringify(events())).not.toContain('hunter2');
  });
});
