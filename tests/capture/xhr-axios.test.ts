// @vitest-environment jsdom
// Axios (XHR adapter) against simulated XHR responses.
import axios from 'axios';
import type { AxiosError } from 'axios';
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installXhrRecorder } from '../../src/capture/xhr-recorder';
import { SIMULATION_LEASE_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import { makeContext } from '../helpers/recorder';

let server: Server;
let origin = '';
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"real":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  hits = 0;
});

function simulate(...raw: Record<string, unknown>[]) {
  const rules = normalizeSimulationRules(
    raw.map((r, i) => ({ id: `r${i}`, name: `rule ${i}`, enabled: true, ...r })),
  );
  const t = makeContext({ simulation: { rules, leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
  t.ctx.pageUrl = () => `${origin}/app`;
  uninstall = installXhrRecorder(window, t.ctx);
  return t;
}

const get = (path: string, extra: Record<string, unknown> = {}) =>
  axios.request({ url: `${origin}${path}`, method: 'get', adapter: 'xhr', ...extra });

async function rejection(p: Promise<unknown>): Promise<AxiosError> {
  try {
    await p;
  } catch (err) {
    return err as AxiosError;
  }
  throw new Error('expected the request to fail');
}

const mock = (path: string, status: number, body: string, headers: unknown[] = []) => ({
  match: { methods: [], urlPattern: path },
  action: { kind: 'mock', status, headers, body, bodyKind: 'json' },
});

describe('Axios (XHR adapter) with simulated responses', () => {
  it('resolves a mocked success with parsed JSON and headers', async () => {
    simulate(mock('/api/items', 200, '{"items":[1,2]}', [{ name: 'x-total', value: '2' }]));
    const res = await get('/api/items');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ items: [1, 2] });
    expect(res.headers['x-total']).toBe('2');
    expect(hits).toBe(0);
  });

  it('rejects a mocked 500 with the response attached', async () => {
    simulate(mock('/api/items', 500, '{"error":"boom"}'));
    const err = await rejection(get('/api/items'));
    expect(err.response?.status).toBe(500);
    expect(err.response?.data).toEqual({ error: 'boom' });
    expect(err.code).toBe('ERR_BAD_RESPONSE');
    expect(hits).toBe(0);
  });

  it('rejects mocked 401 and 403 responses with the API error message', async () => {
    simulate(
      mock('/api/me', 401, '{"message":"Session expired"}'),
      mock('/api/admin', 403, '{"message":"Not allowed"}'),
    );
    const unauthorized = await rejection(get('/api/me'));
    expect(unauthorized.response?.status).toBe(401);
    expect(unauthorized.response?.data).toEqual({ message: 'Session expired' });
    expect(unauthorized.code).toBe('ERR_BAD_REQUEST');
    const forbidden = await rejection(get('/api/admin'));
    expect(forbidden.response?.status).toBe(403);
    expect(hits).toBe(0);
  });

  it('reports a simulated network error as ERR_NETWORK', async () => {
    simulate({
      match: { methods: [], urlPattern: '/api/*' },
      action: { kind: 'fail', mode: 'network-error' },
    });
    const err = await rejection(get('/api/items'));
    expect(err.code).toBe('ERR_NETWORK');
    expect(err.response).toBeUndefined();
    expect(hits).toBe(0);
  });

  it('times out a hanging request using its timeout option', async () => {
    simulate({ match: { methods: [], urlPattern: '/api/*' }, action: { kind: 'fail', mode: 'hang' } });
    const err = await rejection(get('/api/items', { timeout: 50 }));
    expect(err.code).toBe('ECONNABORTED');
    expect(err.message).toContain('timeout');
    expect(hits).toBe(0);
  });

  it('reports a simulated timeout like a real one', async () => {
    simulate({
      match: { methods: [], urlPattern: '/api/*' },
      action: { kind: 'fail', mode: 'timeout', timeoutMs: 20 },
    });
    const err = await rejection(get('/api/items'));
    expect(err.code).toBe('ECONNABORTED');
    expect(hits).toBe(0);
  });

  it('cancels a held request through an AbortSignal', async () => {
    simulate({ match: { methods: [], urlPattern: '/api/*' }, action: { kind: 'fail', mode: 'hang' } });
    const controller = new AbortController();
    const pending = get('/api/items', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const err = await rejection(pending);
    expect(axios.isCancel(err)).toBe(true);
    expect(hits).toBe(0);
  });

  it('sends a delayed request for real', async () => {
    simulate({ match: { methods: [], urlPattern: '/api/*' }, action: { kind: 'delay' }, delayMs: 30 });
    const res = await get('/api/items');
    expect(res.data).toEqual({ real: true });
    expect(hits).toBe(1);
  });
});
