// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installAppAdapters } from '../../src/capture/app-adapters';
import type { DevCompanionPageApi } from '../../src/capture/app-adapters';
import {
  collectDocumentDiagnostics,
  installDocumentRecorder,
  parseTraceparent,
} from '../../src/capture/document-recorder';
import { parseFetchEventStream } from '../../src/capture/fetch-stream';
import { hydrationTag } from '../../src/capture/page-events-recorder';
import type { PageMessage } from '../../src/shared/messages';
import type { TimelineDraft } from '../../src/shared/types';
import { makeContext, waitFor } from '../helpers/recorder';

const timeline = (messages: PageMessage[]) =>
  messages
    .filter((m): m is Extract<PageMessage, { type: 'timeline' }> => m.type === 'timeline')
    .map((m) => m.event as TimelineDraft);

describe('document diagnostics', () => {
  it('parses W3C traceparent values and rejects invalid or all-zero ids', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
  });

  it('collects navigation timing, server timing, trace meta and Next.js markers', () => {
    document.head.innerHTML =
      '<meta name="traceparent" content="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01">';
    const nav = {
      type: 'navigate',
      redirectCount: 1,
      transferSize: 5000,
      encodedBodySize: 4800,
      decodedBodySize: 12000,
      nextHopProtocol: 'http/1.1',
      responseStatus: 200,
      requestStart: 10,
      responseStart: 130,
      responseEnd: 140,
      domContentLoadedEventEnd: 300,
      loadEventEnd: 400,
      serverTiming: [{ name: 'render', duration: 95, description: 'SSR' }],
    };
    const host = {
      document,
      performance: { getEntriesByType: () => [nav], getEntriesByName: () => [] } as unknown as Performance,
      addEventListener: () => undefined,
      setTimeout,
      __NEXT_DATA__: { buildId: 'b1', page: '/orders/[id]', gssp: true },
    };
    expect(collectDocumentDiagnostics(host)).toMatchObject({
      navigationType: 'navigate',
      redirectCount: 1,
      status: 200,
      serverWaitMs: 120,
      'server-timing.render': '95ms SSR',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      'next.router': 'pages',
      'next.rendering': 'getServerSideProps (rendered per request)',
    });
  });

  it('emits one navigation event, after load or immediately for late injection', () => {
    const { ctx, messages } = makeContext();
    const host = {
      document: { readyState: 'complete', querySelector: () => null } as unknown as Document,
      performance: { getEntriesByType: () => [], getEntriesByName: () => [] } as unknown as Performance,
      addEventListener: vi.fn(),
      setTimeout,
    };
    installDocumentRecorder(host, ctx);
    const events = timeline(messages);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'navigation',
      detail: expect.stringContaining('after the page loaded'),
    });
  });

  it('tags hydration-like errors as a pattern match only', () => {
    expect(
      hydrationTag("Error: Hydration failed because the server rendered HTML didn't match"),
    ).toMatchObject({
      data: { hydrationPattern: true },
      detail: expect.stringContaining('not confirmed'),
    });
    expect(hydrationTag('TypeError: x is undefined')).toEqual({});
  });
});

describe('opt-in app adapters', () => {
  const setup = (appAdapters: boolean) => {
    const rec = makeContext({ appAdapters, notificationSelectors: ['[role="status"]'] });
    const host = { document, MutationObserver } as unknown as Record<string, unknown>;
    installAppAdapters(host as never, rec.ctx);
    return { ...rec, api: host.__devCompanion as DevCompanionPageApi | undefined };
  };

  it('does not expose any page API unless enabled for the origin', () => {
    expect(setup(false).api).toBeUndefined();
  });

  it('records stages reported by the page, labeled as adapter events', () => {
    const { api, messages } = setup(true);
    api!.signal('handler-ran', { handler: 'onOrder', orderId: 'o-1', nested: { ignored: true } });
    expect(timeline(messages)[0]).toMatchObject({
      kind: 'app-signal',
      message: 'handler-ran',
      source: 'adapter',
      data: { handler: 'onOrder', orderId: 'o-1' },
    });
  });

  it('attaches to Socket.IO and SignalR through their public listener APIs only', () => {
    const { api, messages } = setup(true);
    let any: ((e: string, ...a: unknown[]) => void) | undefined;
    const socket = { nsp: '/', onAny: (fn: typeof any) => (any = fn), io: { on: vi.fn() } };
    expect(api!.attachSocketIO(socket)).toBe(true);
    any!('order.created', { id: 1 });
    let closed: ((e?: Error) => void) | undefined;
    const hub = {
      onclose: (fn: typeof closed) => (closed = fn),
      onreconnecting: vi.fn(),
      onreconnected: vi.fn(),
    };
    expect(api!.attachSignalR(hub)).toBe(true);
    closed!(new Error('server gone'));
    expect(timeline(messages).map((e) => [e.message, e.data])).toEqual([
      ['socket.io:dispatched', { event: 'order.created', namespace: '/', args: 1 }],
      ['signalr:closed', { error: 'server gone' }],
    ]);
    expect(api!.attachSocketIO({})).toBe(false);
  });

  it('records text that appears in configured notification regions once', async () => {
    const { messages } = setup(true);
    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.textContent = 'Order o-5 created';
    document.body.appendChild(toast);
    await waitFor(() => timeline(messages).some((e) => e.kind === 'ui-notification'));
    toast.appendChild(document.createElement('span'));
    await new Promise((r) => setTimeout(r, 20));
    const notes = timeline(messages).filter((e) => e.kind === 'ui-notification');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ message: 'Order o-5 created', data: { region: 'status' } });
    toast.remove();
  });
});

describe('fetch event-stream parsing (opt-in)', () => {
  it('parses events from a clone while the page reads the full stream itself', async () => {
    const { ctx, messages } = makeContext({ captureFetchStreams: true });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('event: order.created\nid: 1\ndata: {"id":1}\n\n'));
        c.enqueue(encoder.encode('data: plain\n\n'));
        c.close();
      },
    });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    parseFetchEventStream(response, 'https://app.test/stream', ctx);
    expect(await response.text()).toContain('data: plain');
    await waitFor(() => messages.some((m) => m.type === 'rt-connection' && m.connection.state === 'closed'));
    const frames = messages
      .filter((m) => m.type === 'rt-message')
      .map((m) => (m.type === 'rt-message' ? m.message : null));
    expect(frames.map((f) => [f!.sse?.type, f!.text])).toEqual([
      ['order.created', '{"id":1}'],
      ['message', 'plain'],
    ]);
  });
});
