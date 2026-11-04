import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageChannel } from '../../src/capture/channel';
import { BRIDGE_TO_PAGE_EVENT, PAGE_TO_BRIDGE_EVENT } from '../../src/shared/messages';
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_SETTINGS, captureConfigFrom } from '../../src/shared/settings';
import { SIMULATION_LEASE_RENEW_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import type { CaptureConfig } from '../../src/shared/types';

const ORIGIN = 'http://localhost:3000';
const RULES = normalizeSimulationRules([
  {
    id: 'r1',
    enabled: true,
    match: { methods: ['GET'], urlPattern: 'localhost:3000/api/*' },
    action: { kind: 'fail', mode: 'network-error' },
  },
]);

const simulatingConfig = (): CaptureConfig =>
  captureConfigFrom({ ...DEFAULT_SETTINGS, simulationOrigins: [ORIGIN] }, true, ORIGIN, {
    armed: true,
    rules: RULES,
  });

const sendConfig = (target: EventTarget, config: CaptureConfig) =>
  target.dispatchEvent(
    new CustomEvent(BRIDGE_TO_PAGE_EVENT, { detail: JSON.stringify({ type: 'config', config }) }),
  );

describe('page channel: simulation config', () => {
  it('starts without simulation', () => {
    const channel = createPageChannel(new EventTarget(), DEFAULT_CAPTURE_CONFIG);
    expect(channel.config().simulation).toBeUndefined();
  });

  it('applies rules from the bridge and drops them when a later config has none (kill switch)', () => {
    const doc = new EventTarget();
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    sendConfig(doc, simulatingConfig());
    expect(channel.config().simulation?.rules.map((r) => r.id)).toEqual(['r1']);

    // `simulation: undefined` disappears in JSON; it must still switch simulation off.
    sendConfig(doc, captureConfigFrom(DEFAULT_SETTINGS, true, ORIGIN));
    expect(channel.config().simulation).toBeUndefined();
    expect(channel.config().enabled).toBe(true);
  });

  it('drops rules when recording is paused', () => {
    const doc = new EventTarget();
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    sendConfig(doc, simulatingConfig());
    sendConfig(doc, captureConfigFrom({ ...DEFAULT_SETTINGS, simulationOrigins: [ORIGIN] }, false, ORIGIN));
    expect(channel.config().simulation).toBeUndefined();
  });

  it('resolves whenConfigured only once the first config arrives', async () => {
    const doc = new EventTarget();
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    let ready = false;
    void channel.whenConfigured().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    sendConfig(doc, DEFAULT_CAPTURE_CONFIG);
    await Promise.resolve();
    expect(ready).toBe(true);
  });
});

describe('bridge: simulation lease', () => {
  type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void;
  let sendMessage: ReturnType<typeof vi.fn>;
  let doc: EventTarget;
  let onMessage: Listener[];

  async function startBridge() {
    vi.resetModules();
    await import('../../src/content/content-script');
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new EventTarget();
    sendMessage = vi.fn();
    onMessage = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = doc;
    g.window = new EventTarget();
    g.chrome = {
      runtime: {
        sendMessage,
        onMessage: { addListener: (l: Listener) => onMessage.push(l) },
      },
    };
    delete g.__devCompanionBridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.document;
    delete g.window;
    delete g.chrome;
    delete g.__devCompanionBridge;
  });

  const configRequests = () =>
    sendMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'page-config-request').length;

  it('renews the lease while the page holds rules', async () => {
    sendMessage.mockImplementation(async () => ({ recording: true, config: simulatingConfig() }));
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    await startBridge();
    expect(channel.config().simulation).toBeDefined();
    expect(configRequests()).toBe(1);

    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS);
    expect(configRequests()).toBe(2);
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS);
    expect(configRequests()).toBe(3);
  });

  it('does not poll when there are no rules', async () => {
    sendMessage.mockImplementation(async () => ({
      recording: true,
      config: captureConfigFrom(DEFAULT_SETTINGS, true, ORIGIN),
    }));
    await startBridge();
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS * 5);
    expect(configRequests()).toBe(1);
  });

  it('switches simulation off in the page when the extension context is invalidated', async () => {
    sendMessage.mockImplementationOnce(async () => ({ recording: true, config: simulatingConfig() }));
    sendMessage.mockImplementation(async () => {
      throw new Error('Extension context invalidated.');
    });
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    await startBridge();
    expect(channel.config().simulation).toBeDefined();

    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS);
    expect(channel.config().simulation).toBeUndefined();
    // Recording settings are otherwise left as they were.
    expect(channel.config().enabled).toBe(true);

    // No further renewal attempts after disconnecting.
    const calls = sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS * 3);
    expect(sendMessage.mock.calls.length).toBe(calls);
  });

  it('keeps trying to renew after a failed renewal (worker restarting)', async () => {
    sendMessage.mockImplementationOnce(async () => ({ recording: true, config: simulatingConfig() }));
    sendMessage.mockImplementationOnce(async () => undefined); // worker unreachable
    sendMessage.mockImplementation(async () => ({ recording: true, config: simulatingConfig() }));
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    await startBridge();
    const first = channel.config().simulation!.leaseUntil;
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS); // fails
    expect(channel.config().simulation!.leaseUntil).toBe(first);
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS); // the restarted worker answers
    expect(configRequests()).toBe(3);
    expect(channel.config().simulation!.leaseUntil).toBeGreaterThan(first);
  });

  const pageSays = (message: unknown) =>
    doc.dispatchEvent(new CustomEvent(PAGE_TO_BRIDGE_EVENT, { detail: JSON.stringify(message) }));
  const appliedMessages = () =>
    sendMessage.mock.calls.map(([m]) => m as { type: string }).filter((m) => m.type === 'simulation-applied');
  const probe = () => {
    const answers: unknown[] = [];
    for (const l of onMessage) l({ type: 'simulation-probe' }, {}, (r) => answers.push(r));
    return answers;
  };

  it('tells the worker when the page applies a different simulation, not on every renewal', async () => {
    sendMessage.mockImplementation(async () => ({ recording: true, config: simulatingConfig() }));
    await startBridge();
    const ack = (revision: string, leaseUntil = Date.now() + 60_000) => ({
      type: 'simulation-applied',
      ack: { revision, leaseUntil, rules: 1 },
    });
    pageSays(ack('rev-1'));
    pageSays(ack('rev-1', Date.now() + 80_000)); // renewal
    pageSays({ type: 'simulation-applied', ack: { revision: 7 } }); // malformed: ignored
    pageSays(ack('rev-2'));
    pageSays({ type: 'simulation-applied', ack: null });
    expect(appliedMessages()).toEqual([
      { type: 'simulation-applied', revision: 'rev-1' },
      { type: 'simulation-applied', revision: 'rev-2' },
      { type: 'simulation-applied', revision: null },
    ]);
    // Acknowledgements are never forwarded as captured events.
    await vi.advanceTimersByTimeAsync(100);
    const batches = sendMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'capture-batch');
    expect(batches).toHaveLength(0);
  });

  it("answers the worker's probe with what the page last reported", async () => {
    sendMessage.mockImplementation(async () => ({ recording: true, config: simulatingConfig() }));
    await startBridge();
    expect(probe()).toEqual([{ ack: null }]);
    const leaseUntil = Date.now() + 60_000;
    pageSays({ type: 'simulation-applied', ack: { revision: 'rev-1', leaseUntil, rules: 1 } });
    expect(probe()).toEqual([{ ack: { revision: 'rev-1', leaseUntil, rules: 1 } }]);
    pageSays({ type: 'simulation-applied', ack: null });
    expect(probe()).toEqual([{ ack: null }]);
  });

  it('lets the lease run out when the worker stops answering', async () => {
    sendMessage.mockImplementationOnce(async () => ({ recording: true, config: simulatingConfig() }));
    sendMessage.mockImplementation(async () => undefined);
    const channel = createPageChannel(doc, DEFAULT_CAPTURE_CONFIG);
    await startBridge();
    const leaseUntil = channel.config().simulation!.leaseUntil;
    await vi.advanceTimersByTimeAsync(SIMULATION_LEASE_RENEW_MS * 4);
    // No new config arrived, so the page still has the old lease, which has now expired.
    expect(channel.config().simulation!.leaseUntil).toBe(leaseUntil);
    expect(leaseUntil).toBeLessThanOrEqual(Date.now());
  });
});
