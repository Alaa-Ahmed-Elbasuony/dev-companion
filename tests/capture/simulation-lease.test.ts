// The page's side of simulation reliability: it acknowledges exactly the rules it
// applies, and its lease ends simulation by itself. A held request is released
// (sent unchanged, as by the kill switch) when the lease runs out without renewal;
// an abort during the hold is never followed by a send. Fake timers throughout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchRecorder } from '../../src/capture/fetch-recorder';
import { RELEASED_NOTE } from '../../src/capture/simulate';
import { SIMULATION_LEASE_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import type { SimulationAck } from '../../src/shared/simulation';
import type { CaptureConfig } from '../../src/shared/types';
import { makeContext } from '../helpers/recorder';

const rules = (action: Record<string, unknown>, delayMs = 0) =>
  normalizeSimulationRules([
    {
      id: 'r1',
      name: 'Orders',
      enabled: true,
      delayMs,
      match: { methods: [], urlPattern: 'app.test/api/*' },
      action,
    },
  ]);
const HANG = rules({ kind: 'fail', mode: 'hang' });
const sim = (r = HANG, revision = 'rev-1', leaseMs = SIMULATION_LEASE_MS) => ({
  simulation: { rules: r, leaseUntil: Date.now() + leaseMs, revision },
});

/** A page with the fetch recorder, no rules yet; configs arrive like the bridge sends them. */
function page() {
  const acks: SimulationAck[] = [];
  const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('real'));
  const t = makeContext();
  const listeners: ((c: CaptureConfig) => void)[] = [];
  t.ctx.onConfig = (fn) => listeners.push(fn);
  t.ctx.acknowledgeSimulation = (ack) => acks.push(ack);
  const target = { fetch: original as unknown as typeof fetch };
  installFetchRecorder(target, t.ctx);
  const pushConfig = (c: Partial<CaptureConfig>) => {
    t.setConfig({ simulation: undefined, ...c });
    listeners.forEach((fn) => fn(t.ctx.config()));
  };
  return { ...t, acks, original, target, pushConfig };
}

function track<T>(p: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  p.then(
    () => (state.status = 'fulfilled'),
    (error: unknown) => Object.assign(state, { status: 'rejected', error }),
  );
  return state;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('acknowledgement', () => {
  it('reports the rules it applies after each configuration, and nothing it does not apply', () => {
    const p = page();
    p.pushConfig(sim(HANG, 'rev-1'));
    const leaseUntil = p.ctx.config().simulation!.leaseUntil;
    expect(p.acks).toEqual([{ revision: 'rev-1', leaseUntil, rules: 1 }]);

    // Renewal: the same revision with a later lease.
    vi.advanceTimersByTime(20_000);
    p.pushConfig(sim(HANG, 'rev-1'));
    expect(p.acks[1]).toEqual({ revision: 'rev-1', leaseUntil: leaseUntil + 20_000, rules: 1 });

    // Switched off, then a configuration whose lease has already run out.
    p.pushConfig({});
    p.pushConfig(sim(HANG, 'rev-2', -1));
    expect(p.acks.slice(2)).toEqual([null, null]);
  });

  it('reports a newer revision, so an earlier acknowledgement cannot stand for it', () => {
    const p = page();
    p.pushConfig(sim(HANG, 'rev-1'));
    p.pushConfig(sim(rules({ kind: 'fail', mode: 'network-error' }), 'rev-2'));
    expect(p.acks.map((a) => a?.revision)).toEqual(['rev-1', 'rev-2']);
  });
});

describe('lease expiry and held requests', () => {
  it('releases a held request when the lease runs out without renewal', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    const state = track(p.target.fetch('https://app.test/api/orders'));
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_MS - 1000);
    expect(p.original).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1001);
    expect(p.original).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.status).toBe('fulfilled');
    expect(p.ends()[0]).toMatchObject({ simulated: { action: 'hang', sent: true } });
    expect(p.ends()[0]!.warnings).toContain(RELEASED_NOTE);
    // The page reports that it no longer simulates.
    expect(p.acks.at(-1)).toBeNull();
  });

  it('keeps holding while the lease is renewed; expiry follows the newest lease', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    void p.target.fetch('https://app.test/api/orders');
    await vi.advanceTimersByTimeAsync(50_000);
    p.pushConfig(sim(HANG)); // renewed: now + 60 s
    await vi.advanceTimersByTimeAsync(20_000); // past the first lease
    expect(p.original).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_001); // past the renewed lease
    expect(p.original).toHaveBeenCalledTimes(1);
  });

  it('caps a delay longer than the lease at the lease', async () => {
    const p = page();
    p.pushConfig(sim(rules({ kind: 'delay' }, 120_000)));
    void p.target.fetch('https://app.test/api/orders');
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_MS + 1);
    expect(p.original).toHaveBeenCalledTimes(1);
  });

  it('never sends a request the page aborted during the hold, even when the lease then runs out', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    const controller = new AbortController();
    const state = track(p.target.fetch('https://app.test/api/orders', { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.status).toBe('rejected');
    expect(state.error).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_MS);
    expect(p.original).not.toHaveBeenCalled();
  });

  it('a released request carries the page signal, so an abort during recovery reaches the real request', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    const controller = new AbortController();
    void p.target.fetch('https://app.test/api/orders', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_MS + 1);
    expect(p.original).toHaveBeenCalledTimes(1);
    expect(p.original.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it('switching simulation off releases held requests at once and clears the lease timer', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    void p.target.fetch('https://app.test/api/orders');
    void p.target.fetch('https://app.test/api/items');
    await vi.advanceTimersByTimeAsync(5000);
    p.pushConfig({});
    await vi.advanceTimersByTimeAsync(0);
    expect(p.original).toHaveBeenCalledTimes(2);
    expect(p.acks.at(-1)).toBeNull();
    // Nothing is left waiting: no lease timer, no hold.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing scheduled after the lease ran out', async () => {
    const p = page();
    p.pushConfig(sim(HANG));
    void p.target.fetch('https://app.test/api/orders');
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not change requests when the page never had rules', async () => {
    const p = page();
    p.pushConfig({});
    await p.target.fetch('https://app.test/api/orders');
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); // body read
    expect(p.original).toHaveBeenCalledTimes(1);
    expect(p.ends()[0]!.simulated).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
