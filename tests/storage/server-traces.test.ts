import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKENS_KEY, TraceSync, getTraceStatus } from '../../src/background/server-traces';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { RecordingState, Settings } from '../../src/shared/types';
import { EntryStore } from '../../src/storage/database';
import { installFakeChrome } from '../helpers/fake-chrome';

const TRACE = 'a'.repeat(32);
let store: EntryStore;
let recordings: RecordingState[];
let responses: (() => Response | Promise<Response>)[];
let sync: TraceSync;
let n = 0;
const settings: Settings = {
  ...DEFAULT_SETTINGS,
  serverIntegrations: [
    { id: 'next', appOrigin: 'http://localhost:3100', collectorUrl: 'http://127.0.0.1:4319', enabled: true },
  ],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rawSpan = (i: number, o: Record<string, unknown> = {}) => ({
  traceId: TRACE,
  spanId: i.toString(16).padStart(16, '0'),
  name: `fetch GET http://127.0.0.1:3101/inventory?token=leak-${i}`,
  kind: 'client',
  startTime: 5000 + i,
  endTime: 5100 + i,
  status: 'unset',
  outbound: true,
  httpStatus: 503,
  httpUrl: 'http://127.0.0.1:3101/inventory?token=leak',
  attributes: {
    'http.request.header.authorization': 'Bearer abcdefghijklmnop',
    'next.span_type': 'AppRender.fetch',
  },
  body: { response: { text: '{"error":"down","sessionToken":"tok-abc"}', size: 40 } },
  ...o,
});

beforeEach(async () => {
  const chromeFake = installFakeChrome();
  chromeFake.local.set(TOKENS_KEY, { next: 't'.repeat(48) });
  store = await EntryStore.open(`traces-${++n}`);
  recordings = [{ sessionId: 's-1', tabId: 1, origin: 'http://localhost:3100', startedAt: 4000 }];
  responses = [];
  sync = new TraceSync({
    store,
    settings: async () => settings,
    recordings: async () => recordings,
    fetch: vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new TypeError('Failed to fetch');
      return next();
    }) as unknown as typeof fetch,
    onStored: () => undefined,
  });
});
afterEach(() => store.close());

describe('server trace sync', () => {
  it('pulls spans into the recording session, validates and redacts them again', async () => {
    responses.push(() =>
      json({ instance: 'i1', cursor: 2, spans: [rawSpan(1), rawSpan(2), { junk: true }], more: false }),
    );
    await sync.syncAll();
    const spans = await store.listSpans({ sessionId: 's-1' });
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      id: `${TRACE}:0000000000000001`,
      outbound: true,
      httpStatus: 503,
      sessionId: 's-1',
    });
    const text = JSON.stringify(spans);
    expect(text).not.toContain('leak');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('tok-abc');
    expect((await getTraceStatus()).next).toMatchObject({ ok: true, lastSpanCount: 2 });
  });

  it('ignores spans from before recording started and pulls nothing when the app is not recorded', async () => {
    responses.push(() => json({ instance: 'i1', cursor: 1, spans: [rawSpan(1, { startTime: 100 })] }));
    await sync.syncAll();
    expect(await store.listSpans()).toHaveLength(0);
    recordings = [];
    await sync.syncAll();
    expect(responses).toHaveLength(0);
  });

  it('continues from the cursor and reports a collector restart', async () => {
    responses.push(() => json({ instance: 'i1', cursor: 1, spans: [rawSpan(1)] }));
    await sync.syncAll();
    let requested = '';
    responses.push(() => json({ instance: 'i2', cursor: 3, spans: [] }));
    responses.push(() => json({ instance: 'i2', cursor: 1, spans: [rawSpan(9)] }));
    (sync as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = vi.fn(async (url: string) => {
      requested += `${url}\n`;
      return responses.shift()!();
    }) as unknown as typeof fetch;
    await sync.syncAll();
    expect(requested).toContain('after=1&');
    expect(requested).toContain('after=0&');
    const [restart] = await store.listTimeline({ sessionId: 's-1' });
    expect(restart).toMatchObject({ kind: 'capture', message: expect.stringContaining('restarted') });
    expect((await store.listSpans()).map((s) => s.spanId)).toEqual(['0000000000000001', '0000000000000009']);
  });

  it('reports an unreachable collector, a rejected token and a missing token distinctly', async () => {
    await sync.syncAll();
    expect((await getTraceStatus()).next).toMatchObject({
      ok: false,
      message: expect.stringContaining('unreachable'),
    });
    responses.push(() => json({ error: 'missing or invalid token' }, 401));
    await sync.syncAll();
    expect((await getTraceStatus()).next).toMatchObject({
      ok: false,
      message: expect.stringContaining('rejected'),
    });
    await chrome.storage.local.set({ [TOKENS_KEY]: {} });
    await sync.syncAll();
    expect((await getTraceStatus()).next!.message).toMatch(/No collector token/);
  });
});
