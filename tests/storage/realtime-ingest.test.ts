import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTION_NAVIGATED_WARNING, Ingestor } from '../../src/background/ingest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type {
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RecordingState,
  Settings,
} from '../../src/shared/types';
import { EntryStore } from '../../src/storage/database';
import { draft } from '../helpers/entries';

let store: EntryStore;
let recording: RecordingState | null;
let settings: Settings;
let ingestor: Ingestor;
let n = 0;
const ORIGIN = 'https://app.test';

beforeEach(async () => {
  store = await EntryStore.open(`rt-${++n}`);
  recording = { sessionId: 's-1', tabId: 7, origin: ORIGIN, startedAt: 0 };
  settings = DEFAULT_SETTINGS;
  ingestor = new Ingestor({
    store,
    settings: async () => settings,
    recording: async (tabId) => (recording && recording.tabId === tabId ? recording : null),
  });
});
afterEach(() => store.close());

const conn = (o: Partial<RealtimeConnectionDraft> = {}): RealtimeConnectionDraft => ({
  id: 'c1',
  pageId: 'p1',
  pageUrl: `${ORIGIN}/orders`,
  transport: 'websocket',
  url: 'wss://app.test/ws',
  state: 'connecting',
  createdAt: 1000,
  warnings: [],
  source: 'main-world',
  ...o,
});
let m = 0;
const msg = (o: Partial<RealtimeMessageDraft> = {}): RealtimeMessageDraft => ({
  id: `m${++m}`,
  connectionId: 'c1',
  direction: 'in',
  timestamp: 2000 + m,
  opcode: 'text',
  text: '{"type":"order.created","orderId":1}',
  source: 'main-world',
  ...o,
});
const batch = (...events: unknown[]) => ingestor.ingestBatch(7, ORIGIN, events);

describe('realtime ingest', () => {
  it('stores connections and messages, updates counters and decodes payloads', async () => {
    await batch(
      { type: 'rt-connection', connection: conn() },
      { type: 'rt-connection', connection: conn({ state: 'open', openedAt: 1100 }) },
      { type: 'rt-message', message: msg() },
      { type: 'rt-message', message: msg({ direction: 'out', text: 'hello' }) },
    );
    const [c] = await store.listConnections({ sessionId: 's-1' });
    expect(c).toMatchObject({
      state: 'open',
      openedAt: 1100,
      protocol: 'raw',
      inCount: 1,
      outCount: 1,
      attempt: 0,
    });
    const page = await store.listMessages('c1');
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]!.decoded?.[0]).toMatchObject({
      name: 'order.created',
      nameSource: 'field "type"',
    });
    expect(page.messages[0]!.sessionId).toBe('s-1');
  });

  it('stores a burst of frames from one batch with exact counters, skipping invalid and repeated ids', async () => {
    await batch({ type: 'rt-connection', connection: conn({ state: 'open' }) });
    const frames = Array.from({ length: 300 }, (_, i) => ({
      type: 'rt-message',
      message: msg({ id: `burst-${i}`, timestamp: 10_000 + i, text: `{"type":"tick","i":${i}}` }),
    }));
    const result = await batch(
      ...frames,
      { type: 'rt-message', message: { id: 'bad' } },
      {
        type: 'rt-message',
        message: msg({ id: 'burst-0', timestamp: 10_000, text: '{"type":"tick","i":0}' }),
      },
      { type: 'rt-message', message: msg({ connectionId: 'unknown' }) },
      { type: 'rt-message', message: msg({ id: 'after', direction: 'out', text: 'bye' }) },
    );
    expect(result).toMatchObject({ stored: 301, dropped: 3 });
    const c = (await store.getConnection('c1'))!;
    expect(c).toMatchObject({ inCount: 300, outCount: 1, lastMessageAt: 10_299 });
    expect(c.bytesIn).toBe(frames.reduce((n, f) => n + f.message.text!.length, 0));
    expect((await store.listMessages('c1', { limit: 1000 })).messages).toHaveLength(301);
  });

  it('never revives a closed connection from a late, out-of-order update', async () => {
    await batch(
      { type: 'rt-connection', connection: conn({ state: 'closed', closeCode: 1006 }) },
      { type: 'rt-connection', connection: conn({ state: 'open' }) },
    );
    expect((await store.getConnection('c1'))!.state).toBe('closed');
  });

  it('redacts secrets in URLs, frame text and decoded arguments before storage', async () => {
    await batch(
      {
        type: 'rt-connection',
        connection: conn({
          id: 'sio',
          url: 'wss://app.test/socket.io/?EIO=4&transport=websocket&token=tok-secret',
        }),
      },
      {
        type: 'rt-message',
        message: msg({ connectionId: 'sio', text: '42["login",{"user":"a","password":"hunter2"}]' }),
      },
      { type: 'rt-message', message: msg({ text: '{"type":"auth","accessToken":"tok-secret-2"}' }) },
    );
    const all =
      JSON.stringify(await store.listSessionMessages('s-1')) + JSON.stringify(await store.listConnections());
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('tok-secret');
    const sio = (await store.listMessages('sio')).messages[0]!;
    expect(sio.decoded?.[0]).toMatchObject({ name: 'login', args: [{ user: 'a', password: '[REDACTED]' }] });
    expect(sio.redactions).toBeGreaterThan(0);
  });

  it('merges a CDP observation of the same connection and frames instead of duplicating', async () => {
    await batch(
      { type: 'rt-connection', connection: conn({ state: 'open' }) },
      { type: 'rt-message', message: msg({ id: 'mw-1', timestamp: 5000, text: '{"type":"tick"}' }) },
    );
    // CDP reports the same socket under its own request id, ~ms later.
    await ingestor.ingestTrusted(7, [
      {
        type: 'rt-connection',
        connection: conn({ id: 'cdp-77', createdAt: 1003, state: 'open', source: 'cdp', pageId: '' }),
      },
      {
        type: 'rt-message',
        message: msg({
          id: 'cdp-f1',
          connectionId: 'cdp-77',
          timestamp: 5004,
          text: '{"type":"tick"}',
          source: 'cdp',
        }),
      },
      {
        type: 'rt-message',
        message: msg({
          id: 'cdp-f2',
          connectionId: 'cdp-77',
          timestamp: 5100,
          text: '{"type":"only-cdp"}',
          source: 'cdp',
        }),
      },
    ]);
    const conns = await store.listConnections({ sessionId: 's-1' });
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ sources: ['main-world', 'cdp'], aliases: ['cdp-77'] });
    const msgs = (await store.listMessages('c1')).messages;
    expect(msgs.map((x) => [x.text, x.sources])).toEqual([
      ['{"type":"tick"}', ['main-world', 'cdp']],
      ['{"type":"only-cdp"}', ['cdp']],
    ]);
  });

  it('does not merge identical payloads sent at different times', async () => {
    await batch(
      { type: 'rt-connection', connection: conn() },
      { type: 'rt-message', message: msg({ timestamp: 5000, text: 'same' }) },
      { type: 'rt-message', message: msg({ timestamp: 5001, text: 'same' }) },
    );
    expect((await store.listMessages('c1')).messages).toHaveLength(2);
  });

  it('links reconnects to the previous connection and Socket.IO upgrades to the polling session', async () => {
    await batch(
      { type: 'rt-connection', connection: conn({ id: 'a', state: 'closed', createdAt: 1000 }) },
      { type: 'rt-connection', connection: conn({ id: 'b', createdAt: 3000 }) },
    );
    expect(await store.getConnection('b')).toMatchObject({ reconnectOf: 'a', attempt: 1 });

    const poll = draft({
      id: 'h1',
      url: 'https://app.test/socket.io/?EIO=4&transport=polling&t=1',
      startedAt: 100,
      endedAt: 110,
      responseBody: { kind: 'text', text: '0{"sid":"S1","upgrades":["websocket"],"pingInterval":25000}' },
    });
    await batch(
      { type: 'network-end', draft: poll },
      {
        type: 'network-end',
        draft: draft({
          id: 'h2',
          method: 'POST',
          url: 'https://app.test/socket.io/?EIO=4&transport=polling&sid=S1',
          startedAt: 120,
          endedAt: 130,
          requestBody: { kind: 'text', text: '40' },
        }),
      },
      {
        type: 'network-end',
        draft: draft({
          id: 'h3',
          url: 'https://app.test/socket.io/?EIO=4&transport=polling&sid=S1&t=2',
          startedAt: 125,
          endedAt: 140,
          responseBody: { kind: 'text', text: '40{"sid":"N1"}\x1e42["order.created",{"id":1}]' },
        }),
      },
      {
        type: 'rt-connection',
        connection: conn({
          id: 'ws',
          url: 'wss://app.test/socket.io/?EIO=4&transport=websocket&sid=S1',
          createdAt: 9000,
        }),
      },
    );
    const pollingId = 'sio-poll:s-1:S1';
    const polling = await store.getConnection(pollingId);
    expect(polling).toMatchObject({ transport: 'polling', protocol: 'socket.io', state: 'closed' });
    expect(polling!.warnings.join()).toMatch(/Upgraded to WebSocket/);
    const kinds = (await store.listMessages(pollingId)).messages.flatMap(
      (x) => x.decoded?.map((d) => d.kind) ?? [],
    );
    expect(kinds).toEqual(['engine.io open', 'CONNECT', 'CONNECT', 'EVENT']);
    expect(await store.getConnection('ws')).toMatchObject({ upgradedFrom: pollingId, protocol: 'socket.io' });
    // The HTTP requests stay visible as requests too.
    expect((await store.listEntries()).map((e) => e.id)).toEqual(['h1', 'h2', 'h3']);
  });

  it('closes the polling connection even when the upgrade WebSocket is recorded first', async () => {
    await batch(
      {
        type: 'rt-connection',
        connection: conn({ id: 'ws2', url: 'wss://app.test/socket.io/?EIO=4&transport=websocket&sid=S9' }),
      },
      {
        type: 'network-end',
        draft: draft({
          url: 'https://app.test/socket.io/?EIO=4&transport=polling&t=1',
          responseBody: { kind: 'text', text: '0{"sid":"S9","upgrades":["websocket"]}' },
        }),
      },
    );
    expect(await store.getConnection('sio-poll:s-1:S9')).toMatchObject({ state: 'closed' });
  });

  it('detects SignalR from the negotiate request and derives long-polling messages', async () => {
    await batch(
      {
        type: 'network-end',
        draft: draft({
          id: 'neg',
          method: 'POST',
          url: 'https://app.test/hubs/orders/negotiate?negotiateVersion=1',
          startedAt: 1000,
          responseBody: {
            kind: 'json',
            text: '{"connectionId":"X","connectionToken":"T","negotiateVersion":1,"availableTransports":[]}',
          },
        }),
      },
      {
        type: 'rt-connection',
        connection: conn({ id: 'sr', url: 'wss://app.test/hubs/orders?id=T', createdAt: 1200 }),
      },
      {
        type: 'network-end',
        draft: draft({
          id: 'lp1',
          url: 'https://app.test/hubs/orders?id=T2&_=1',
          startedAt: 1300,
          responseBody: {
            kind: 'text',
            text: '{"type":1,"target":"OrderCreated","arguments":[{"id":3}]}\x1e',
          },
        }),
      },
    );
    const sr = await store.getConnection('sr');
    expect(sr).toMatchObject({ protocol: 'signalr', negotiateEntryId: 'neg' });
    const lp = (await store.listConnections({ sessionId: 's-1' })).find((c) => c.transport === 'polling')!;
    expect(lp.protocol).toBe('signalr');
    const [lpMsg] = (await store.listMessages(lp.id)).messages;
    expect(lpMsg!.decoded?.[0]).toMatchObject({ kind: 'Invocation', name: 'OrderCreated' });
    expect(lpMsg!.sources).toEqual(['derived']);
  });

  it('closes connections of the previous document on navigation', async () => {
    await batch({ type: 'rt-connection', connection: conn({ state: 'open' }) });
    await batch({ type: 'hello', pageId: 'p2', url: `${ORIGIN}/next`, at: 4000 });
    expect(await store.getConnection('c1')).toMatchObject({ state: 'closed', closedAt: 4000 });
    expect((await store.getConnection('c1'))!.warnings).toContain(CONNECTION_NAVIGATED_WARNING);
  });

  it('drops realtime events when realtime capture is disabled, while paused, or when not recording', async () => {
    settings = { ...DEFAULT_SETTINGS, captureRealtime: false };
    expect((await batch({ type: 'rt-connection', connection: conn() })).dropped).toBe(1);
    settings = DEFAULT_SETTINGS;
    recording = { ...recording!, paused: true };
    expect((await batch({ type: 'rt-connection', connection: conn() })).dropped).toBe(1);
    recording = null;
    expect((await batch({ type: 'rt-connection', connection: conn() })).dropped).toBe(1);
    expect(await store.listConnections()).toHaveLength(0);
  });

  it('rejects forged or malformed realtime records and never stores binary content', async () => {
    const result = await batch(
      { type: 'rt-connection', connection: { id: 'x', url: 'javascript:alert(1)', transport: 'websocket' } },
      { type: 'rt-connection', connection: conn() },
      { type: 'rt-message', message: { ...msg(), opcode: 'binary', text: 'secret-bytes', size: 12 } },
      { type: 'rt-message', message: { ...msg(), connectionId: 'unknown' } },
      { type: 'rt-message', message: { id: 1 } },
    );
    expect(result.dropped).toBe(3);
    const [bin] = (await store.listMessages('c1')).messages;
    expect(bin).toMatchObject({ opcode: 'binary', size: 12 });
    expect(bin!.text).toBeUndefined();
  });

  it('truncates frames to the configured size limit', async () => {
    settings = { ...DEFAULT_SETTINGS, maxFrameKB: 1 };
    await batch(
      { type: 'rt-connection', connection: conn() },
      { type: 'rt-message', message: msg({ text: 'y'.repeat(5000), size: 5000 }) },
    );
    const [big] = (await store.listMessages('c1')).messages;
    expect(big!.text!.length).toBe(1024);
    expect(big).toMatchObject({ truncated: true, size: 5000 });
  });

  it('records rate-limit drops as an explicit capture-incomplete event', async () => {
    await batch({ type: 'capture-dropped', count: 12, at: 9 });
    const [event] = await store.listTimeline({ sessionId: 's-1' });
    expect(event).toMatchObject({ kind: 'capture', message: expect.stringContaining('12 event(s) dropped') });
  });

  it('paginates messages of a connection in time order', async () => {
    await batch({ type: 'rt-connection', connection: conn() });
    const events = Array.from({ length: 25 }, (_, i) => ({
      type: 'rt-message',
      message: msg({
        id: `p${String(i).padStart(2, '0')}`,
        timestamp: 10_000 + Math.floor(i / 2),
        text: `#${i}`,
      }),
    }));
    await batch(...events);
    const seen: string[] = [];
    let after: [number, string] | undefined;
    do {
      const page = await store.listMessages('c1', { after, limit: 7 });
      seen.push(...page.messages.map((x) => x.text!));
      after = page.next;
    } while (after);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `#${i}`));
  });

  it('enforces the realtime message cap', async () => {
    settings = { ...DEFAULT_SETTINGS, maxRealtimeMessages: 100 };
    await batch({ type: 'rt-connection', connection: conn() });
    await batch(
      ...Array.from({ length: 150 }, (_, i) => ({ type: 'rt-message', message: msg({ text: `${i}` }) })),
    );
    expect(await store.countMessages()).toBeLessThanOrEqual(100);
  });
});

describe('database migration', () => {
  it('upgrades a v1 database without losing requests, timeline or sessions', async () => {
    const name = `migrate-${++n}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('by-session', 'sessionId');
        entries.createIndex('by-started', 'startedAt');
        entries.createIndex('by-state', 'state');
        db.createObjectStore('bodies', { keyPath: 'id' });
        const timeline = db.createObjectStore('timeline', { keyPath: 'id' });
        timeline.createIndex('by-session', 'sessionId');
        timeline.createIndex('by-time', 'timestamp');
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-started', 'startedAt');
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('contracts', { keyPath: 'endpointKey' });
      },
    });
    await v1.put('sessions', { id: 'old', tabId: 1, origin: ORIGIN, startedAt: 1, label: 'old' });
    await v1.put('entries', { id: 'e-old', sessionId: 'old', startedAt: 1, state: 'complete', bytes: 10 });
    await v1.put('timeline', { id: 't-old', sessionId: 'old', timestamp: 1, kind: 'click' });
    v1.close();

    const upgraded = await EntryStore.open(name);
    expect((await upgraded.listEntries()).map((e) => e.id)).toEqual(['e-old']);
    expect((await upgraded.listTimeline()).map((e) => e.id)).toEqual(['t-old']);
    expect((await upgraded.listSessions()).map((s) => s.id)).toEqual(['old']);
    expect(await upgraded.listConnections()).toEqual([]);
    expect(await upgraded.listSpans()).toEqual([]);
    upgraded.close();
  });

  it('clears realtime data together with the session', async () => {
    await batch({ type: 'rt-connection', connection: conn() }, { type: 'rt-message', message: msg() });
    await store.clearSession('s-1');
    expect(await store.listConnections()).toEqual([]);
    expect(await store.countMessages()).toBe(0);
  });
});
