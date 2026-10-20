import { describe, expect, it } from 'vitest';
import { buildInvestigation, notificationChecklist } from '../../src/analysis/investigation';
import type { InvestigationData } from '../../src/analysis/investigation';
import { investigatorFindings, pathMatches } from '../../src/analysis/investigator-rules';
import { findOperation, parseOpenApi, validateEntryAgainstOpenApi } from '../../src/analysis/openapi';
import { buildPlaywrightDraft, locatorForClick } from '../../src/analysis/playwright';
import { buildBugReportMarkdown } from '../../src/io/bug-report';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type {
  EntryBodies,
  RealtimeConnection,
  RealtimeExpectation,
  RealtimeMessage,
  ServerSpan,
  TimelineEvent,
} from '../../src/shared/types';
import { entry } from '../helpers/entries';

const conn = (o: Partial<RealtimeConnection> = {}): RealtimeConnection => ({
  id: 'c1',
  pageId: 'p',
  pageUrl: 'https://app.test/',
  transport: 'websocket',
  url: 'wss://app.test/ws',
  state: 'open',
  createdAt: 100,
  openedAt: 150,
  warnings: [],
  source: 'main-world',
  sessionId: 's',
  tabId: 1,
  origin: 'https://app.test',
  protocol: 'raw',
  sources: ['main-world'],
  attempt: 0,
  inCount: 0,
  outCount: 0,
  bytesIn: 0,
  bytesOut: 0,
  redactions: 0,
  ...o,
});
let mid = 0;
const msg = (o: Partial<RealtimeMessage> = {}): RealtimeMessage => ({
  id: `m${++mid}`,
  connectionId: 'c1',
  direction: 'in',
  timestamp: 2000,
  opcode: 'text',
  text: '{"type":"order.created","orderId":"o-1"}',
  source: 'main-world',
  sessionId: 's',
  tabId: 1,
  sources: ['main-world'],
  dedupKey: 'k',
  redactions: 0,
  decoded: [
    {
      protocol: 'raw',
      category: 'app',
      kind: 'json',
      name: 'order.created',
      args: [{ type: 'order.created', orderId: 'o-1' }],
    },
  ],
  ...o,
});
const tl = (o: Partial<TimelineEvent>): TimelineEvent => ({
  id: `t${++mid}`,
  pageId: 'p',
  pageUrl: 'https://app.test/',
  kind: 'click',
  timestamp: 900,
  message: '',
  sessionId: 's',
  tabId: 1,
  origin: 'https://app.test',
  ...o,
});
const base = { timeline: [] as TimelineEvent[], slowRequestMs: 2000 };

describe('realtime findings', () => {
  it('reports failed connections, abnormal closes and reconnect storms as observations with hypotheses', () => {
    const findings = investigatorFindings({
      ...base,
      entries: [],
      connections: [
        conn({ id: 'f', state: 'failed', openedAt: undefined, closeCode: 1006 }),
        conn({
          id: 'a',
          state: 'closed',
          closeCode: 1011,
          closeReason: 'boom',
          createdAt: 1000,
          closedAt: 2000,
        }),
        conn({
          id: 'b',
          state: 'closed',
          closeCode: 1006,
          createdAt: 3000,
          closedAt: 4000,
          attempt: 1,
          url: 'wss://app.test/ws',
        }),
        conn({ id: 'c', state: 'open', createdAt: 5000, attempt: 2 }),
      ],
    });
    const failed = findings.find((f) => f.id === 'rt-failed:f')!;
    expect(failed).toMatchObject({ evidenceLevel: 'confirmed', kind: 'realtime-connection' });
    expect(failed.missingEvidence).toContain('Handshake HTTP status (enable advanced capture)');
    expect(findings.find((f) => f.id === 'rt-close:a')!.hypotheses![0]).toMatchObject({ level: 'strong' });
    expect(
      findings.find((f) => f.id === 'rt-close:b')!.hypotheses!.every((h) => h.level === 'possible'),
    ).toBe(true);
    expect(findings.some((f) => f.kind === 'reconnect-storm')).toBe(true);
  });

  it('detects identical duplicate events and malformed messages', () => {
    const findings = investigatorFindings({
      ...base,
      entries: [],
      connections: [conn()],
      messages: [
        msg({ timestamp: 1000 }),
        msg({ timestamp: 1500 }),
        msg({
          parseError: 'Payload looks like JSON but is not valid JSON',
          decoded: undefined,
          text: '{"x":',
        }),
      ],
    });
    const dup = findings.find((f) => f.kind === 'duplicate-event')!;
    expect(dup.title).toContain('received 2 times');
    expect(dup.hypotheses![0]!.text).toMatch(/on one connection/);
    expect(findings.find((f) => f.kind === 'malformed-message')).toMatchObject({
      evidenceLevel: 'confirmed',
    });
  });

  it('checks developer expectations: missing event after a request, and missing required fields', () => {
    const expectation: RealtimeExpectation = {
      id: 'e',
      label: 'order notification',
      afterMethod: 'POST',
      afterPath: '/api/orders',
      eventName: 'order.created',
      withinMs: 2000,
      requiredFields: ['orderId'],
    };
    const post = entry({
      id: 'post',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/api/orders',
      status: 201,
      startedAt: 1000,
      endedAt: 1100,
    });
    const missing = investigatorFindings({
      ...base,
      entries: [post],
      connections: [conn()],
      messages: [],
      expectations: [expectation],
      now: 10_000,
    });
    expect(missing.find((f) => f.kind === 'expectation')!.title).toContain('was not received');
    const notYet = investigatorFindings({
      ...base,
      entries: [post],
      connections: [conn()],
      messages: [],
      expectations: [expectation],
      now: 1500,
    });
    expect(notYet.some((f) => f.kind === 'expectation')).toBe(false);
    const bad = msg({
      timestamp: 1200,
      decoded: [
        {
          protocol: 'raw',
          category: 'app',
          kind: 'json',
          name: 'order.created',
          args: [{ status: 'created' }],
        },
      ],
    });
    const fields = investigatorFindings({
      ...base,
      entries: [post],
      connections: [conn()],
      messages: [bad],
      expectations: [expectation],
      now: 10_000,
    });
    expect(fields.map((f) => f.title)).toEqual([
      expect.stringContaining('missing required field(s): orderId'),
    ]);
  });

  it('matches path patterns', () => {
    expect(pathMatches('/api/orders', 'https://a/api/orders')).toBe(true);
    expect(pathMatches('/api/orders/', 'https://a/api/orders')).toBe(true);
    expect(pathMatches('/api/orders', 'https://a/api/orders/1')).toBe(false);
    expect(pathMatches('/api/orders/:id', 'https://a/api/orders/17')).toBe(true);
  });
});

describe('HTTP and server findings', () => {
  it('flags session expiry after earlier authenticated success as strongly supported', () => {
    const auth = [{ name: 'authorization', value: '[REDACTED]' }];
    const findings = investigatorFindings({
      ...base,
      entries: [
        entry({ url: 'https://api.test/me', status: 200, startedAt: 1000, requestHeaders: auth }),
        entry({ url: 'https://api.test/orders', status: 401, startedAt: 5000, requestHeaders: auth }),
      ],
    });
    const f = findings.find((x) => x.kind === 'auth')!;
    expect(f.hypotheses![0]).toMatchObject({ level: 'strong', text: expect.stringContaining('expired') });
  });

  it('flags requests that never finished, and error bodies consumed as data', () => {
    const bodies = new Map<string, EntryBodies>([
      ['err', { id: 'err', response: { kind: 'json', text: '{"message":"Database down","requestId":"r"}' } }],
    ]);
    const findings = investigatorFindings({
      ...base,
      bodies,
      now: 100_000,
      entries: [
        entry({ id: 'hang', state: 'pending', status: undefined, startedAt: 1000, endedAt: undefined }),
        entry({
          id: 'err',
          tabId: 1,
          status: 500,
          responseBodyKind: 'json',
          startedAt: 50_000,
          endedAt: 50_100,
        }),
      ],
      timeline: [
        tl({
          kind: 'js-error',
          timestamp: 50_300,
          message: "TypeError: Cannot read properties of undefined (reading 'map')",
        }),
      ],
    });
    expect(findings.find((f) => f.kind === 'pending-forever')!.entryIds).toEqual(['hang']);
    const mapping = findings.find((f) => f.kind === 'response-mapping')!;
    expect(mapping.hypotheses![0]).toMatchObject({
      level: 'strong',
      text: expect.stringContaining('error response (500)'),
    });
  });

  it('reports failed outbound server calls and exceptions from spans as confirmed', () => {
    const span: ServerSpan = {
      id: 't:s',
      traceId: 't',
      spanId: 's',
      name: 'fetch GET http://up/inventory',
      kind: 'client',
      startTime: 1,
      status: 'unset',
      httpStatus: 503,
      httpUrl: 'http://up/inventory',
      httpMethod: 'GET',
      outbound: true,
      attributes: {},
      events: [],
      source: 'next-adapter',
      sessionId: 's',
      origin: 'o',
      redactions: 0,
      phase: 'server fetch',
    };
    const findings = investigatorFindings({ ...base, entries: [], spans: [span] });
    expect(findings[0]).toMatchObject({
      kind: 'server-outbound',
      evidenceLevel: 'confirmed',
      title: expect.stringContaining('/inventory → 503'),
    });
  });
});

describe('OpenAPI validation', () => {
  const doc = parseOpenApi(
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Orders API', version: '1' },
      servers: [{ url: 'https://app.test/api' }],
      paths: {
        '/orders': {
          post: {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } },
            },
            responses: {
              '201': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
              },
              '422': { description: 'invalid' },
            },
          },
        },
        '/orders/{id}': {
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          NewOrder: {
            type: 'object',
            required: ['productId', 'quantity'],
            properties: { productId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
          },
          Order: {
            type: 'object',
            required: ['id', 'items'],
            properties: {
              id: { type: 'string' },
              items: { type: 'array', items: { type: 'object' } },
              coupon: { type: 'string', nullable: true },
            },
          },
        },
      },
    }),
  );

  it('matches templated paths below the server base path', () => {
    expect(findOperation(doc, 'GET', 'https://app.test/api/orders/42')).toMatchObject({
      template: '/orders/{id}',
      params: { id: '42' },
    });
    expect(findOperation(doc, 'DELETE', 'https://app.test/api/orders/42')).toBeNull();
  });

  it('reports exact field paths with expected and actual values', () => {
    const e = entry({
      method: 'POST',
      url: 'https://app.test/api/orders',
      status: 201,
      responseContentType: 'application/json',
      requestContentType: 'application/json',
    });
    const bodies: EntryBodies = {
      id: e.id,
      request: { kind: 'json', text: '{"productId":123,"quantity":0}' },
      response: { kind: 'json', text: '{"id":"o-1","items":null,"coupon":null}' },
    };
    const result = validateEntryAgainstOpenApi(e, bodies, doc);
    expect(result.matched).toBe(true);
    expect(result.issues.map((i) => [i.part, i.path, i.actual])).toEqual([
      ['request.body', '$.productId', '123'],
      ['request.body', '$.quantity', '0'],
      ['response.body', '$.items', 'null'],
    ]);
  });

  it('flags undeclared statuses and path parameter types, and makes no claim for unknown operations', () => {
    const bad = validateEntryAgainstOpenApi(
      entry({ method: 'GET', url: 'https://app.test/api/orders/abc', status: 500 }),
      undefined,
      doc,
    );
    expect(bad.issues.map((i) => i.part)).toEqual(['request.params', 'response.status']);
    const unknown = validateEntryAgainstOpenApi(
      entry({ method: 'GET', url: 'https://app.test/health' }),
      undefined,
      doc,
    );
    expect(unknown).toMatchObject({ matched: false, issues: [] });
  });

  it('rejects YAML and non-OpenAPI documents with a clear message', () => {
    expect(() => parseOpenApi('openapi: 3.0.0')).toThrow(/JSON/);
    expect(() => parseOpenApi('{"swagger":"2.0"}')).toThrow(/OpenAPI 3/);
  });
});

describe('investigation workspace', () => {
  const post = entry({
    id: 'post',
    tabId: 1,
    method: 'POST',
    url: 'https://app.test/api/orders',
    status: 500,
    startedAt: 1000,
    endedAt: 1200,
    requestHeaders: [{ name: 'traceparent', value: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }],
  });
  const spans: ServerSpan[] = [
    {
      id: `${'a'.repeat(32)}:${'c'.repeat(16)}`,
      traceId: 'a'.repeat(32),
      spanId: 'c'.repeat(16),
      name: 'POST /api/orders',
      kind: 'server',
      startTime: 1010,
      endTime: 1190,
      status: 'unset',
      httpStatus: 500,
      outbound: false,
      attributes: {},
      events: [],
      source: 'next-adapter',
      sessionId: 's',
      origin: 'o',
      redactions: 0,
    },
    {
      id: `${'a'.repeat(32)}:${'d'.repeat(16)}`,
      traceId: 'a'.repeat(32),
      spanId: 'd'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      name: 'fetch GET http://up/inventory',
      kind: 'client',
      startTime: 1020,
      endTime: 1100,
      status: 'unset',
      httpStatus: 503,
      httpUrl: 'http://up/inventory',
      outbound: true,
      attributes: {},
      events: [],
      source: 'next-adapter',
      sessionId: 's',
      origin: 'o',
      redactions: 0,
    },
  ];
  const data = (o: Partial<InvestigationData> = {}): InvestigationData => {
    const d: InvestigationData = {
      entries: [post],
      timeline: [tl({ kind: 'click', timestamp: 950, message: 'Clicked <button#create> "Create order"' })],
      connections: [conn()],
      messages: [],
      spans,
      findings: [],
      serverTracingConfigured: true,
      adaptersEnabled: false,
      advancedCapture: false,
      ...o,
    };
    d.findings = investigatorFindings({ ...base, ...d, entries: d.entries, timeline: d.timeline });
    return d;
  };

  it('finds the earliest verified divergence through the shared trace and ranks causes', () => {
    const inv = buildInvestigation({ type: 'request', id: 'post' }, data())!;
    expect(inv.divergence).toMatchObject({
      level: 'confirmed',
      title: expect.stringContaining('/inventory → 503'),
    });
    expect(inv.related.find((r) => r.ref.type === 'span' && r.title.includes('inventory'))!.relation).toBe(
      'explicit',
    );
    expect(inv.causes[0]).toMatchObject({ level: 'confirmed' });
    expect(inv.reproduction[0]).toContain('Click <button#create> "Create order"');
    expect(inv.reproduction.join('\n')).toContain('MUTATION');
    expect(inv.regressionTests.join(' ')).toMatch(/upstream/);
  });

  it('states what is missing when server tracing is not configured', () => {
    const inv = buildInvestigation(
      { type: 'request', id: 'post' },
      data({ spans: [], serverTracingConfigured: false }),
    )!;
    expect(inv.missingEvidence.join(' ')).toMatch(/no server integration is configured/);
    expect(inv.divergence?.ref).toEqual({ type: 'request', id: 'post' });
  });

  it('never marks handler or UI stages as passed without instrumentation', () => {
    const m = msg({ timestamp: 1500 });
    const steps = notificationChecklist(data({ messages: [m] }), { message: m });
    expect(steps.map((s) => [s.stage, s.status])).toEqual([
      ['Realtime connection established', 'observed'],
      ['Server message reached the browser', 'observed'],
      ['Expected event received', 'unknown'],
      ['Payload valid', 'unknown'],
      ['Frontend handler ran', 'not-instrumented'],
      ['UI notification displayed', 'not-instrumented'],
      ['No duplicates or reconnect replays', 'observed'],
    ]);
  });

  it('uses adapter evidence for handler and UI stages and flags duplicate notifications', () => {
    const m = msg({ timestamp: 1500 });
    const d = data({
      messages: [m, msg({ timestamp: 1600 })],
      adaptersEnabled: true,
      timeline: [
        tl({ kind: 'app-signal', timestamp: 1510, message: 'handler-ran', source: 'adapter' }),
        tl({ kind: 'ui-notification', timestamp: 1520, message: 'Order o-1 created' }),
        tl({ kind: 'ui-notification', timestamp: 1620, message: 'Order o-1 created' }),
      ],
    });
    const steps = notificationChecklist(d, { message: m });
    expect(steps.find((s) => s.stage === 'Frontend handler ran')!.status).toBe('observed');
    expect(steps.find((s) => s.stage === 'UI notification displayed')!.status).toBe('observed');
    expect(steps.at(-1)).toMatchObject({ status: 'failed', detail: expect.stringContaining('2 identical') });
  });

  it('produces a redacted bug report', () => {
    const d = data();
    const inv = buildInvestigation({ type: 'request', id: 'post' }, d)!;
    const md = buildBugReportMarkdown({
      investigation: inv,
      title: 'Order creation fails',
      expected: 'Order is created (201)',
      notes: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk',
      environment: {
        extensionVersion: '0.1.0',
        userAgent: 'test',
        origin: 'https://app.test',
        serverTracing: 'next-adapter',
        capturedAt: 0,
      },
      entries: d.entries,
      bodies: new Map([
        ['post', { id: 'post', request: { kind: 'json', text: '{"password":"hunter2","item":1}' } }],
      ]),
      timeline: d.timeline,
      redaction: DEFAULT_SETTINGS.redaction,
    });
    expect(md).toContain('## Earliest verified point of divergence');
    expect(md).toContain('Confirmed by evidence');
    expect(md).not.toContain('hunter2');
    expect(md).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('Playwright draft', () => {
  it('derives locators and comments out mutating steps', () => {
    expect(locatorForClick('Clicked <button#create> "Create order"')).toBe("page.locator('#create')");
    expect(locatorForClick('Clicked <a> "Orders"')).toBe("page.getByRole('link', { name: 'Orders' })");
    const post = entry({
      id: 'p',
      tabId: 1,
      method: 'POST',
      url: 'https://app.test/api/orders',
      status: 500,
      startedAt: 1000,
    });
    const draft = buildPlaywrightDraft({
      target: post,
      entries: [post],
      until: 2000,
      tabId: 1,
      timeline: [
        tl({ kind: 'page-load', timestamp: 100, pageUrl: 'https://app.test/shop', message: '' }),
        tl({ kind: 'click', timestamp: 500, message: 'Clicked <a> "Cart"' }),
        tl({ kind: 'click', timestamp: 950, message: 'Clicked <button#create> "Create order"' }),
      ],
    });
    expect(draft).toContain("await page.goto('https://app.test/shop');");
    expect(draft).toContain("  await page.getByRole('link', { name: 'Cart' }).click();");
    expect(draft).toContain("  // await page.locator('#create').click();");
    expect(draft).toContain('MUTATION');
    expect(draft).not.toMatch(/^\s+await page\.locator\('#create'\)/m);
  });
});
