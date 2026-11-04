// Whether a tab's page confirmed the rules it was sent: the worker's record of what
// it sent (session storage), the probe that asks the tab's current document, and
// the decision between saved / sent / acknowledged / timed-out / not-connected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSimulationSent,
  getSimulationSent,
  probePageSimulation,
  recordSimulationSent,
} from '../../src/background/simulation';
import { DEFAULT_SETTINGS, captureConfigFrom } from '../../src/shared/settings';
import {
  SIMULATION_ACK_TIMEOUT_MS,
  normalizeSimulationRules,
  sanitizeSimulationAck,
  simulationDelivery,
  simulationRevision,
} from '../../src/shared/simulation';

const RULES = normalizeSimulationRules([
  {
    id: 'r1',
    enabled: true,
    match: { methods: [], urlPattern: '/api/*' },
    action: { kind: 'fail', mode: 'network-error' },
    updatedAt: 1,
  },
]);
const NOW = 1_000_000;

describe('revision', () => {
  it('is what the page receives, and changes with the rules but not with the lease', () => {
    const settings = { ...DEFAULT_SETTINGS, simulationOrigins: ['http://localhost:3000'] };
    const config = (now: number, rules = RULES) =>
      captureConfigFrom(settings, true, 'http://localhost:3000', { armed: true, rules }, now).simulation!;
    expect(config(NOW).revision).toBe(simulationRevision(RULES));
    expect(config(NOW + 20_000).revision).toBe(config(NOW).revision);
    const edited = normalizeSimulationRules([{ ...RULES[0], updatedAt: 2 }]);
    expect(simulationRevision(edited)).not.toBe(simulationRevision(RULES));
  });
});

describe('simulationDelivery', () => {
  const rev = simulationRevision(RULES);
  const sent = { revision: rev, sentAt: NOW };
  const ack = (o: Partial<{ revision: string; leaseUntil: number; rules: number }> = {}) => ({
    revision: rev,
    leaseUntil: NOW + 60_000,
    rules: 1,
    ...o,
  });

  it('is acknowledged only when the current document applies exactly these rules', () => {
    expect(simulationDelivery(rev, sent, ack(), NOW + 100)).toEqual({ delivery: 'acknowledged' });
  });

  it('waits for, then gives up on, a page that has not confirmed', () => {
    expect(simulationDelivery(rev, sent, null, NOW + 100)).toEqual({
      delivery: 'sent',
      ackDeadline: NOW + SIMULATION_ACK_TIMEOUT_MS,
    });
    expect(simulationDelivery(rev, sent, null, NOW + SIMULATION_ACK_TIMEOUT_MS)).toEqual({
      delivery: 'timed-out',
    });
  });

  it('never counts an acknowledgement of an earlier revision or an expired lease', () => {
    expect(simulationDelivery(rev, sent, ack({ revision: 'old' }), NOW + 100).delivery).toBe('sent');
    expect(simulationDelivery(rev, sent, ack({ leaseUntil: NOW }), NOW + 100).delivery).toBe('sent');
  });

  it('distinguishes rules not sent yet from a page that is not connected', () => {
    expect(simulationDelivery(rev, undefined, null, NOW)).toEqual({ delivery: 'saved' });
    expect(simulationDelivery(rev, { revision: 'old', sentAt: NOW }, null, NOW)).toEqual({
      delivery: 'saved',
    });
    expect(simulationDelivery(rev, sent, undefined, NOW)).toEqual({ delivery: 'not-connected' });
  });

  it('validates what the page reports', () => {
    expect(sanitizeSimulationAck(null)).toBeNull();
    expect(sanitizeSimulationAck({ revision: 'r', leaseUntil: 5, rules: 1 })).toEqual({
      revision: 'r',
      leaseUntil: 5,
      rules: 1,
    });
    expect(sanitizeSimulationAck({ revision: 7, leaseUntil: 5, rules: 1 })).toBeUndefined();
    expect(sanitizeSimulationAck({ revision: 'r', leaseUntil: 'x', rules: 1 })).toBeUndefined();
    expect(sanitizeSimulationAck({ revision: 'r'.repeat(65), leaseUntil: 5, rules: 1 })).toBeUndefined();
    expect(sanitizeSimulationAck(undefined)).toBeUndefined();
  });
});

describe('worker records and probe', () => {
  let session: Record<string, unknown>;
  let writes: number;
  let tabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    session = {};
    writes = 0;
    tabsSendMessage = vi.fn();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: async (key: string) => (key in session ? { [key]: session[key] } : {}),
          set: async (items: Record<string, unknown>) => {
            writes++;
            Object.assign(session, structuredClone(items));
          },
          remove: async (key: string) => {
            writes++;
            delete session[key];
          },
        },
      },
      tabs: { sendMessage: tabsSendMessage },
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.useRealTimers();
  });

  it('writes only when the revision or the receiving document changes', async () => {
    await recordSimulationSent(7, 'rev-1', undefined, 100);
    expect(await getSimulationSent(7)).toEqual({ revision: 'rev-1', sentAt: 100 });
    // Lease renewals: same revision, same (or unknown) document.
    await recordSimulationSent(7, 'rev-1', undefined, 200);
    await recordSimulationSent(7, 'rev-1', 'doc-a', 300); // first known document
    await recordSimulationSent(7, 'rev-1', 'doc-a', 400);
    expect(writes).toBe(2);
    expect(await getSimulationSent(7)).toEqual({ revision: 'rev-1', sentAt: 300, documentId: 'doc-a' });
    // Reload: a new document must acknowledge again, so the wait restarts.
    await recordSimulationSent(7, 'rev-1', 'doc-b', 500);
    expect(await getSimulationSent(7)).toMatchObject({ sentAt: 500, documentId: 'doc-b' });
    // New rules restart it too.
    await recordSimulationSent(7, 'rev-2', undefined, 600);
    expect(await getSimulationSent(7)).toMatchObject({ revision: 'rev-2', sentAt: 600 });
  });

  it('forgets the tab when it gets no rules or closes', async () => {
    await recordSimulationSent(7, 'rev-1', undefined, 100);
    await recordSimulationSent(7, undefined);
    expect(await getSimulationSent(7)).toBeUndefined();
    await recordSimulationSent(8, 'rev-1', undefined, 100);
    await forgetSimulationSent(8);
    expect(await getSimulationSent(8)).toBeUndefined();
  });

  it("asks only the tab's top frame and reports its answer", async () => {
    const ack = { revision: 'rev-1', leaseUntil: NOW, rules: 1 };
    tabsSendMessage.mockResolvedValueOnce({ ack });
    expect(await probePageSimulation(7)).toEqual(ack);
    expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: 'simulation-probe' }, { frameId: 0 });
    tabsSendMessage.mockResolvedValueOnce({ ack: null });
    expect(await probePageSimulation(7)).toBeNull();
  });

  it('reports no connection when nothing answers, the answer is malformed, or it never comes', async () => {
    tabsSendMessage.mockRejectedValueOnce(new Error('Could not establish connection'));
    expect(await probePageSimulation(7)).toBeUndefined();
    tabsSendMessage.mockResolvedValueOnce(undefined);
    expect(await probePageSimulation(7)).toBeUndefined();
    tabsSendMessage.mockResolvedValueOnce({ ack: { revision: 1 } });
    expect(await probePageSimulation(7)).toBeUndefined();

    vi.useFakeTimers();
    tabsSendMessage.mockReturnValueOnce(new Promise(() => undefined));
    const pending = probePageSimulation(7, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
