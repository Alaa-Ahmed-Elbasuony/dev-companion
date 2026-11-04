// Fetch simulation: mocked responses, delays, failures, abort handling, failure
// patterns, the startup gate and the kill switch. Fake timers and an injected
// random source keep every test deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchRecorder } from '../../src/capture/fetch-recorder';
import { ARMED_WAIT_MS } from '../../src/capture/simulate';
import { SIMULATION_LEASE_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import type { CaptureConfig } from '../../src/shared/types';
import { makeContext } from '../helpers/recorder';

const PAGE = 'https://app.test/checkout';

function rules(...raw: Record<string, unknown>[]) {
  return normalizeSimulationRules(
    raw.map((r, i) => ({
      id: `r${i + 1}`,
      name: `rule ${i + 1}`,
      enabled: true,
      match: { methods: [], urlPattern: 'app.test/api/*' },
      action: { kind: 'mock', status: 200, headers: [], body: '{}', bodyKind: 'json' },
      ...r,
    })),
  );
}

interface SetupOptions {
  armed?: boolean;
  random?: () => number;
  config?: Partial<CaptureConfig>;
}

function setup(simRules: ReturnType<typeof rules> | undefined, opts: SetupOptions = {}) {
  const calls: { thisArg: unknown; args: unknown[] }[] = [];
  const original = vi.fn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    calls.push({ thisArg: this, args: [input, init] });
    return Promise.resolve(
      new Response('{"real":true}', { headers: { 'content-type': 'application/json' } }),
    );
  });
  const t = makeContext({
    simulation: simRules ? { rules: simRules, leaseUntil: Date.now() + SIMULATION_LEASE_MS } : undefined,
    ...opts.config,
  });
  const listeners: ((c: CaptureConfig) => void)[] = [];
  t.ctx.onConfig = (fn) => listeners.push(fn);
  t.ctx.random = opts.random ?? (() => 0);
  let configure!: () => void;
  if (opts.armed) {
    t.ctx.simulationArmed = true;
    const configured = new Promise<void>((resolve) => (configure = resolve));
    t.ctx.whenConfigured = () => configured;
  }
  const target = { fetch: original as unknown as typeof fetch };
  installFetchRecorder(target, t.ctx);
  /** Simulates a config message from the bridge. */
  const pushConfig = (c: Partial<CaptureConfig>) => {
    t.setConfig(c);
    listeners.forEach((fn) => fn(t.ctx.config()));
    configure?.();
  };
  return { ...t, target, original, calls, pushConfig };
}

/** Lets pending timers of 0 ms, microtasks and body reads settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Tracks a promise's outcome without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = {
    status: 'pending',
  };
  p.then(
    (value) => Object.assign(state, { status: 'fulfilled', value }),
    (error: unknown) => Object.assign(state, { status: 'rejected', error }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fetch simulation: inactive', () => {
  it('returns the original promise when the page has no rules', () => {
    const t = setup(undefined);
    const returned = t.target.fetch('/api/items');
    expect(returned).toBe(t.original.mock.results[0]!.value);
  });

  it('returns the original promise when no rule matches', () => {
    const t = setup(rules({ match: { urlPattern: 'app.test/api/orders' } }));
    const returned = t.target.fetch('/api/items');
    expect(returned).toBe(t.original.mock.results[0]!.value);
  });

  it('returns the original promise once the lease has expired', async () => {
    const t = setup(rules({}));
    vi.advanceTimersByTime(SIMULATION_LEASE_MS);
    const returned = t.target.fetch('/api/items');
    expect(returned).toBe(t.original.mock.results[0]!.value);
    await settle();
    expect(t.ends()[0]!.simulated).toBeUndefined();
  });

  it('returns the original promise while capture is disabled (paused), even with rules', () => {
    const t = setup(rules({}), { config: { enabled: false } });
    const returned = t.target.fetch('/api/items');
    expect(returned).toBe(t.original.mock.results[0]!.value);
  });

  it('preserves the receiver and arguments of passed-through requests', () => {
    const t = setup(rules({ match: { urlPattern: 'app.test/other' } }));
    const init = { method: 'POST', body: 'x' };
    const receiver = { marker: true };
    void t.target.fetch.call(receiver, '/api/items', init);
    expect(t.calls[0]).toEqual({ thisArg: receiver, args: ['/api/items', init] });
  });
});

describe('fetch simulation: mocked responses', () => {
  it('returns the mocked status, headers and JSON body without sending the request', async () => {
    const t = setup(
      rules({
        action: {
          kind: 'mock',
          status: 500,
          statusText: 'Internal Server Error',
          headers: [{ name: 'x-request-id', value: 'abc' }],
          body: '{"error":"boom"}',
          bodyKind: 'json',
        },
      }),
    );
    const promise = t.target.fetch('/api/orders', { method: 'POST', body: '{"q":1}' });
    await settle();
    const res = await promise;
    expect(t.original).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
    expect(res.statusText).toBe('Internal Server Error');
    expect(res.headers.get('x-request-id')).toBe('abc');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.url).toBe('https://app.test/api/orders');
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  it('records the mocked request with the simulated marker', async () => {
    const t = setup(rules({ action: { kind: 'mock', status: 503, body: '{"e":1}' } }));
    void t.target.fetch('/api/orders', { method: 'POST', body: '{"q":1}' });
    await settle();
    const [start] = t.starts();
    const [end] = t.ends();
    const marker = { ruleId: 'r1', ruleName: 'rule 1', action: 'mock', delayMs: 0, sent: false };
    expect(start!.simulated).toEqual(marker);
    expect(end).toMatchObject({ state: 'complete', status: 503, method: 'POST', simulated: marker });
    expect(end!.requestBody).toMatchObject({ text: '{"q":1}' });
    expect(end!.responseBody).toMatchObject({ kind: 'json', text: '{"e":1}' });
    expect(end!.warnings.some((w) => w.includes('Simulated by rule "rule 1"'))).toBe(true);
    expect(end!.redirected).toBeUndefined();
  });

  it('returns text bodies with a text content type', async () => {
    const t = setup(rules({ action: { kind: 'mock', status: 200, body: 'plain', bodyKind: 'text' } }));
    const res = t.target.fetch('/api/x');
    await settle();
    const r = await res;
    expect(r.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(await r.text()).toBe('plain');
  });

  it('returns an empty array or an empty body', async () => {
    const t = setup(
      rules(
        { match: { urlPattern: 'app.test/api/list' }, action: { kind: 'mock', status: 200, body: '[]' } },
        { match: { urlPattern: 'app.test/api/empty' }, action: { kind: 'mock', status: 200, body: '' } },
        { match: { urlPattern: 'app.test/api/none' }, action: { kind: 'mock', status: 204, body: 'x' } },
      ),
    );
    const list = t.target.fetch('/api/list');
    const empty = t.target.fetch('/api/empty');
    const none = t.target.fetch('/api/none');
    await settle();
    expect(await (await list).json()).toEqual([]);
    const e = await empty;
    expect(await e.text()).toBe('');
    expect(e.headers.get('content-type')).toBeNull();
    const n = await none;
    expect(n.status).toBe(204);
    expect(n.body).toBeNull();
  });

  it('simulates 401 and 403 with custom API error messages', async () => {
    const t = setup(
      rules(
        {
          match: { urlPattern: 'app.test/api/me' },
          action: { kind: 'mock', status: 401, body: '{"message":"Session expired"}' },
        },
        {
          match: { urlPattern: 'app.test/api/admin' },
          action: { kind: 'mock', status: 403, body: '{"message":"Not allowed"}' },
        },
      ),
    );
    const me = t.target.fetch('/api/me');
    const admin = t.target.fetch('/api/admin');
    await settle();
    expect(await (await me).json()).toEqual({ message: 'Session expired' });
    expect((await admin).status).toBe(403);
  });

  it('lets a custom content-type header win over the default', async () => {
    const t = setup(
      rules({
        action: {
          kind: 'mock',
          status: 422,
          body: '{"title":"x"}',
          headers: [{ name: 'content-type', value: 'application/problem+json' }],
        },
      }),
    );
    const res = t.target.fetch('/api/x');
    await settle();
    expect((await res).headers.get('content-type')).toBe('application/problem+json');
  });

  it('applies a delay before resolving a mock', async () => {
    const t = setup(rules({ delayMs: 2000 }));
    const state = track(t.target.fetch('/api/x'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(state.status).toBe('fulfilled');
    expect(t.original).not.toHaveBeenCalled();
  });
});

describe('fetch simulation: delays', () => {
  it('sends the original request with the same receiver and arguments after the delay', async () => {
    const t = setup(rules({ action: { kind: 'delay' }, delayMs: 3000 }));
    const receiver = { marker: true };
    const init = { method: 'PUT', body: 'payload' };
    const state = track(t.target.fetch.call(receiver, '/api/x', init));
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.original).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(t.calls).toEqual([{ thisArg: receiver, args: ['/api/x', init] }]);
    expect(state.status).toBe('fulfilled');
    expect(await state.value!.json()).toEqual({ real: true });
    expect(t.ends()[0]).toMatchObject({
      state: 'complete',
      simulated: { action: 'delay', delayMs: 3000, sent: true },
    });
  });
});

describe('fetch simulation: failures', () => {
  it('rejects like a network failure without sending the request', async () => {
    const t = setup(rules({ action: { kind: 'fail', mode: 'network-error' } }));
    const state = track(t.target.fetch('/api/x'));
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toBeInstanceOf(TypeError);
    expect((state.error as Error).message).toBe('Failed to fetch');
    expect(t.original).not.toHaveBeenCalled();
    expect(t.ends()[0]).toMatchObject({
      state: 'error',
      errorName: 'TypeError',
      simulated: { action: 'network-error', sent: false },
    });
  });

  it('rejects with a TimeoutError after the delay plus the timeout', async () => {
    const t = setup(rules({ delayMs: 500, action: { kind: 'fail', mode: 'timeout', timeoutMs: 5000 } }));
    const state = track(t.target.fetch('/api/x'));
    await vi.advanceTimersByTimeAsync(5499);
    expect(state.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'TimeoutError' });
    expect(t.original).not.toHaveBeenCalled();
    expect(t.ends()[0]).toMatchObject({ state: 'timeout', simulated: { action: 'timeout' } });
  });

  it('keeps a hanging request pending until the page aborts it', async () => {
    const r = rules({ action: { kind: 'fail', mode: 'hang' } });
    const t = setup(r);
    const controller = new AbortController();
    const state = track(t.target.fetch('/api/x', { signal: controller.signal }));
    // Ten minutes while the bridge keeps renewing the lease (every 20 s).
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      t.pushConfig({ simulation: { rules: r, leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
    }
    expect(state.status).toBe('pending');
    expect(t.starts()[0]).toMatchObject({ state: 'pending', simulated: { action: 'hang' } });
    expect(t.ends()).toHaveLength(0);

    controller.abort();
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'AbortError' });
    expect(t.original).not.toHaveBeenCalled();
    expect(t.ends()[0]).toMatchObject({ state: 'aborted' });
  });
});

describe('fetch simulation: request URL', () => {
  const mock = { kind: 'mock', status: 201, headers: [], body: '{}', bodyKind: 'json' };

  it('resolves relative URLs against the document base URL, as the browser does', async () => {
    const t = setup(rules({ match: { methods: [], urlPattern: 'api.test/v2/*' }, action: mock }));
    t.ctx.baseUrl = () => 'https://api.test/v2/'; // <base href="https://api.test/v2/">
    const pending = t.target.fetch('items');
    await settle();
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.url).toBe('https://api.test/v2/items');
    expect(t.original).not.toHaveBeenCalled();
    await settle();
    expect(t.ends()[0]).toMatchObject({ url: 'https://api.test/v2/items', simulated: { action: 'mock' } });
  });

  it('never applies a rule for the page URL to a request the base URL sends elsewhere', async () => {
    const t = setup(rules({ match: { methods: [], urlPattern: 'app.test/*' }, action: mock }));
    t.ctx.baseUrl = () => 'https://api.test/v2/';
    const pending = t.target.fetch('items');
    await settle();
    await pending;
    expect(t.original).toHaveBeenCalledTimes(1);
    await settle();
    expect(t.ends()[0]).toMatchObject({ url: 'https://api.test/v2/items' });
    expect(t.ends()[0]!.simulated).toBeUndefined();
  });
});

describe('fetch simulation: AbortSignal', () => {
  it('rejects with the abort reason when aborted during a delay, without sending', async () => {
    const t = setup(rules({ action: { kind: 'delay' }, delayMs: 5000 }));
    const controller = new AbortController();
    const state = track(t.target.fetch('/api/x', { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1000);
    const reason = new Error('user navigated');
    controller.abort(reason);
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.original).not.toHaveBeenCalled();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const t = setup(rules({ action: { kind: 'mock', status: 200, body: '{}' } }));
    const state = track(t.target.fetch('/api/x', { signal: AbortSignal.abort() }));
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'AbortError' });
  });

  it('honors the signal of a Request object', async () => {
    const t = setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const controller = new AbortController();
    const state = track(
      t.target.fetch(new Request(`${PAGE.replace('/checkout', '')}/api/x`, { signal: controller.signal })),
    );
    await settle();
    controller.abort();
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'AbortError' });
  });

  it('records a timeout from AbortSignal.timeout during a hang', async () => {
    // AbortSignal.timeout runs on the runtime's own timers, which fake timers do not control.
    vi.useRealTimers();
    const t = setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const state = track(t.target.fetch('/api/x', { signal: AbortSignal.timeout(20) }));
    await new Promise((r) => setTimeout(r, 60));
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'TimeoutError' });
    expect(t.ends()[0]).toMatchObject({ state: 'timeout' });
    expect(t.original).not.toHaveBeenCalled();
  });
});

describe('fetch simulation: failure patterns', () => {
  const failing = { action: { kind: 'fail', mode: 'network-error' } };

  it('applies a random rule when the random draw is below the percentage', async () => {
    let draw = 0.29;
    const t = setup(rules({ ...failing, pattern: { kind: 'random', percent: 30 } }), { random: () => draw });
    const failed = track(t.target.fetch('/api/x'));
    await settle();
    expect(failed.status).toBe('rejected');

    draw = 0.3;
    const passed = t.target.fetch('/api/x');
    // Not applied: the original promise, untouched.
    expect(passed).toBe(t.original.mock.results[0]!.value);
  });

  it('fails the first N matching requests, then passes through', async () => {
    const t = setup(rules({ ...failing, pattern: { kind: 'first-n', n: 2 } }));
    const results = [1, 2, 3, 4].map(() => track(t.target.fetch('/api/x')));
    await settle();
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled', 'fulfilled']);
    expect(t.original).toHaveBeenCalledTimes(2);
  });

  it('fails every Nth matching request', async () => {
    const t = setup(rules({ ...failing, pattern: { kind: 'every-nth', n: 3 } }));
    const results = [1, 2, 3, 4, 5, 6].map(() => track(t.target.fetch('/api/x')));
    await settle();
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
  });

  it('counts each rule separately and restarts the count when a rule is edited', async () => {
    const raw = { ...failing, pattern: { kind: 'first-n', n: 1 }, updatedAt: 1 };
    const t = setup(rules(raw));
    const first = track(t.target.fetch('/api/x'));
    const second = track(t.target.fetch('/api/x'));
    await settle();
    expect([first.status, second.status]).toEqual(['rejected', 'fulfilled']);

    t.pushConfig({
      simulation: { rules: rules({ ...raw, updatedAt: 2 }), leaseUntil: Date.now() + SIMULATION_LEASE_MS },
    });
    const third = track(t.target.fetch('/api/x'));
    await settle();
    expect(third.status).toBe('rejected');
  });
});

describe('fetch simulation: sensitive endpoints', () => {
  it('passes authentication and payment requests through unless the rule allows them', async () => {
    const t = setup(
      rules({ match: { urlPattern: 'app.test/*' }, action: { kind: 'fail', mode: 'network-error' } }),
    );
    const login = t.target.fetch('/api/auth/login', { method: 'POST' });
    const pay = t.target.fetch('/api/checkout', { method: 'POST' });
    expect(login).toBe(t.original.mock.results[0]!.value);
    expect(pay).toBe(t.original.mock.results[1]!.value);
    const other = track(t.target.fetch('/api/orders'));
    await settle();
    expect(other.status).toBe('rejected');
  });

  it('simulates them when the rule explicitly allows it', async () => {
    const t = setup(
      rules({
        match: { urlPattern: 'app.test/api/auth/*' },
        allowSensitive: true,
        action: { kind: 'mock', status: 401, body: '{}' },
      }),
    );
    const res = t.target.fetch('/api/auth/login', { method: 'POST' });
    await settle();
    expect((await res).status).toBe(401);
    expect(t.original).not.toHaveBeenCalled();
  });
});

describe('fetch simulation: switching simulation off', () => {
  it('sends held requests to the network when simulation is switched off', async () => {
    const t = setup(rules({ action: { kind: 'fail', mode: 'hang' } }));
    const state = track(t.target.fetch('/api/x'));
    await settle();
    expect(t.original).not.toHaveBeenCalled();

    t.pushConfig({ simulation: undefined });
    await settle();
    expect(t.original).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('fulfilled');
    const end = t.ends()[0]!;
    expect(end.simulated).toMatchObject({ action: 'hang', sent: true });
    expect(end.warnings.some((w) => w.includes('switched off'))).toBe(true);
  });

  it('releases delayed mocks the same way when recording is paused', async () => {
    const t = setup(rules({ delayMs: 60_000 }));
    const state = track(t.target.fetch('/api/x'));
    await settle();
    t.pushConfig({ enabled: false, simulation: undefined });
    await settle();
    expect(t.original).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('fulfilled');
  });

  it('keeps held requests when a config still carries rules (lease renewal)', async () => {
    const r = rules({ action: { kind: 'fail', mode: 'hang' } });
    const t = setup(r);
    const state = track(t.target.fetch('/api/x'));
    t.pushConfig({ simulation: { rules: r, leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
    await settle();
    expect(state.status).toBe('pending');
    expect(t.original).not.toHaveBeenCalled();
  });
});

describe('fetch simulation: early requests on armed pages', () => {
  it('holds startup requests until the rules arrive, then simulates them', async () => {
    const t = setup(undefined, { armed: true });
    const state = track(t.target.fetch('/api/x'));
    await vi.advanceTimersByTimeAsync(100);
    expect(t.original).not.toHaveBeenCalled();

    t.pushConfig({
      simulation: {
        rules: rules({ action: { kind: 'mock', status: 418, body: '' } }),
        leaseUntil: Date.now() + SIMULATION_LEASE_MS,
      },
    });
    await settle();
    expect(state.status).toBe('fulfilled');
    expect(state.value!.status).toBe(418);
    expect(t.original).not.toHaveBeenCalled();
  });

  it('sends held startup requests unchanged when the config has no rules', async () => {
    const t = setup(undefined, { armed: true });
    const state = track(t.target.fetch('/api/x'));
    t.pushConfig({ simulation: undefined });
    await settle();
    expect(t.original).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('fulfilled');
    expect(t.ends()[0]!.warnings).toEqual([]);
  });

  it('gives up waiting after the bound and sends with a note; later requests are not held', async () => {
    const t = setup(undefined, { armed: true });
    const state = track(t.target.fetch('/api/x'));
    await vi.advanceTimersByTimeAsync(ARMED_WAIT_MS - 1);
    expect(t.original).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(state.status).toBe('fulfilled');
    expect(t.ends()[0]!.warnings[0]).toContain('did not arrive in time');

    const later = t.target.fetch('/api/y');
    expect(later).toBe(t.original.mock.results[1]!.value);
  });

  it('rejects a held startup request the page aborts, without sending it', async () => {
    const t = setup(undefined, { armed: true });
    const controller = new AbortController();
    const state = track(t.target.fetch('/api/x', { signal: controller.signal }));
    controller.abort();
    await settle();
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'AbortError' });
    t.pushConfig({ simulation: undefined });
    await settle();
    expect(t.original).not.toHaveBeenCalled();
  });

  it('does not hold requests in the plain (unarmed) recorder', () => {
    const t = setup(undefined);
    const returned = t.target.fetch('/api/x');
    expect(returned).toBe(t.original.mock.results[0]!.value);
  });
});

describe('fetch simulation: initiator stack', () => {
  const topFrame = (stack: string | undefined) => stack?.split('\n')[0] ?? '';

  it('starts at the page call site for passed-through and simulated requests', async () => {
    const t = setup(rules({ match: { urlPattern: 'app.test/api/mocked' } }));
    function pageCodeSendsRequest(path: string) {
      return t.target.fetch(path);
    }
    void pageCodeSendsRequest('/api/plain');
    void pageCodeSendsRequest('/api/mocked');
    await settle();
    expect(t.ends()).toHaveLength(2);
    for (const end of t.ends()) expect(topFrame(end.initiatorStack)).toContain('pageCodeSendsRequest');
  });

  it('keeps the real caller for requests held at startup', async () => {
    const t = setup(undefined, { armed: true });
    function pageStartupCode() {
      return t.target.fetch('/api/x');
    }
    void pageStartupCode();
    t.pushConfig({ simulation: undefined });
    await settle();
    expect(topFrame(t.ends()[0]!.initiatorStack)).toContain('pageStartupCode');
  });
});
