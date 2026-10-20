import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedCapture, base64Size } from '../../src/background/cdp';
import type { PageMessage } from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { RecordingState } from '../../src/shared/types';
import { EntryStore } from '../../src/storage/database';
import { installFakeChrome } from '../helpers/fake-chrome';

let store: EntryStore;
let rec: RecordingState;
let ingested: PageMessage[];
let capture: AdvancedCapture;
let n = 0;

beforeEach(async () => {
  const { fake } = installFakeChrome();
  Object.assign(fake.tabs, { get: vi.fn(async () => ({ url: 'https://app.test/orders' })) });
  store = await EntryStore.open(`cdp-${++n}`);
  rec = { sessionId: 's', tabId: 3, origin: 'https://app.test', startedAt: 0, advanced: true };
  ingested = [];
  capture = new AdvancedCapture({
    store,
    settings: async () => DEFAULT_SETTINGS,
    recording: async () => rec,
    setAdvancedFlag: async (_tab, advanced) => {
      rec = { ...rec, advanced };
    },
    ingest: async (_tab, events) => {
      ingested.push(...events);
    },
    onChanged: () => undefined,
  });
});
afterEach(() => store.close());

describe('advanced capture (CDP) event mapping', () => {
  it('maps WebSocket events to connection and frame drafts with wall-clock timestamps', async () => {
    await capture.onEvent(3, 'Network.webSocketCreated', { requestId: 'r1', url: 'wss://app.test/ws' });
    await capture.onEvent(3, 'Network.webSocketWillSendHandshakeRequest', {
      requestId: 'r1',
      timestamp: 100,
      wallTime: 1_700_000_000,
    });
    await capture.onEvent(3, 'Network.webSocketHandshakeResponseReceived', {
      requestId: 'r1',
      timestamp: 100.5,
      response: { status: 101, headers: { 'Sec-WebSocket-Protocol': 'v1' } },
    });
    await capture.onEvent(3, 'Network.webSocketFrameReceived', {
      requestId: 'r1',
      timestamp: 101,
      response: { opcode: 1, payloadData: '{"type":"hi"}' },
    });
    await capture.onEvent(3, 'Network.webSocketFrameSent', {
      requestId: 'r1',
      timestamp: 101.25,
      response: { opcode: 2, payloadData: 'AAECAw==' },
    });
    await capture.onEvent(3, 'Network.webSocketFrameReceived', {
      requestId: 'r1',
      timestamp: 102,
      response: { opcode: 9, payloadData: '' }, // ping control frame: not data
    });
    await capture.onEvent(3, 'Network.webSocketClosed', { requestId: 'r1', timestamp: 103 });
    await capture.flush(3);

    const conns = ingested.filter((e) => e.type === 'rt-connection').map((e) => e.connection);
    expect(conns.map((c) => c.state)).toEqual(['connecting', 'open', 'closed']);
    expect(conns.every((c) => c.url === 'wss://app.test/ws' && c.source === 'cdp')).toBe(true);
    expect(conns[1]).toMatchObject({ selectedProtocol: 'v1', openedAt: 1_700_000_000_500 });
    const frames = ingested.filter((e) => e.type === 'rt-message').map((e) => e.message);
    expect(frames.map((f) => [f.direction, f.opcode, f.size, f.timestamp])).toEqual([
      ['none', 'lifecycle', undefined, 1_700_000_000_500],
      ['in', 'text', 13, 1_700_000_001_000],
      ['out', 'binary', 4, 1_700_000_001_250],
    ]);
    expect(frames[2]!.text).toBeUndefined();
  });

  it('captures every SSE event type and document metadata with redacted headers', async () => {
    await capture.onEvent(3, 'Network.requestWillBeSent', {
      requestId: 'e1',
      type: 'EventSource',
      timestamp: 10,
      wallTime: 1_700_000_000,
      request: { url: 'https://app.test/sse' },
    });
    await capture.onEvent(3, 'Network.eventSourceMessageReceived', {
      requestId: 'e1',
      timestamp: 11,
      eventName: 'audit',
      eventId: '9',
      data: '{"a":1}',
    });
    await capture.onEvent(3, 'Network.responseReceived', {
      requestId: 'L1',
      loaderId: 'L1',
      type: 'Document',
      response: {
        url: 'https://app.test/orders',
        status: 200,
        headers: { 'x-request-id': 'req-9', 'set-cookie': 'sid=secret', 'server-timing': 'db;dur=12' },
        timing: { sendEnd: 1, receiveHeadersEnd: 51 },
      },
    });
    await capture.flush(3);
    const msg = ingested.find((e) => e.type === 'rt-message');
    expect(msg?.type === 'rt-message' && msg.message).toMatchObject({
      sse: { type: 'audit', lastEventId: '9' },
      timestamp: 1_700_000_001_000,
    });
    const nav = ingested.find((e) => e.type === 'timeline');
    expect(nav?.type === 'timeline' && nav.event.data).toMatchObject({
      status: 200,
      serverWaitMs: 50,
      'header.x-request-id': 'req-9',
      'header.server-timing': 'db;dur=12',
    });
    expect(JSON.stringify(nav)).not.toContain('sid=secret');
  });

  it('drops events after the tab left the recorded origin, and ignores tabs without advanced capture', async () => {
    (chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: 'https://other.test/',
    });
    await capture.onEvent(3, 'Network.webSocketCreated', { requestId: 'r', url: 'wss://other.test/ws' });
    await capture.flush(3);
    expect(ingested).toHaveLength(0);
    rec = { ...rec, advanced: false };
    await capture.onEvent(3, 'Network.webSocketCreated', { requestId: 'r2', url: 'wss://app.test/ws' });
    await capture.flush(3);
    expect(ingested).toHaveLength(0);
  });

  it('records a detach caused by the user dismissing the debugging banner', async () => {
    await capture.onDetach(3, 'canceled_by_user');
    expect(rec.advanced).toBe(false);
    const [event] = await store.listTimeline();
    expect(event).toMatchObject({
      kind: 'capture',
      message: expect.stringContaining('banner was dismissed'),
    });
  });

  it('computes binary payload sizes from base64', () => {
    expect(base64Size('AAECAw==')).toBe(4);
    expect(base64Size('AAECAwQ=')).toBe(5);
    expect(base64Size('AAECAwQF')).toBe(6);
  });
});
