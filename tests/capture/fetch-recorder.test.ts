import { describe, expect, it } from 'vitest';
import { installFetchRecorder } from '../../src/capture/fetch-recorder';
import { makeContext, tick, waitFor } from '../helpers/recorder';

type Handler = (req: Request) => Promise<Response> | Response;

function setup(handler: Handler, config = {}) {
  const calls: { thisArg: unknown; args: unknown[] }[] = [];
  const original = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    calls.push({ thisArg: this, args: [input, init] });
    try {
      // Browsers resolve relative URLs against the page; Node needs a base.
      const resolved = input instanceof Request ? input : new URL(String(input), 'https://app.test/checkout');
      const req = new Request(resolved, init);
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return Promise.resolve(handler(req));
    } catch (err) {
      return Promise.reject(err);
    }
  } as typeof fetch;
  const target = { fetch: original };
  const helpers = makeContext(config);
  const uninstall = installFetchRecorder(target, helpers.ctx);
  return { target, calls, original, uninstall, ...helpers };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('fetch recorder', () => {
  it('captures a short-lived JSON POST with request and response bodies', async () => {
    const t = setup(() => json({ id: 'o-1', status: 'created' }, 201));
    const res = await t.target.fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: '123', quantity: 2 }),
    });
    // The page still gets a fully readable body.
    expect(await res.json()).toEqual({ id: 'o-1', status: 'created' });
    await waitFor(() => t.ends().length === 1);

    const [start] = t.starts();
    const [end] = t.ends();
    expect(start!.state).toBe('pending');
    expect(start!.id).toBe(end!.id);
    expect(end).toMatchObject({
      source: 'fetch',
      method: 'POST',
      url: 'https://app.test/api/orders',
      state: 'complete',
      status: 201,
      pageId: 'page-1',
    });
    expect(end!.requestBody).toMatchObject({ kind: 'json', text: '{"productId":"123","quantity":2}' });
    expect(end!.responseBody).toMatchObject({ kind: 'json', text: '{"id":"o-1","status":"created"}' });
    expect(end!.endedAt).toBeGreaterThanOrEqual(end!.startedAt);
    expect(end!.requestHeaders).toContainEqual({ name: 'content-type', value: 'application/json' });
    expect(end!.initiatorStack).toBeTruthy();
  });

  it('emits start before end so an in-flight request is persisted early', async () => {
    const t = setup(() => json({}));
    await t.target.fetch('/api/x');
    await waitFor(() => t.ends().length === 1);
    const types = t.messages.map((m) => m.type);
    expect(types.indexOf('network-start')).toBeLessThan(types.indexOf('network-end'));
  });

  it('returns the original promise result and preserves the receiver and arguments', async () => {
    const response = json({ ok: true });
    const t = setup(() => response);
    const init = { method: 'GET' };
    const result = await t.target.fetch.call(globalThis, 'https://other.test/data', init);
    expect(result).toBe(response);
    expect(t.calls[0]!.thisArg).toBe(globalThis);
    expect(t.calls[0]!.args[1]).toBe(init);
  });

  it('records HTTP 4xx/5xx as completed responses without turning them into rejections', async () => {
    const t = setup(() => json({ message: 'Insufficient stock', code: 'OUT_OF_STOCK' }, 422));
    const res = await t.target.fetch('/api/orders', { method: 'POST', body: '{}' });
    expect(res.status).toBe(422);
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({ state: 'complete', status: 422 });
    expect(t.ends()[0]!.responseBody?.text).toContain('OUT_OF_STOCK');
  });

  it('records network failures and rethrows the same error to the page', async () => {
    const failure = new TypeError('Failed to fetch');
    const t = setup(() => {
      throw failure;
    });
    await expect(t.target.fetch('/api/down')).rejects.toBe(failure);
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({
      state: 'error',
      errorName: 'TypeError',
      errorMessage: 'Failed to fetch',
    });
    expect(t.ends()[0]!.status).toBeUndefined();
  });

  it('records aborted requests', async () => {
    const t = setup(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    controller.abort();
    await expect(t.target.fetch('/api/slow', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]!.state).toBe('aborted');
  });

  it('records timeouts from AbortSignal.timeout', async () => {
    const t = setup(() => new Promise<Response>(() => undefined));
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 10));
    await expect(t.target.fetch('/api/slow', { signal })).rejects.toMatchObject({ name: 'TimeoutError' });
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]!.state).toBe('timeout');
  });

  it('truncates large bodies while the page still reads the full body', async () => {
    const big = 'x'.repeat(10_000);
    const t = setup(() => new Response(big, { headers: { 'content-type': 'text/plain' } }), {
      maxBodyBytes: 1024,
    });
    const res = await t.target.fetch('/api/large');
    expect((await res.text()).length).toBe(10_000);
    await waitFor(() => t.ends().length === 1);
    const body = t.ends()[0]!.responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.text!.length).toBeLessThanOrEqual(1024);
    expect(t.ends()[0]!.warnings.join(' ')).toMatch(/truncated/i);
  });

  it('does not read binary or event-stream responses', async () => {
    const t = setup((req) =>
      req.url.endsWith('png')
        ? new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { 'content-type': 'image/png', 'content-length': '4' },
          })
        : new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    const img = await t.target.fetch('/logo.png');
    const sse = await t.target.fetch('/events');
    expect(img.bodyUsed).toBe(false);
    expect(sse.bodyUsed).toBe(false);
    await waitFor(() => t.ends().length === 2);
    const [a, b] = t.ends();
    expect(a!.responseBody).toMatchObject({ kind: 'binary', size: 4 });
    expect(a!.responseBody!.text).toBeUndefined();
    expect(b!.responseBody).toMatchObject({ kind: 'stream' });
  });

  it('stops reading a never-ending stream after the body read timeout', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controllerRef = c;
        c.enqueue(new TextEncoder().encode('partial'));
      },
    });
    const t = setup(() => new Response(stream, { headers: { 'content-type': 'text/plain' } }), {
      bodyReadTimeoutMs: 30,
    });
    await t.target.fetch('/api/stream');
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]!.responseBody).toMatchObject({ text: 'partial', truncated: true });
    expect(t.ends()[0]!.responseBody!.note).toMatch(/Stopped reading/);
    controllerRef?.close();
  });

  it('captures the body of a Request object without disturbing it', async () => {
    let seenBody = '';
    const t = setup(async (req) => {
      seenBody = await req.text();
      return json({});
    });
    const request = new Request('https://app.test/api/items', {
      method: 'PUT',
      body: 'name=a&b=2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    await t.target.fetch(request);
    await waitFor(() => t.ends().length === 1);
    expect(seenBody).toBe('name=a&b=2');
    expect(t.ends()[0]!.method).toBe('PUT');
    expect(t.ends()[0]!.requestBody).toMatchObject({ kind: 'form', text: 'name=a&b=2' });
  });

  it('records redirects', async () => {
    const t = setup(() => {
      const res = json({});
      Object.defineProperty(res, 'redirected', { value: true });
      Object.defineProperty(res, 'url', { value: 'https://app.test/api/v2/items' });
      return res;
    });
    await t.target.fetch('/api/items');
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({ redirected: true, finalUrl: 'https://app.test/api/v2/items' });
  });

  it('does not capture while disabled, and the page is unaffected', async () => {
    const t = setup(() => json({ ok: 1 }), { enabled: false });
    const res = await t.target.fetch('/api/x');
    expect(await res.json()).toEqual({ ok: 1 });
    await tick();
    expect(t.messages).toHaveLength(0);
  });

  it('never breaks the page when capture itself fails', async () => {
    const t = setup(() => json({ ok: 1 }));
    t.ctx.emit = () => {
      throw new Error('bridge exploded');
    };
    const res = await t.target.fetch('/api/x');
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('uninstall restores the original fetch', () => {
    const t = setup(() => json({}));
    t.uninstall();
    expect(t.target.fetch).toBe(t.original);
  });
});
