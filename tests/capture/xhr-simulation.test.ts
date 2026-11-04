// @vitest-environment jsdom
// XHR simulation against jsdom's XMLHttpRequest (real on* handlers, prototype
// accessors and timeout timer). A local server counts the requests it receives,
// so "never sent" is checked where it matters. Synthetic-only tests use fake
// timers; tests that reach the network use real timers.
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installFetchRecorder } from '../../src/capture/fetch-recorder';
import { ARMED_WAIT_MS } from '../../src/capture/simulate';
import { installXhrRecorder } from '../../src/capture/xhr-recorder';
import { SIMULATION_LEASE_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import type { CaptureConfig, NetworkDraft } from '../../src/shared/types';
import { FakeXHR } from '../helpers/fake-xhr';
import { makeContext } from '../helpers/recorder';

// ---- local server ---------------------------------------------------------------

let server: Server;
let origin = '';
const hits: string[] = [];
const hitCount = (path: string) => hits.filter((h) => h.endsWith(` ${path}`)).length;
const lastHeaders: Record<string, Record<string, string | string[] | undefined>> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    res.setHeader('access-control-allow-origin', String(req.headers.origin ?? '*'));
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'x-test, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    hits.push(`${req.method} ${path}`);
    lastHeaders[path] = req.headers;
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ real: true, path }));
    };
    if (path.startsWith('/api/slow')) setTimeout(reply, 200);
    else reply();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ---- setup ------------------------------------------------------------------------

function rules(...raw: Record<string, unknown>[]) {
  return normalizeSimulationRules(
    raw.map((r, i) => ({
      id: `r${i + 1}`,
      name: `rule ${i + 1}`,
      enabled: true,
      match: { methods: [], urlPattern: '/api/*' },
      action: { kind: 'mock', status: 200, headers: [], body: '{"mocked":true}', bodyKind: 'json' },
      ...r,
    })),
  );
}

const uninstalls: (() => void)[] = [];
afterEach(() => {
  while (uninstalls.length) uninstalls.pop()!();
  vi.useRealTimers();
  hits.length = 0;
});

function setup(
  simRules: ReturnType<typeof rules> | undefined,
  opts: { armed?: boolean; random?: () => number } = {},
) {
  const t = makeContext({
    simulation: simRules ? { rules: simRules, leaseUntil: Date.now() + SIMULATION_LEASE_MS } : undefined,
  });
  t.ctx.pageUrl = () => `${origin}/app`;
  const listeners: ((c: CaptureConfig) => void)[] = [];
  t.ctx.onConfig = (fn) => listeners.push(fn);
  t.ctx.random = opts.random ?? (() => 0);
  let configure: () => void = () => undefined;
  if (opts.armed) {
    t.ctx.simulationArmed = true;
    const configured = new Promise<void>((resolve) => (configure = resolve));
    t.ctx.whenConfigured = () => configured;
  }
  uninstalls.push(installXhrRecorder(window, t.ctx));
  const pushConfig = (c: Partial<CaptureConfig>) => {
    t.setConfig(c);
    listeners.forEach((fn) => fn(t.ctx.config()));
    configure();
  };
  return { ...t, pushConfig };
}

const EVENTS = ['loadstart', 'readystatechange', 'progress', 'load', 'error', 'timeout', 'abort', 'loadend'];

/** An XHR that logs "event:readyState" for every event, via listeners. */
function watched(method = 'GET', path = '/api/items') {
  const xhr = new XMLHttpRequest();
  const log: string[] = [];
  for (const type of EVENTS) xhr.addEventListener(type, () => log.push(`${type}:${xhr.readyState}`));
  xhr.open(method, `${origin}${path}`);
  // open() itself fires readystatechange (UNSENT -> OPENED); only the request's events are of interest.
  log.length = 0;
  return { xhr, log };
}

/** Lets 0 ms timers and microtasks settle under fake timers. */
async function settle() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

async function until(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const endFor = (t: ReturnType<typeof setup>, path: string): NetworkDraft | undefined =>
  t.ends().find((d) => new URL(d.url).pathname === path);

// ---- mocked responses ------------------------------------------------------------------

describe('XHR simulation: mocked responses', () => {
  it('dispatches the native event sequence with readyState transitions and handler properties', async () => {
    vi.useFakeTimers();
    setup(
      rules({
        action: {
          kind: 'mock',
          status: 201,
          statusText: 'Created',
          headers: [
            { name: 'X-Request-Id', value: 'abc' },
            { name: 'set-cookie', value: 'secret=1' },
          ],
          body: '{"id":7}',
        },
      }),
    );
    const { xhr, log } = watched('POST', '/api/orders');
    const handlers: string[] = [];
    xhr.onloadstart = () => handlers.push('onloadstart');
    xhr.onreadystatechange = () => handlers.push(`onreadystatechange:${xhr.readyState}`);
    xhr.onprogress = (e) => handlers.push(`onprogress:${e.loaded}/${e.total}`);
    xhr.onload = () => handlers.push('onload');
    xhr.onloadend = () => handlers.push('onloadend');
    xhr.onerror = () => handlers.push('onerror');
    xhr.send('{"q":1}');
    expect(xhr.readyState).toBe(1);
    expect(xhr.status).toBe(0);
    await settle();

    expect(log).toEqual([
      'loadstart:1',
      'readystatechange:2',
      'readystatechange:3',
      'progress:3',
      'readystatechange:4',
      'load:4',
      'loadend:4',
    ]);
    expect(handlers).toEqual([
      'onloadstart',
      'onreadystatechange:2',
      'onreadystatechange:3',
      'onprogress:8/8',
      'onreadystatechange:4',
      'onload',
      'onloadend',
    ]);
    expect(xhr.status).toBe(201);
    expect(xhr.statusText).toBe('Created');
    expect(xhr.responseText).toBe('{"id":7}');
    expect(xhr.response).toBe('{"id":7}');
    expect(xhr.responseURL).toBe(`${origin}/api/orders`);
    expect(xhr.getResponseHeader('x-request-id')).toBe('abc');
    expect(xhr.getResponseHeader('X-REQUEST-ID')).toBe('abc');
    expect(xhr.getResponseHeader('set-cookie')).toBeNull();
    expect(xhr.getResponseHeader('missing')).toBeNull();
    expect(xhr.getAllResponseHeaders()).toBe('content-type: application/json\r\nx-request-id: abc\r\n');
    expect(hits).toEqual([]);
  });

  it('skips LOADING for an empty body', async () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'mock', status: 204, body: '' } }));
    const { xhr, log } = watched();
    xhr.send();
    await settle();
    expect(log).toEqual([
      'loadstart:1',
      'readystatechange:2',
      'progress:2',
      'readystatechange:4',
      'load:4',
      'loadend:4',
    ]);
    expect(xhr.status).toBe(204);
    expect(xhr.responseText).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('returns text bodies with a text content type', async () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'mock', status: 200, body: 'plain', bodyKind: 'text' } }));
    const { xhr } = watched();
    xhr.send();
    await settle();
    expect(xhr.responseText).toBe('plain');
    expect(xhr.getResponseHeader('content-type')).toBe('text/plain;charset=UTF-8');
  });

  it('honors responseType json, including invalid JSON', async () => {
    vi.useFakeTimers();
    setup(
      rules(
        { match: { urlPattern: '/api/good' }, action: { kind: 'mock', status: 200, body: '{"a":[1,2]}' } },
        { match: { urlPattern: '/api/bad' }, action: { kind: 'mock', status: 200, body: '{nope' } },
      ),
    );
    const good = watched('GET', '/api/good').xhr;
    good.responseType = 'json';
    const bad = watched('GET', '/api/bad').xhr;
    bad.responseType = 'json';
    good.send();
    bad.send();
    await settle();
    expect(good.response).toEqual({ a: [1, 2] });
    expect(good.response).toBe(good.response);
    expect(() => good.responseText).toThrow(DOMException);
    expect(bad.response).toBeNull();
  });

  it('honors responseType arraybuffer and blob', async () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'mock', status: 200, body: 'héllo', bodyKind: 'text' } }));
    const buf = watched().xhr;
    buf.responseType = 'arraybuffer';
    const blob = watched().xhr;
    blob.responseType = 'blob';
    buf.send();
    blob.send();
    await settle();
    expect(new TextDecoder().decode(buf.response as ArrayBuffer)).toBe('héllo');
    expect((blob.response as Blob).size).toBe(6);
    expect((blob.response as Blob).type).toBe('text/plain;charset=utf-8');
  });

  it('reports nothing before headers arrive', () => {
    vi.useFakeTimers();
    setup(rules({ delayMs: 1000 }));
    const { xhr } = watched();
    xhr.send();
    expect(xhr.readyState).toBe(1);
    expect(xhr.status).toBe(0);
    expect(xhr.responseText).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('applies the delay before the response', async () => {
    vi.useFakeTimers();
    setup(rules({ delayMs: 2000 }));
    const { xhr, log } = watched();
    xhr.send();
    await vi.advanceTimersByTimeAsync(1999);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.at(-1)).toBe('loadend:4');
    expect(xhr.status).toBe(200);
  });
});

// ---- failures ------------------------------------------------------------------------------

describe('XHR simulation: failures', () => {
  it('network error: readystatechange, error, loadend; status 0; nothing sent', async () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'fail', mode: 'network-error' } }));
    const { xhr, log } = watched();
    const onerror = vi.fn();
    xhr.onerror = onerror;
    xhr.send();
    await settle();
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'error:4', 'loadend:4']);
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(xhr.status).toBe(0);
    expect(xhr.responseText).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
    expect(hits).toEqual([]);
  });

  it('timeout action: fires timeout after the delay plus the timeout', async () => {
    vi.useFakeTimers();
    setup(rules({ delayMs: 500, action: { kind: 'fail', mode: 'timeout', timeoutMs: 4000 } }));
    const { xhr, log } = watched();
    const ontimeout = vi.fn();
    xhr.ontimeout = ontimeout;
    xhr.send();
    await vi.advanceTimersByTimeAsync(4499);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'timeout:4', 'loadend:4']);
    expect(ontimeout).toHaveBeenCalledTimes(1);
    expect(xhr.readyState).toBe(4);
  });

  it('hang: stays pending until aborted', async () => {
    vi.useFakeTimers();
    const r = rules({ action: { kind: 'fail', mode: 'hang' } });
    const t = setup(r);
    const { xhr, log } = watched();
    const onabort = vi.fn();
    xhr.onabort = onabort;
    xhr.send();
    // Ten minutes while the bridge keeps renewing the lease (every 20 s).
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      t.pushConfig({ simulation: { rules: r, leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
    }
    expect(log).toEqual([]);
    expect(xhr.readyState).toBe(1);
    xhr.abort();
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
    expect(xhr.readyState).toBe(0);
    expect(onabort).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveLength(4);
    expect(hits).toEqual([]);
  });
});

// ---- abort and timeout edge cases ----------------------------------------------------------

describe('XHR simulation: abort and timeout', () => {
  it('abort() during a delay ends the request once; the mock is never delivered', async () => {
    vi.useFakeTimers();
    setup(rules({ delayMs: 3000 }));
    const { xhr, log } = watched();
    xhr.send();
    await vi.advanceTimersByTimeAsync(1000);
    xhr.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
    expect(xhr.readyState).toBe(0);
    expect(xhr.status).toBe(0);
  });

  it('abort() from a handler during delivery stops the sequence', async () => {
    vi.useFakeTimers();
    setup(rules({}));
    const { xhr, log } = watched();
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState === 2) xhr.abort();
    });
    xhr.send();
    await settle();
    expect(log).toEqual(['loadstart:1', 'readystatechange:2', 'readystatechange:4', 'abort:4', 'loadend:4']);
    expect(xhr.readyState).toBe(0);
  });

  it('abort() after completion resets to UNSENT without events', async () => {
    vi.useFakeTimers();
    setup(rules({}));
    const { xhr, log } = watched();
    xhr.send();
    await settle();
    const count = log.length;
    xhr.abort();
    expect(log).toHaveLength(count);
    expect(xhr.readyState).toBe(0);
    expect(xhr.status).toBe(0);
    expect(xhr.responseText).toBe('');
  });

  it('xhr.timeout during a delay fires timeout; the mock is never delivered', async () => {
    vi.useFakeTimers();
    setup(rules({ delayMs: 5000 }));
    const { xhr, log } = watched();
    xhr.timeout = 1000;
    xhr.send();
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'timeout:4', 'loadend:4']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toHaveLength(4);
  });

  it('xhr.timeout during a hang fires timeout', async () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const { xhr, log } = watched();
    xhr.timeout = 250;
    xhr.send();
    await vi.advanceTimersByTimeAsync(250);
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'timeout:4', 'loadend:4']);
  });
});

// ---- state rules and reuse --------------------------------------------------------------------

describe('XHR simulation: state rules and reuse', () => {
  it('send() and setRequestHeader() throw InvalidStateError while a simulated request is in flight', () => {
    vi.useFakeTimers();
    setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const { xhr } = watched();
    xhr.send();
    expect(() => xhr.send()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(() => xhr.setRequestHeader('x-test', '1')).toThrow(
      expect.objectContaining({ name: 'InvalidStateError' }),
    );
  });

  it('send() throws after a simulated completion until open() is called again', async () => {
    vi.useFakeTimers();
    setup(rules({}));
    const { xhr } = watched();
    xhr.send();
    await settle();
    expect(() => xhr.send()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
  });

  it('reusing the object after a mock: open() fires readystatechange and restores the native state', async () => {
    setup(rules({ match: { urlPattern: '/api/mocked' } }));
    const { xhr, log } = watched('GET', '/api/mocked');
    xhr.send();
    await until(() => log.includes('loadend:4'));
    log.length = 0;
    xhr.open('GET', `${origin}/api/real`);
    expect(log).toEqual(['readystatechange:1']);
    expect(xhr.readyState).toBe(1);
    expect(xhr.status).toBe(0);
    expect(Object.getOwnPropertyNames(xhr)).not.toContain('status');
    xhr.send();
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(JSON.parse(xhr.responseText)).toEqual({ real: true, path: '/api/real' });
    expect(hits).toEqual(['GET /api/real']);
  });

  it('open() while a simulated request is held ends it silently and records it as aborted', async () => {
    const t = setup(rules({ match: { urlPattern: '/api/held' }, action: { kind: 'fail', mode: 'hang' } }));
    const { xhr, log } = watched('GET', '/api/held');
    xhr.send();
    await new Promise((r) => setTimeout(r, 20));
    xhr.open('GET', `${origin}/api/next`);
    expect(log).toEqual([]);
    xhr.send();
    await until(() => log.includes('loadend:4'));
    expect(log.filter((e) => e === 'loadend:4')).toHaveLength(1);
    expect(xhr.status).toBe(200);
    await until(() => t.ends().length === 2);
    expect(endFor(t, '/api/held')).toMatchObject({
      state: 'aborted',
      errorMessage: 'open() was called again before this request completed',
    });
    expect(endFor(t, '/api/next')).toMatchObject({ state: 'complete', status: 200 });
    expect(hits).toEqual(['GET /api/next']);
  });

  it('a native request reused from its own onload handler is recorded with its own response', async () => {
    const t = setup(undefined);
    const xhr = new XMLHttpRequest();
    let second = false;
    xhr.onload = () => {
      if (second) return;
      second = true;
      xhr.open('GET', `${origin}/api/second`);
      xhr.send();
    };
    xhr.open('GET', `${origin}/api/first`);
    xhr.send();
    await until(() => t.ends().length === 2);
    expect(endFor(t, '/api/first')).toMatchObject({ state: 'complete', status: 200 });
    expect(endFor(t, '/api/first')!.responseBody?.text).toContain('/api/first');
    expect(endFor(t, '/api/second')!.responseBody?.text).toContain('/api/second');
  });

  it('a native request abandoned by open() is recorded as aborted, not with the next response', async () => {
    const t = setup(undefined);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${origin}/api/slow`);
    xhr.send();
    xhr.open('GET', `${origin}/api/fast`);
    xhr.send();
    await until(() => t.ends().length === 2);
    expect(endFor(t, '/api/slow')).toMatchObject({ state: 'aborted' });
    expect(endFor(t, '/api/fast')).toMatchObject({ state: 'complete' });
    expect(endFor(t, '/api/fast')!.responseBody?.text).toContain('/api/fast');
  });

  it('synchronous requests always pass through unchanged', () => {
    const host = { XMLHttpRequest: class extends FakeXHR {} as unknown as typeof XMLHttpRequest };
    const t = makeContext({ simulation: { rules: rules({}), leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
    uninstalls.push(installXhrRecorder(host, t.ctx));
    const seen: string[] = [];
    FakeXHR.handler = (req) => {
      seen.push(req.url);
      return { status: 200, body: 'real' };
    };
    const xhr = new host.XMLHttpRequest();
    xhr.open('GET', '/api/items', false);
    xhr.send();
    expect(seen).toEqual(['/api/items']);
    const explicitUndefined = new host.XMLHttpRequest();
    explicitUndefined.open('GET', '/api/items', undefined as unknown as boolean);
    explicitUndefined.send();
    expect(seen).toHaveLength(2);
  });
});

// ---- delays and the real network ---------------------------------------------------------------

describe('XHR simulation: delays', () => {
  it('sends the real request after the delay, with headers and credentials, firing loadstart once', async () => {
    const t = setup(rules({ action: { kind: 'delay' }, delayMs: 80 }));
    const { xhr, log } = watched('POST', '/api/delayed');
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-test', 'yes');
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.send('{"a":1}');
    await new Promise((r) => setTimeout(r, 40));
    expect(hitCount('/api/delayed')).toBe(0);
    await until(() => log.includes('loadend:4'));
    expect(hitCount('/api/delayed')).toBe(1);
    expect(lastHeaders['/api/delayed']!['x-test']).toBe('yes');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.status).toBe(200);
    expect(log.filter((e) => e.startsWith('loadstart'))).toHaveLength(1);
    await until(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({
      state: 'complete',
      status: 200,
      simulated: { action: 'delay', sent: true },
    });
  });

  it('counts the page timeout from send(): the delay uses up part of it', async () => {
    // 150 ms delay + 200 ms server time > 250 ms timeout.
    setup(rules({ action: { kind: 'delay' }, delayMs: 150, match: { urlPattern: '/api/slow' } }));
    const { xhr, log } = watched('GET', '/api/slow');
    xhr.timeout = 250;
    const started = Date.now();
    xhr.send();
    await until(() => log.includes('loadend:4'));
    expect(log).toContain('timeout:4');
    expect(Date.now() - started).toBeLessThan(330);
    expect(xhr.timeout).toBe(250);
    xhr.open('GET', `${origin}/api/x`);
    expect(xhr.timeout).toBe(250);
  });
});

// ---- failure patterns, sensitive endpoints, kill switch -------------------------------------------

describe('XHR simulation: rules', () => {
  it('first-N counts fetch and XHR requests together', async () => {
    const t = setup(
      rules({ action: { kind: 'fail', mode: 'network-error' }, pattern: { kind: 'first-n', n: 1 } }),
    );
    const page = { fetch: vi.fn(async () => new Response('{}')) as unknown as typeof fetch };
    installFetchRecorder(page, t.ctx);
    await expect(page.fetch(`${origin}/api/items`)).rejects.toThrow('Failed to fetch');
    const { xhr, log } = watched();
    xhr.send();
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(hitCount('/api/items')).toBe(1);
  });

  it('every-Nth and random patterns pass the other requests to the network', async () => {
    setup(rules({ action: { kind: 'fail', mode: 'network-error' }, pattern: { kind: 'every-nth', n: 2 } }));
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { xhr, log } = watched();
      xhr.send();
      await until(() => log.includes('loadend:4'));
      results.push(xhr.status);
    }
    expect(results).toEqual([200, 0, 200, 0]);
    expect(hitCount('/api/items')).toBe(2);
  });

  it('a random rule applies when the draw is below the percentage', async () => {
    let draw = 0.1;
    setup(
      rules({ action: { kind: 'fail', mode: 'network-error' }, pattern: { kind: 'random', percent: 30 } }),
      {
        random: () => draw,
      },
    );
    const failed = watched();
    failed.xhr.send();
    await until(() => failed.log.includes('loadend:4'));
    expect(failed.log).toContain('error:4');
    draw = 0.5;
    const passed = watched();
    passed.xhr.send();
    await until(() => passed.log.includes('loadend:4'));
    expect(passed.xhr.status).toBe(200);
  });

  it('authentication requests pass through a broad rule unless it allows them', async () => {
    setup(rules({ action: { kind: 'fail', mode: 'network-error' } }));
    const { xhr, log } = watched('POST', '/api/auth/login');
    xhr.send('{}');
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(hitCount('/api/auth/login')).toBe(1);
  });

  it('switching simulation off sends held requests to the network', async () => {
    const t = setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const { xhr, log } = watched();
    xhr.send();
    await new Promise((r) => setTimeout(r, 20));
    expect(hits).toEqual([]);
    t.pushConfig({ simulation: undefined });
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(hitCount('/api/items')).toBe(1);
    expect(log.filter((e) => e.startsWith('loadstart'))).toHaveLength(1);
    await until(() => t.ends().length === 1);
    expect(t.ends()[0]!.simulated).toMatchObject({ action: 'hang', sent: true });
    expect(t.ends()[0]!.warnings.some((w) => w.includes('switched off'))).toBe(true);
  });

  it('a lease that runs out without renewal sends held requests to the network', async () => {
    const r = rules({ action: { kind: 'fail', mode: 'hang' } });
    const t = setup(r);
    t.pushConfig({ simulation: { rules: r, leaseUntil: Date.now() + 150 } });
    const { xhr, log } = watched();
    xhr.send();
    await new Promise((res) => setTimeout(res, 20));
    expect(hits).toEqual([]);
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(hitCount('/api/items')).toBe(1);
    await until(() => t.ends().length === 1);
    expect(t.ends()[0]!.simulated).toMatchObject({ action: 'hang', sent: true });
  });
});

describe('XHR simulation: request URL', () => {
  it('resolves relative URLs against the document base URL, as the browser does', async () => {
    const t = setup(rules({ match: { methods: [], urlPattern: '/v2/*' } }));
    t.ctx.baseUrl = () => `${origin}/v2/`; // <base href=".../v2/">
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'items');
    xhr.send();
    await until(() => xhr.readyState === 4);
    expect(xhr.responseText).toBe('{"mocked":true}');
    expect(xhr.responseURL).toBe(`${origin}/v2/items`);
    expect(hits).toEqual([]);
    await until(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({ url: `${origin}/v2/items`, simulated: { action: 'mock' } });
  });
});

// ---- inactive simulation and the startup gate --------------------------------------------------------

describe('XHR simulation: inactive and startup', () => {
  it('without rules, send() reaches the network synchronously and nothing is shadowed', async () => {
    setup(undefined);
    const { xhr, log } = watched();
    xhr.send();
    expect(Object.getOwnPropertyNames(xhr)).toEqual([]);
    await until(() => log.includes('loadend:4'));
    expect(hitCount('/api/items')).toBe(1);
    expect(Object.getOwnPropertyNames(xhr)).toEqual([]);
  });

  it('holds startup requests on armed pages until the rules arrive, then simulates them', async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { armed: true });
    const { xhr, log } = watched();
    xhr.send();
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual([]);
    t.pushConfig({
      simulation: {
        rules: rules({ action: { kind: 'mock', status: 418, body: '' } }),
        leaseUntil: Date.now() + SIMULATION_LEASE_MS,
      },
    });
    await settle();
    expect(xhr.status).toBe(418);
    expect(hits).toEqual([]);
  });

  it('sends held startup requests unchanged when the config has no rules', async () => {
    const t = setup(undefined, { armed: true });
    const { xhr, log } = watched();
    xhr.send();
    t.pushConfig({ simulation: undefined });
    await until(() => log.includes('loadend:4'));
    expect(xhr.status).toBe(200);
    expect(log.filter((e) => e.startsWith('loadstart'))).toHaveLength(1);
  });

  it('sends with a note when the rules do not arrive in time', async () => {
    const t = setup(undefined, { armed: true });
    const { xhr, log } = watched();
    xhr.send();
    await until(() => log.includes('loadend:4'), ARMED_WAIT_MS + 2000);
    expect(xhr.status).toBe(200);
    await until(() => t.ends().length === 1);
    expect(t.ends()[0]!.warnings[0]).toContain('did not arrive in time');
  });

  it('abort() while held at startup ends the request without sending it', async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { armed: true });
    const { xhr, log } = watched();
    xhr.send();
    xhr.abort();
    expect(log).toEqual(['loadstart:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
    t.pushConfig({ simulation: undefined });
    await settle();
    expect(log).toHaveLength(4);
    expect(hits).toEqual([]);
  });
});

// ---- recording -------------------------------------------------------------------------------------

describe('XHR simulation: recording', () => {
  it('records mocks, failures, timeouts and aborts with the simulated marker', async () => {
    vi.useFakeTimers();
    const t = setup(
      rules(
        { match: { urlPattern: '/api/mock' }, action: { kind: 'mock', status: 503, body: '{"e":1}' } },
        { match: { urlPattern: '/api/err' }, action: { kind: 'fail', mode: 'network-error' } },
        { match: { urlPattern: '/api/to' }, action: { kind: 'fail', mode: 'timeout', timeoutMs: 100 } },
        { match: { urlPattern: '/api/hang' }, action: { kind: 'fail', mode: 'hang' } },
      ),
    );
    const mock = watched('POST', '/api/mock').xhr;
    mock.send('{"q":1}');
    watched('GET', '/api/err').xhr.send();
    watched('GET', '/api/to').xhr.send();
    const hang = watched('GET', '/api/hang').xhr;
    hang.send();
    await vi.advanceTimersByTimeAsync(100);
    hang.abort();
    await settle();

    expect(endFor(t, '/api/mock')).toMatchObject({
      source: 'xhr',
      state: 'complete',
      status: 503,
      simulated: { ruleId: 'r1', action: 'mock', sent: false },
      responseBody: { kind: 'json', text: '{"e":1}' },
      requestBody: { text: '{"q":1}' },
    });
    expect(endFor(t, '/api/mock')!.responseHeaders).toContainEqual({
      name: 'content-type',
      value: 'application/json',
    });
    expect(endFor(t, '/api/mock')!.warnings.some((w) => w.startsWith('Simulated by rule "rule 1"'))).toBe(
      true,
    );
    expect(endFor(t, '/api/err')).toMatchObject({ state: 'error', simulated: { action: 'network-error' } });
    expect(endFor(t, '/api/to')).toMatchObject({ state: 'timeout', simulated: { action: 'timeout' } });
    expect(endFor(t, '/api/hang')).toMatchObject({ state: 'aborted', simulated: { action: 'hang' } });
    expect(t.starts().find((d) => d.url.endsWith('/api/mock'))!.simulated).toMatchObject({ action: 'mock' });
    expect(hits).toEqual([]);
  });
});
