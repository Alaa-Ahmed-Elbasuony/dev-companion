import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ingestor } from '../../src/background/ingest';
import { RecordingController } from '../../src/background/recording';
import { loadSimulationState, setSimulationArmed } from '../../src/background/simulation';
import type { Broadcast } from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import {
  SIMULATION_ARMED_KEY,
  SIMULATION_RULES_KEY,
  normalizeSimulationRules,
} from '../../src/shared/simulation';
import type { SimulationState } from '../../src/shared/simulation';
import type { Settings } from '../../src/shared/types';
import { EntryStore } from '../../src/storage/database';
import { draft } from '../helpers/entries';
import { installFakeChrome } from '../helpers/fake-chrome';

const ORIGIN = 'http://localhost:3000';
const RULES = normalizeSimulationRules([
  {
    id: 'r1',
    enabled: true,
    match: { methods: ['GET'], urlPattern: 'localhost:3000/api/*' },
    action: { kind: 'fail', mode: 'network-error' },
  },
]);

let store: EntryStore;
let fake: ReturnType<typeof installFakeChrome>;
let settings: Settings;
let simulation: SimulationState;
let controller: RecordingController;
let n = 0;

beforeEach(async () => {
  fake = installFakeChrome({ grantedPatterns: ['http://localhost/*', 'http://127.0.0.1/*'] });
  store = await EntryStore.open(`sim-${++n}`);
  settings = { ...DEFAULT_SETTINGS, simulationOrigins: [ORIGIN] };
  simulation = { armed: true, rules: RULES };
  controller = new RecordingController(
    store,
    async () => settings,
    () => undefined,
    async () => simulation,
  );
});
afterEach(() => store.close());

const lastConfig = (tabId: number) => {
  const msg = fake.tabMessages.filter((m) => m.tabId === tabId).at(-1)?.message as Broadcast | undefined;
  return msg?.type === 'recording-state' ? msg.config : undefined;
};

describe('simulation: script registration', () => {
  it('registers only the plain recorder when simulation is not armed', async () => {
    simulation = { armed: false, rules: RULES };
    await controller.start(5, `${ORIGIN}/`);
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://localhost/*']);
    expect(fake.registered.has('dc-main-world-armed')).toBe(false);
    expect(lastConfig(5)!.simulation).toBeUndefined();
  });

  it('keeps the existing registration when the controller has no simulation source', async () => {
    const plain = new RecordingController(
      store,
      async () => settings,
      () => undefined,
    );
    await plain.start(5, `${ORIGIN}/`);
    expect([...fake.registered.keys()].sort()).toEqual(['dc-bridge', 'dc-main-world']);
    expect(lastConfig(5)!.simulation).toBeUndefined();
  });

  it('registers the armed recorder for an armed, allowlisted origin and sends its rules', async () => {
    await controller.start(5, `${ORIGIN}/`);
    const armed = fake.registered.get('dc-main-world-armed')!;
    expect(armed).toMatchObject({
      js: ['main-world-armed.js'],
      world: 'MAIN',
      runAt: 'document_start',
      matches: ['http://localhost/*'],
      persistAcrossSessions: false,
    });
    expect(fake.registered.has('dc-main-world')).toBe(false);
    expect(fake.registered.get('dc-bridge')!.matches).toEqual(['http://localhost/*']);
    expect(lastConfig(5)!.simulation!.rules.map((r) => r.id)).toEqual(['r1']);
  });

  it('never sends rules to an origin outside the allowlist', async () => {
    await controller.start(6, 'http://127.0.0.1:8080/');
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://127.0.0.1/*']);
    expect(fake.registered.has('dc-main-world-armed')).toBe(false);
    expect(lastConfig(6)!.simulation).toBeUndefined();
  });

  it('splits hosts between the plain and armed recorders without overlap', async () => {
    await controller.start(5, `${ORIGIN}/`);
    await controller.start(6, 'http://127.0.0.1:8080/');
    expect(fake.registered.get('dc-main-world-armed')!.matches).toEqual(['http://localhost/*']);
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://127.0.0.1/*']);
    expect([...fake.registered.get('dc-bridge')!.matches!].sort()).toEqual([
      'http://127.0.0.1/*',
      'http://localhost/*',
    ]);
  });

  it('pausing pauses simulation; resuming restores it', async () => {
    await controller.start(5, `${ORIGIN}/`);
    await controller.setPaused(5, true);
    expect(fake.registered.has('dc-main-world-armed')).toBe(false);
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://localhost/*']);
    expect(lastConfig(5)).toMatchObject({ enabled: false });
    expect(lastConfig(5)!.simulation).toBeUndefined();

    await controller.setPaused(5, false);
    expect(fake.registered.get('dc-main-world-armed')!.matches).toEqual(['http://localhost/*']);
    expect(fake.registered.has('dc-main-world')).toBe(false);
    expect(lastConfig(5)!.simulation).toBeDefined();
  });

  it('disarming switches open pages off and restores the plain recorder', async () => {
    await controller.start(5, `${ORIGIN}/`);
    simulation = { armed: false, rules: RULES };
    await controller.applySimulationChange();
    expect(fake.registered.has('dc-main-world-armed')).toBe(false);
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://localhost/*']);
    expect(lastConfig(5)).toMatchObject({ enabled: true });
    expect(lastConfig(5)!.simulation).toBeUndefined();
  });

  it('removing the origin from the allowlist switches simulation off', async () => {
    await controller.start(5, `${ORIGIN}/`);
    settings = { ...settings, simulationOrigins: [] };
    await controller.applySimulationChange();
    expect(fake.registered.has('dc-main-world-armed')).toBe(false);
    expect(lastConfig(5)!.simulation).toBeUndefined();
  });

  it('unregisters everything when recording stops', async () => {
    await controller.start(5, `${ORIGIN}/`);
    await controller.stop(5);
    expect(fake.registered.size).toBe(0);
    expect(lastConfig(5)).toMatchObject({ enabled: false });
    expect(lastConfig(5)!.simulation).toBeUndefined();
  });

  it('does not re-register when nothing changed', async () => {
    await controller.start(5, `${ORIGIN}/`);
    const calls = fake.fake.scripting.registerContentScripts.mock.calls.length;
    await controller.applySimulationChange();
    expect(fake.fake.scripting.registerContentScripts.mock.calls.length).toBe(calls);
  });
});

describe('simulation: worker state', () => {
  it('is disarmed with no rules by default (fresh browser session)', async () => {
    expect(await loadSimulationState()).toEqual({ armed: false, rules: [] });
  });

  it('keeps the master switch in session storage only', async () => {
    await setSimulationArmed(true);
    expect(fake.session.get(SIMULATION_ARMED_KEY)).toBe(true);
    expect(fake.local.has(SIMULATION_ARMED_KEY)).toBe(false);
    expect((await loadSimulationState()).armed).toBe(true);

    await setSimulationArmed(false);
    expect(fake.session.has(SIMULATION_ARMED_KEY)).toBe(false);
    expect((await loadSimulationState()).armed).toBe(false);
  });

  it('loads durable rules from local storage and normalizes them', async () => {
    fake.local.set(SIMULATION_RULES_KEY, [RULES[0], { id: 'broken' }]);
    const state = await loadSimulationState();
    expect(state.rules.map((r) => r.id)).toEqual(['r1']);
  });

  it('treats a session that lost its master switch (browser restart) as disarmed', async () => {
    fake.local.set(SIMULATION_RULES_KEY, RULES);
    await setSimulationArmed(true);
    fake.session.clear();
    expect(await loadSimulationState()).toMatchObject({ armed: false, rules: [{ id: 'r1' }] });
  });
});

describe('simulation: ingest', () => {
  it('stores the simulated marker posted with a request', async () => {
    const ingestor = new Ingestor({
      store,
      settings: async () => DEFAULT_SETTINGS,
      recording: async () => ({ sessionId: 's-1', tabId: 7, origin: ORIGIN, startedAt: 0 }),
      onStorageError: () => undefined,
    });
    const simulated = { ruleId: 'r1', ruleName: 'r1', action: 'network-error', delayMs: 0, sent: false };
    const d = draft({ id: 'm1', url: `${ORIGIN}/api/items`, state: 'error' });
    await ingestor.ingestBatch(7, ORIGIN, [{ type: 'network-end', draft: { ...d, simulated } as typeof d }]);
    expect((await store.getEntry('m1'))!.simulated).toEqual(simulated);
  });
});
