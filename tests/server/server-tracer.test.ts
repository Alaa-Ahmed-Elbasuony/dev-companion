// Unit tests for the development-only server tracer package (packages/server-tracer).
import { request as httpRequest } from 'node:http';
import type * as NodeHttp from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS package without bundled types for these internals
import { startCollector } from '../../packages/server-tracer/src/collector.js';
// @ts-expect-error plain JS
import { DevCompanionPropagator } from '../../packages/server-tracer/src/propagator.js';
// @ts-expect-error plain JS
import { createRedactor } from '../../packages/server-tracer/src/redact.js';
// @ts-expect-error plain JS
import { SpanBuffer, toRecord } from '../../packages/server-tracer/src/spans.js';
import { disabledReason } from '../../packages/server-tracer/src/index.js';

const fakeSpan = (overrides: Record<string, unknown> = {}) => ({
  name: 'fetch GET https://api.test/items?api_key=k-secret',
  kind: 2,
  spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
  parentSpanContext: { spanId: 'c'.repeat(16) },
  startTime: [1000, 0],
  endTime: [1000, 250_000_000],
  status: { code: 2, message: 'upstream failed with Bearer abcdefghijkl' },
  attributes: {
    'next.span_type': 'AppRender.fetch',
    'http.url': 'https://user:pw@api.test/items?api_key=k-secret&page=2',
    'http.method': 'GET',
    'http.status_code': 503,
    'http.request.header.authorization': 'Bearer abcdefghijkl',
    'http.response.header.x-request-id': 'req-1',
    'db.statement': "SELECT * FROM users WHERE email = 'ada@example.com'",
    'app.password': 'hunter2',
  },
  events: [
    {
      name: 'exception',
      time: [1000, 1],
      attributes: { 'exception.message': 'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghij' },
    },
  ],
  resource: { attributes: { 'service.name': 'web' } },
  ...overrides,
});

describe('server tracer: safety gates', () => {
  it('refuses to run in production, during next build, in Edge, or without opt-in', () => {
    expect(disabledReason({ NODE_ENV: 'production', DEV_COMPANION_TRACING: '1' })).toMatch(/production/);
    expect(disabledReason({ NEXT_PHASE: 'phase-production-build', DEV_COMPANION_TRACING: '1' })).toMatch(
      /build/,
    );
    expect(disabledReason({ NEXT_RUNTIME: 'edge', DEV_COMPANION_TRACING: '1' })).toMatch(/Edge/);
    expect(disabledReason({})).toMatch(/DEV_COMPANION_TRACING/);
    expect(disabledReason({ DEV_COMPANION_TRACING: '1', NODE_ENV: 'development' })).toBeNull();
  });
});

describe('server tracer: span records', () => {
  it('redacts headers, URLs, statuses and events, and drops DB statements by default', () => {
    const rec = toRecord(fakeSpan(), createRedactor(), { source: 'next-adapter' });
    expect(rec).toMatchObject({
      traceId: 'a'.repeat(32),
      parentSpanId: 'c'.repeat(16),
      kind: 'client',
      outbound: true,
      phase: 'server fetch',
      duration: 250,
      status: 'error',
      httpStatus: 503,
      httpMethod: 'GET',
      serviceName: 'web',
    });
    const text = JSON.stringify(rec);
    for (const secret of ['k-secret', 'abcdefghijkl', 'hunter2', 'ada@example.com', 'pw@', 'eyJhbGci']) {
      expect(text).not.toContain(secret);
    }
    expect(rec.attributes['http.response.header.x-request-id']).toBe('req-1');
    expect(rec.attributes['db.statement']).toBeUndefined();
    expect(rec.redactions).toBeGreaterThan(3);
  });

  it('keeps DB statements only when explicitly enabled', () => {
    const rec = toRecord(fakeSpan(), createRedactor(), { source: 'x', captureDbStatements: true });
    expect(rec.attributes['db.statement']).toContain('SELECT');
  });

  it('names node:http client spans by method and URL', () => {
    const rec = toRecord(
      fakeSpan({
        name: 'GET',
        attributes: { 'http.request.method': 'GET', 'url.full': 'http://up/legacy' },
        instrumentationScope: { name: '@opentelemetry/instrumentation-http' },
      }),
      createRedactor(),
      { source: 'x' },
    );
    expect(rec).toMatchObject({ name: 'GET http://up/legacy', phase: 'server http request (node:http)' });
  });

  it('buffers spans with a cursor, attaches bodies at read time and bounds memory', () => {
    const buffer = new SpanBuffer({ max: 3 });
    for (let i = 1; i <= 5; i++) buffer.push({ spanId: `s${i}`, traceId: 't' });
    buffer.setBody('s5', { response: { text: '{}' } });
    const page = buffer.since(0, 10);
    expect(page.spans.map((s: { spanId: string }) => s.spanId)).toEqual(['s3', 's4', 's5']);
    expect(page.spans[2].body).toEqual({ response: { text: '{}' } });
    expect(buffer.dropped).toBe(2);
    expect(buffer.since(page.cursor).spans).toEqual([]);
    expect(buffer.since(3, 1)).toMatchObject({ cursor: 4, more: true });
  });
});

describe('server tracer: propagation', () => {
  it('injects only into array carriers (Next.js meta tags) unless outbound propagation is enabled', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(new URL('../../packages/server-tracer/package.json', import.meta.url));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { context, trace } = req('@opentelemetry/api') as any;
    const ctx = trace.setSpanContext(context.active(), {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
    });
    const headers: Record<string, string> = {};
    const entries: { key: string; value: string }[] = [];
    const setter = {
      set: (carrier: unknown, key: string, value: string) => {
        if (Array.isArray(carrier)) carrier.push({ key, value });
        else (carrier as Record<string, string>)[key] = value;
      },
    };
    const p = new DevCompanionPropagator();
    p.inject(ctx, headers, setter);
    p.inject(ctx, entries, setter);
    expect(headers).toEqual({});
    expect(entries[0]).toEqual({ key: 'traceparent', value: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` });
    new DevCompanionPropagator({ propagateToOutbound: true }).inject(ctx, headers, setter);
    expect(headers.traceparent).toBeDefined();
  });
});

describe('server tracer: collector', () => {
  const buffer = new SpanBuffer();
  buffer.push({ spanId: 'x', traceId: 't', name: 'GET /orders' });
  let port = 0;
  let close: () => void = () => undefined;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  it('starts on loopback', async () => {
    const server = await startCollector({ port: 0, token: 't'.repeat(48), buffer, service: 'test' });
    port = (server.address() as AddressInfo).port;
    close = () => server.close();
  });

  it('requires the bearer token', async () => {
    expect((await get('/v1/spans')).status).toBe(401);
    expect((await get('/v1/spans', { authorization: 'Bearer wrong' })).status).toBe(401);
    const ok = await get('/v1/spans', { authorization: `Bearer ${'t'.repeat(48)}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ service: 'test', spans: [{ spanId: 'x' }], cursor: 1 });
  });

  it('rejects web pages and DNS-rebinding hosts, and allows extension origins', async () => {
    const auth = { authorization: `Bearer ${'t'.repeat(48)}` };
    expect((await get('/v1/spans', { ...auth, origin: 'https://evil.test' })).status).toBe(403);
    expect((await get('/v1/spans', { ...auth, host: 'evil.test' })).status).toBe(403);
    const ext = await get('/v1/health', { ...auth, origin: 'chrome-extension://abc' });
    expect(ext.status).toBe(200);
    expect(ext.headers['access-control-allow-origin']).toBe('chrome-extension://abc');
  });

  afterAll(() => close());
});

describe('server tracer: in-process registration', () => {
  it('records outbound fetch and node:http spans with redacted bodies, without altering requests', async () => {
    const seen: { auth?: string; traceparent?: string }[] = [];
    const upstream = createServer((req, res) => {
      seen.push({
        auth: req.headers.authorization,
        traceparent: String(req.headers.traceparent ?? '') || undefined,
      });
      res.writeHead(req.url === '/fail' ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: req.url !== '/fail', accessToken: 'tok-upstream-secret' }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const env = { ...process.env };
    process.env.DEV_COMPANION_TRACING = '1';
    process.env.NODE_ENV = 'test';
    process.env.DEV_COMPANION_TOKEN = 'x'.repeat(40);
    const tracer = await import('../../packages/server-tracer/src/index.js');
    const result = await tracer.register({ port: 0 as never, log: false, serviceName: 'unit' });
    try {
      expect(result.enabled).toBe(true);
      const res = await fetch(`${base}/ok`, {
        method: 'POST',
        headers: { authorization: 'Bearer upstream-secret-abc123' },
        body: JSON.stringify({ password: 'p@ss', item: 'kbd' }),
      });
      expect(await res.json()).toEqual({ ok: true, accessToken: 'tok-upstream-secret' }); // the app sees the real body
      expect((await fetch(`${base}/fail`)).status).toBe(503);
      // Read http.request at call time (vitest snapshots ESM named imports of builtins).
      const { createRequire } = await import('node:module');
      const nodeHttp = createRequire(import.meta.url)('node:http') as typeof NodeHttp;
      await new Promise<void>((resolve) => {
        nodeHttp
          .request(`${base}/legacy`, (r) => {
            r.resume();
            r.on('end', () => resolve());
          })
          .end();
      });
      await new Promise((r) => setTimeout(r, 100));
      const state = (
        globalThis as unknown as Record<symbol, { buffer: InstanceType<typeof SpanBuffer> } | undefined>
      )[Symbol.for('dev-companion.server-tracer')];
      const spans = state!.buffer.since(0, 100).spans as {
        name: string;
        httpStatus?: number;
        body?: unknown;
        phase?: string;
      }[];
      const names = spans.map((s) => `${s.phase}: ${s.name} ${s.httpStatus ?? ''}`.trim());
      expect(names).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/server fetch: fetch POST .*\/ok 200/),
          expect.stringMatching(/server fetch: fetch GET .*\/fail 503/),
          expect.stringMatching(/node:http.*GET .*\/legacy 200/),
        ]),
      );
      const text = JSON.stringify(spans);
      expect(text).not.toContain('upstream-secret-abc123');
      expect(text).not.toContain('tok-upstream-secret');
      expect(text).not.toContain('p@ss');
      const posted = spans.find((s) => s.name.endsWith('/ok')) as { body?: { request?: { text: string } } };
      expect(posted.body?.request?.text).toBe('{"password":"[REDACTED]","item":"kbd"}');
      // Requests reached the upstream unmodified: credentials intact, no injected trace headers.
      expect(seen.every((s) => !s.traceparent)).toBe(true);
      expect(seen[0]!.auth).toBe('Bearer upstream-secret-abc123');
    } finally {
      await tracer.shutdown();
      upstream.close();
      process.env = env;
    }
  });
});
