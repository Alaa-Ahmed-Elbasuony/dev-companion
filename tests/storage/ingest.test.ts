import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ingestor, NAVIGATED_WARNING } from '../../src/background/ingest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { RecordingState } from '../../src/shared/types';
import { EntryStore } from '../../src/storage/database';
import { draft } from '../helpers/entries';

let store: EntryStore;
let recording: RecordingState | null;
let errors: string[];
let ingestor: Ingestor;
let n = 0;

beforeEach(async () => {
  store = await EntryStore.open(`ingest-${++n}`);
  recording = { sessionId: 's-1', tabId: 7, origin: 'https://app.test', startedAt: 0 };
  errors = [];
  ingestor = new Ingestor({
    store,
    settings: async () => DEFAULT_SETTINGS,
    recording: async (tabId) => (recording && recording.tabId === tabId ? recording : null),
    onStorageError: (m) => errors.push(m),
  });
});
afterEach(() => store.close());

describe('Ingestor', () => {
  it('stores events for a recording tab and links them to the session and tab', async () => {
    const d = draft({ id: 'r1', method: 'POST', url: 'https://app.test/api/orders', status: 422 });
    const result = await ingestor.ingestBatch(7, 'https://app.test', [
      { type: 'network-start', draft: { ...d, state: 'pending', status: undefined } },
      { type: 'network-end', draft: d },
    ]);
    expect(result).toMatchObject({ stored: 2, dropped: 0 });
    expect(await store.getEntry('r1')).toMatchObject({
      sessionId: 's-1',
      tabId: 7,
      origin: 'https://app.test',
      state: 'complete',
      status: 422,
    });
  });

  it('drops everything when the tab is not recording (recording stopped)', async () => {
    recording = null;
    const result = await ingestor.ingestBatch(7, 'https://app.test', [
      { type: 'network-end', draft: draft() },
    ]);
    expect(result).toMatchObject({ stored: 0, dropped: 1 });
    expect(await store.listEntries()).toEqual([]);
  });

  it('drops events from a document whose origin is not being recorded', async () => {
    const result = await ingestor.ingestBatch(7, 'https://elsewhere.test', [
      { type: 'network-end', draft: draft() },
    ]);
    expect(result.dropped).toBe(1);
  });

  it('rejects malformed or forged events', async () => {
    const result = await ingestor.ingestBatch(7, 'https://app.test', [
      { type: 'network-end', draft: { id: 'x' } },
      { type: 'network-end', draft: { ...draft(), method: 'GET /etc/passwd' } },
      { type: 'unknown' },
      null,
    ]);
    expect(result).toMatchObject({ stored: 0, dropped: 4 });
  });

  it('removes secrets before anything is written to storage', async () => {
    const d = draft({
      id: 'secret',
      method: 'POST',
      url: 'https://app.test/api/login?api_key=abc123&page=2',
      requestHeaders: [
        { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' },
        { name: 'content-type', value: 'application/json' },
      ],
      responseHeaders: [{ name: 'set-cookie', value: 'sid=s3cr3t; HttpOnly' }],
      requestBody: {
        kind: 'json',
        text: '{"email":"a@b.c","password":"hunter2","card":{"cardNumber":"4111 1111 1111 1111"}}',
      },
      responseBody: { kind: 'json', text: '{"access_token":"tok-123","user":{"name":"Ada"}}' },
    });
    await ingestor.ingestBatch(7, 'https://app.test', [{ type: 'network-end', draft: d }]);
    const stored = await store.getEntry('secret');
    const bodies = await store.getBodies('secret');
    const raw = JSON.stringify({ stored, bodies });
    for (const secret of ['hunter2', 'tok-123', 's3cr3t', 'abc123', 'eyJhbGciOiJIUzI1NiJ9', '4111']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('a@b.c');
    expect(raw).toContain('Ada');
    expect(stored!.url).toContain('page=2');
    expect(stored!.redactions).toBeGreaterThanOrEqual(6);
  });

  it('marks in-flight requests of the previous document incomplete when a new page loads (navigation/reload)', async () => {
    const pending = draft({
      id: 'inflight',
      pageId: 'p-old',
      state: 'pending',
      status: undefined,
      endedAt: undefined,
    });
    await ingestor.ingestBatch(7, 'https://app.test', [{ type: 'network-start', draft: pending }]);
    const result = await ingestor.ingestBatch(7, 'https://app.test', [
      { type: 'hello', pageId: 'p-new', url: 'https://app.test/', at: 5 },
    ]);
    expect(result.sawHello).toBe(true);
    const e = await store.getEntry('inflight');
    expect(e!.state).toBe('incomplete');
    expect(e!.warnings).toContain(NAVIGATED_WARNING);
    const timeline = await store.listTimeline({ sessionId: 's-1' });
    expect(timeline.map((t) => t.kind)).toContain('page-load');
  });

  it('stores timeline events with redaction and refuses reserved kinds from the page', async () => {
    await ingestor.ingestBatch(7, 'https://app.test', [
      {
        type: 'timeline',
        event: {
          id: 't1',
          pageId: 'p',
          pageUrl: 'https://app.test/',
          kind: 'console-error',
          timestamp: 1,
          message: 'Auth failed for Bearer abcdefghijklmnop',
        },
      },
      {
        type: 'timeline',
        event: {
          id: 't2',
          pageId: 'p',
          pageUrl: 'https://app.test/',
          kind: 'marker',
          timestamp: 2,
          message: 'fake marker',
        },
      },
    ]);
    const list = await store.listTimeline({ sessionId: 's-1' });
    expect(list[0]!.message).toBe('Auth failed for Bearer [REDACTED]');
    expect(list[1]!.kind).not.toBe('marker');
  });

  it('removes secrets in the page URL from stacks, page-load and route-change events before storage', async () => {
    const secret = 'synthetic-oauth-code-77';
    const page = `https://app.test/cb?access_token=${secret}&state=1`;
    await ingestor.ingestBatch(7, 'https://app.test', [
      { type: 'hello', pageId: 'p', url: page, at: 1 },
      {
        type: 'network-end',
        draft: draft({ id: 'oauth', pageUrl: page, initiatorStack: `    at ${page}:12:5` }),
      },
      {
        type: 'timeline',
        event: {
          id: 't-route',
          pageId: 'p',
          pageUrl: 'https://app.test/home',
          kind: 'route-change',
          timestamp: 2,
          message: 'Route changed via history.pushState',
          detail: `${page} → https://app.test/home`,
        },
      },
    ]);
    const stored = JSON.stringify([
      await store.getEntry('oauth'),
      await store.listTimeline({ sessionId: 's-1' }),
    ]);
    expect(stored).not.toContain(secret);
    expect(stored).toContain('state=1');
  });

  it('applies retention after ingesting', async () => {
    const settings = { ...DEFAULT_SETTINGS, maxEntries: 50 };
    const small = new Ingestor({ store, settings: async () => settings, recording: async () => recording });
    const events = Array.from({ length: 60 }, (_, i) => ({
      type: 'network-end',
      draft: draft({ id: `r${i}`, startedAt: i }),
    }));
    await small.ingestBatch(7, 'https://app.test', events);
    expect((await store.getUsage()).entryCount).toBeLessThanOrEqual(50);
  });

  it('handles storage quota errors by evicting and then dropping bodies', async () => {
    const realUpsert = store.upsertEntry.bind(store);
    let failures = 2;
    store.upsertEntry = async (e, b, mode) => {
      if (failures-- > 0) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      return realUpsert(e, b, mode);
    };
    const d = draft({ id: 'q', responseBody: { kind: 'text', text: 'big body' } });
    await ingestor.ingestBatch(7, 'https://app.test', [{ type: 'network-end', draft: d }]);
    const stored = await store.getEntry('q');
    expect(stored!.warnings.join(' ')).toMatch(/quota/);
    expect(await store.getBodies('q')).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
