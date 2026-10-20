import { describe, expect, it } from 'vitest';
import {
  correlationIdsOf,
  linkBrowserToServer,
  linkRequestsToRealtime,
  traceIdOfEntry,
} from '../../src/analysis/trace-correlate';
import { buildUnifiedTimeline, filterUnified } from '../../src/analysis/unified-timeline';
import type { RealtimeConnection, RealtimeMessage, ServerSpan, TimelineEvent } from '../../src/shared/types';
import { entry } from '../helpers/entries';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const span = (o: Partial<ServerSpan> = {}): ServerSpan => ({
  id: `${o.traceId ?? TRACE}:${o.spanId ?? '00f067aa0ba902b7'}`,
  traceId: TRACE,
  spanId: '00f067aa0ba902b7',
  name: 'GET /orders',
  kind: 'server',
  startTime: 1000,
  endTime: 1200,
  status: 'unset',
  outbound: false,
  attributes: {},
  events: [],
  source: 'next-adapter',
  sessionId: 's-1',
  origin: 'https://app.test',
  redactions: 0,
  ...o,
});
const nav = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: 'nav',
  pageId: 'p',
  pageUrl: 'https://app.test/orders',
  kind: 'navigation',
  timestamp: 1500,
  message: 'Document loaded',
  sessionId: 's-1',
  tabId: 1,
  origin: 'https://app.test',
  ...o,
});

describe('browser ↔ server correlation', () => {
  it('links a navigation to its server trace only through a shared trace id', () => {
    const links = linkBrowserToServer([], [nav({ data: { traceId: TRACE } })], [span()]);
    expect(links).toEqual([
      expect.objectContaining({
        strength: 'explicit',
        to: { type: 'trace', id: TRACE },
        evidence: expect.stringContaining('meta'),
      }),
    ]);
  });

  it('uses traceparent request headers and request-id headers as explicit evidence', () => {
    const withTrace = entry({
      id: 'r1',
      requestHeaders: [{ name: 'traceparent', value: `00-${TRACE}-00f067aa0ba902b7-01` }],
    });
    expect(traceIdOfEntry(withTrace)?.traceId).toBe(TRACE);
    const other = 'a'.repeat(32);
    const withRid = entry({ id: 'r2', responseHeaders: [{ name: 'x-request-id', value: 'req-abc123' }] });
    const links = linkBrowserToServer(
      [withTrace, withRid],
      [],
      [
        span(),
        span({
          traceId: other,
          spanId: 'b'.repeat(16),
          attributes: { 'http.response.header.x-request-id': 'req-abc123' },
        }),
      ],
    );
    expect(links.map((l) => [l.from.id, l.strength, l.to.id])).toEqual([
      ['r1', 'explicit', TRACE],
      ['r2', 'explicit', other],
    ]);
  });

  it('labels a path+time match as probable, and refuses to pick between concurrent candidates', () => {
    const req = entry({
      id: 'post',
      method: 'POST',
      url: 'https://app.test/api/orders',
      startedAt: 1000,
      endedAt: 1100,
    });
    const s1 = span({ name: 'POST /api/orders', httpMethod: 'POST', startTime: 1010 });
    expect(linkBrowserToServer([req], [], [s1])[0]).toMatchObject({
      strength: 'probable',
      evidence: expect.stringContaining('time only'),
    });

    const s2 = span({
      traceId: 'c'.repeat(32),
      spanId: 'd'.repeat(16),
      name: 'POST /api/orders',
      httpMethod: 'POST',
      startTime: 1050,
    });
    const [ambiguous] = linkBrowserToServer([req], [], [s1, s2]);
    expect(ambiguous).toMatchObject({ strength: 'ambiguous' });
    expect(ambiguous!.candidates).toHaveLength(2);
  });

  it('does not link requests whose path or time do not match', () => {
    const req = entry({ url: 'https://app.test/api/other', startedAt: 1000, endedAt: 1100 });
    const late = entry({ url: 'https://app.test/orders', startedAt: 10_000, endedAt: 10_100 });
    expect(linkBrowserToServer([req, late], [], [span()])).toEqual([]);
  });
});

const msg = (o: Partial<RealtimeMessage>): RealtimeMessage => ({
  id: 'm',
  connectionId: 'c',
  direction: 'in',
  timestamp: 2000,
  opcode: 'text',
  text: '{}',
  source: 'main-world',
  sessionId: 's-1',
  tabId: 1,
  sources: ['main-world'],
  dedupKey: 'k',
  redactions: 0,
  ...o,
});

describe('HTTP ↔ realtime correlation', () => {
  const post = entry({
    id: 'post',
    tabId: 1,
    method: 'POST',
    url: 'https://app.test/api/orders',
    startedAt: 1000,
    endedAt: 1100,
    responseHeaders: [{ name: 'x-request-id', value: 'req-77aa' }],
  });

  it('is explicit when the message carries an id from the response', () => {
    const links = linkRequestsToRealtime(
      [post],
      [msg({ id: 'm1', text: '{"type":"order.created","requestId":"req-77aa"}' })],
    );
    expect(links).toEqual([
      expect.objectContaining({ strength: 'explicit', evidence: expect.stringContaining('x-request-id') }),
    ]);
    const fromBody = correlationIdsOf(post, '{"orderId":"o-5001","status":"created"}');
    expect(fromBody.map((i) => i.value)).toContain('o-5001');
  });

  it('is only probable for messages shortly after a mutation without a shared id, and ignores heartbeats', () => {
    const links = linkRequestsToRealtime(
      [post],
      [
        msg({ id: 'near', timestamp: 1400, text: '{"type":"order.created"}' }),
        msg({ id: 'far', timestamp: 9000, text: '{"type":"order.created"}' }),
        msg({
          id: 'hb',
          timestamp: 1200,
          text: '2',
          decoded: [{ protocol: 'socket.io', category: 'heartbeat', kind: 'ping' }],
        }),
      ],
    );
    expect(links.map((l) => [l.to.id, l.strength])).toEqual([['near', 'probable']]);
  });

  it('never links GET requests by time alone', () => {
    const get = entry({ method: 'GET', tabId: 1, startedAt: 1000, endedAt: 1100 });
    expect(linkRequestsToRealtime([get], [msg({ timestamp: 1200 })])).toEqual([]);
  });
});

describe('unified timeline', () => {
  const conn: RealtimeConnection = {
    id: 'c',
    pageId: 'p',
    pageUrl: '',
    transport: 'websocket',
    url: 'wss://app.test/socket.io/?EIO=4&transport=websocket',
    state: 'closed',
    createdAt: 900,
    closeCode: 1006,
    warnings: [],
    source: 'main-world',
    sessionId: 's-1',
    tabId: 1,
    origin: 'https://app.test',
    protocol: 'socket.io',
    sources: ['main-world'],
    attempt: 1,
    inCount: 0,
    outCount: 0,
    bytesIn: 0,
    bytesOut: 0,
    redactions: 0,
  };
  const items = buildUnifiedTimeline({
    entries: [entry({ id: 'r', startedAt: 1000, status: 500 })],
    timeline: [nav({ id: 'err', kind: 'console-error', timestamp: 1300, message: 'boom' })],
    connections: [conn],
    messages: [
      msg({
        id: 'app',
        timestamp: 1100,
        decoded: [{ protocol: 'socket.io', category: 'app', kind: 'EVENT', name: 'order.created' }],
      }),
      msg({
        id: 'hb',
        timestamp: 1150,
        decoded: [{ protocol: 'socket.io', category: 'heartbeat', kind: 'ping' }],
      }),
    ],
    spans: [
      span({ startTime: 1005 }),
      span({ spanId: 'e'.repeat(16), kind: 'internal', parentSpanId: '00f067aa0ba902b7' }),
    ],
  });

  it('orders all sources chronologically and hides protocol noise and internal spans by default', () => {
    expect(items.map((i) => i.key)).toEqual([
      'rt-connection:c',
      'request:r',
      `span:${TRACE}:00f067aa0ba902b7`,
      'rt-message:app',
      'timeline:err',
    ]);
    expect(items.find((i) => i.key === 'rt-connection:c')).toMatchObject({
      category: 'socket.io',
      severity: 'error',
    });
    expect(items.find((i) => i.key === 'rt-message:app')!.title).toContain('order.created');
  });

  it('filters by category, problems and text', () => {
    expect(filterUnified(items, { categories: ['socket.io'] }).map((i) => i.key)).toEqual([
      'rt-connection:c',
      'rt-message:app',
    ]);
    expect(filterUnified(items, { onlyProblems: true }).map((i) => i.category)).toEqual([
      'socket.io',
      'http',
      'console',
    ]);
    expect(filterUnified(items, { text: 'order.created' })).toHaveLength(1);
  });
});

describe('HTTP ↔ realtime correlation: noise control', () => {
  it('ignores realtime transport requests and links a message only to the nearest preceding mutation', () => {
    const transport = entry({
      id: 'lp',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/hubs/orders?id=tok',
      startedAt: 900,
      endedAt: 950,
    });
    const sio = entry({
      id: 'sio',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/socket.io/?EIO=4&transport=polling&sid=x',
      startedAt: 960,
      endedAt: 970,
    });
    const older = entry({
      id: 'old',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/api/a',
      startedAt: 1000,
      endedAt: 1100,
    });
    const newer = entry({
      id: 'new',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/api/b',
      startedAt: 1200,
      endedAt: 1300,
    });
    const links = linkRequestsToRealtime(
      [transport, sio, older, newer],
      [msg({ id: 'm', timestamp: 1500, text: '{"type":"x"}' })],
    );
    expect(links.map((l) => [l.from.id, l.strength])).toEqual([['new', 'probable']]);
  });
});
