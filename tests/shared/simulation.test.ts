import { describe, expect, it } from 'vitest';
import { sanitizeDraft } from '../../src/shared/sanitize';
import {
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_SETTINGS,
  captureConfigFrom,
  normalizeSettings,
} from '../../src/shared/settings';
import {
  DISARMED,
  MAX_MOCK_BODY_BYTES,
  MAX_SIMULATION_RULES,
  SIMULATION_LEASE_MS,
  activeSimulationRules,
  isArmedOrigin,
  normalizeSimulationRules,
  sanitizeSimulatedInfo,
} from '../../src/shared/simulation';
import type { SimulationRule, SimulationState } from '../../src/shared/simulation';
import type { Settings } from '../../src/shared/types';
import { draft } from '../helpers/entries';

const ORIGIN = 'http://localhost:3000';

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    name: 'Orders fail',
    enabled: true,
    match: { methods: ['post'], urlPattern: 'localhost:3000/api/orders', query: 'ignore' },
    action: { kind: 'mock', status: 500, headers: [], body: '{"error":"boom"}', bodyKind: 'json' },
    delayMs: 0,
    pattern: { kind: 'always' },
    allowSensitive: false,
    updatedAt: 1,
    ...overrides,
  };
}

const settingsWith = (origins: string[]): Settings => ({ ...DEFAULT_SETTINGS, simulationOrigins: origins });
const armed = (rules = normalizeSimulationRules([rule()])): SimulationState => ({ armed: true, rules });

describe('normalizeSimulationRules', () => {
  it('returns no rules for missing or malformed storage', () => {
    expect(normalizeSimulationRules(undefined)).toEqual([]);
    expect(normalizeSimulationRules({ r1: rule() })).toEqual([]);
    expect(normalizeSimulationRules([null, 'x', 42])).toEqual([]);
  });

  it('keeps a valid rule and normalizes methods', () => {
    const [r] = normalizeSimulationRules([
      rule({ match: { methods: ['post', 'POST', 'get', 'b@d', 7], urlPattern: ' localhost:3000/api/* ' } }),
    ]);
    expect(r).toMatchObject({
      id: 'r1',
      enabled: true,
      match: { methods: ['POST', 'GET'], urlPattern: 'localhost:3000/api/*', query: 'ignore' },
      pattern: { kind: 'always' },
      allowSensitive: false,
    });
  });

  it('defaults to disabled and to protecting sensitive endpoints', () => {
    const [r] = normalizeSimulationRules([rule({ enabled: 'yes', allowSensitive: 'true' })]);
    expect(r!.enabled).toBe(false);
    expect(r!.allowSensitive).toBe(false);
  });

  it('drops rules without a URL pattern or with an unknown action', () => {
    expect(normalizeSimulationRules([rule({ match: { urlPattern: '   ' } })])).toEqual([]);
    expect(normalizeSimulationRules([rule({ action: { kind: 'explode' } })])).toEqual([]);
    expect(normalizeSimulationRules([rule({ action: { kind: 'fail', mode: 'crash' } })])).toEqual([]);
  });

  it('drops duplicate ids, keeping the first (priority order)', () => {
    const rules = normalizeSimulationRules([rule({ name: 'first' }), rule({ name: 'second' })]);
    expect(rules.map((r) => r.name)).toEqual(['first']);
  });

  it('caps the number of rules', () => {
    const many = Array.from({ length: MAX_SIMULATION_RULES + 10 }, (_, i) => rule({ id: `r${i}` }));
    expect(normalizeSimulationRules(many)).toHaveLength(MAX_SIMULATION_RULES);
  });

  it('clamps statuses to what new Response() accepts and clears bodies of null-body statuses', () => {
    const [low, high, noContent] = normalizeSimulationRules([
      rule({ id: 'a', action: { kind: 'mock', status: 0, body: 'x' } }),
      rule({ id: 'b', action: { kind: 'mock', status: 999, body: 'x' } }),
      rule({ id: 'c', action: { kind: 'mock', status: 204, body: 'x' } }),
    ]);
    expect(low!.action).toMatchObject({ status: 200 });
    expect(high!.action).toMatchObject({ status: 599 });
    expect(noContent!.action).toMatchObject({ status: 204, body: '' });
  });

  it('rejects mock bodies over the size limit', () => {
    const body = 'x'.repeat(MAX_MOCK_BODY_BYTES + 1);
    expect(normalizeSimulationRules([rule({ action: { kind: 'mock', status: 200, body } })])).toEqual([]);
  });

  it('drops invalid header names and strips line breaks from values', () => {
    const [r] = normalizeSimulationRules([
      rule({
        action: {
          kind: 'mock',
          status: 401,
          body: '',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'bad header', value: 'x' },
            { name: 'x-injected', value: 'a\r\nset-cookie: s=1' },
          ],
        },
      }),
    ]);
    expect(r!.action).toMatchObject({
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'x-injected', value: 'a  set-cookie: s=1' },
      ],
    });
  });

  it('clamps delays and normalizes failure patterns', () => {
    const [r] = normalizeSimulationRules([
      rule({
        delayMs: 10_000_000,
        action: { kind: 'fail', mode: 'timeout', timeoutMs: -5 },
        pattern: { kind: 'random', percent: 250 },
      }),
    ]);
    expect(r).toMatchObject({
      delayMs: 120_000,
      action: { kind: 'fail', mode: 'timeout', timeoutMs: 0 },
      pattern: { kind: 'random', percent: 100 },
    });
    const [unknown] = normalizeSimulationRules([rule({ pattern: { kind: 'sometimes' } })]);
    expect(unknown!.pattern).toEqual({ kind: 'always' });
  });
});

describe('simulation allowlist setting', () => {
  it('is empty by default', () => {
    expect(DEFAULT_SETTINGS.simulationOrigins).toEqual([]);
    expect(normalizeSettings({}).simulationOrigins).toEqual([]);
  });

  it('keeps only valid http(s) origins, normalized and deduplicated', () => {
    const s = normalizeSettings({
      simulationOrigins: ['http://localhost:3000/', 'http://localhost:3000/app', 'file:///x', 'nope', 7],
    });
    expect(s.simulationOrigins).toEqual([ORIGIN]);
  });
});

describe('page simulation config', () => {
  it('is absent from the default capture config', () => {
    expect(DEFAULT_CAPTURE_CONFIG.simulation).toBeUndefined();
    expect(captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN).simulation).toBeUndefined();
  });

  it('is absent unless armed', () => {
    const state = { ...armed(), armed: false };
    expect(captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN, state).simulation).toBeUndefined();
  });

  it('is absent for origins that are not allowlisted', () => {
    const settings = settingsWith([ORIGIN]);
    expect(captureConfigFrom(settings, true, 'http://localhost:4000', armed()).simulation).toBeUndefined();
    expect(captureConfigFrom(settings, true, 'https://shop.example', armed()).simulation).toBeUndefined();
    expect(captureConfigFrom(settings, true, undefined, armed()).simulation).toBeUndefined();
  });

  it('is absent while capture is disabled (stopped or paused)', () => {
    expect(captureConfigFrom(settingsWith([ORIGIN]), false, ORIGIN, armed()).simulation).toBeUndefined();
  });

  it('is absent when no rule is enabled', () => {
    const rules = normalizeSimulationRules([rule({ enabled: false })]);
    expect(captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN, armed(rules)).simulation).toBeUndefined();
  });

  it('carries only enabled rules, in order, with a lease', () => {
    const rules = normalizeSimulationRules([
      rule({ id: 'a' }),
      rule({ id: 'b', enabled: false }),
      rule({ id: 'c' }),
    ]);
    const config = captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN, armed(rules), 1000);
    expect(config.simulation!.rules.map((r: SimulationRule) => r.id)).toEqual(['a', 'c']);
    expect(config.simulation!.leaseUntil).toBe(1000 + SIMULATION_LEASE_MS);
  });

  it('survives the JSON hop to the page', () => {
    const config = captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN, armed(), 1000);
    const received = JSON.parse(JSON.stringify(config)) as typeof config;
    expect(received.simulation).toEqual(config.simulation);
    expect(activeSimulationRules(received, 1000)).toHaveLength(1);
  });
});

describe('activeSimulationRules', () => {
  const config = captureConfigFrom(settingsWith([ORIGIN]), true, ORIGIN, armed(), 1000);

  it('returns the rules while the lease is valid', () => {
    expect(activeSimulationRules(config, 1000 + SIMULATION_LEASE_MS - 1)).toHaveLength(1);
  });

  it('returns nothing once the lease has expired', () => {
    expect(activeSimulationRules(config, 1000 + SIMULATION_LEASE_MS)).toEqual([]);
  });

  it('returns nothing when capture is disabled or simulation is absent', () => {
    expect(activeSimulationRules({ ...config, enabled: false }, 1000)).toEqual([]);
    expect(activeSimulationRules(DEFAULT_CAPTURE_CONFIG, 1000)).toEqual([]);
  });

  it('returns nothing for a malformed lease', () => {
    const forged = { ...config, simulation: { rules: config.simulation!.rules, leaseUntil: 'later' } };
    expect(activeSimulationRules(forged as unknown as typeof config, 1000)).toEqual([]);
  });
});

describe('isArmedOrigin', () => {
  it('requires the master switch, the allowlist and an enabled rule', () => {
    const settings = settingsWith([ORIGIN]);
    expect(isArmedOrigin(settings, armed(), ORIGIN)).toBe(true);
    expect(isArmedOrigin(settings, DISARMED, ORIGIN)).toBe(false);
    expect(isArmedOrigin(settings, armed(), 'http://localhost:4000')).toBe(false);
    expect(isArmedOrigin(settings, armed(normalizeSimulationRules([rule({ enabled: false })])), ORIGIN)).toBe(
      false,
    );
  });
});

describe('simulated marker on page drafts', () => {
  const marker = { ruleId: 'r1', ruleName: 'Orders fail', action: 'mock', delayMs: 250, sent: false };

  it('is validated and kept by sanitizeDraft', () => {
    const out = sanitizeDraft({ ...draft(), simulated: marker }, 1024);
    expect(out!.simulated).toEqual(marker);
  });

  it('is dropped when malformed', () => {
    expect(sanitizeDraft({ ...draft(), simulated: { ...marker, action: 'pwn' } }, 1024)!.simulated).toBe(
      undefined,
    );
    expect(sanitizeDraft({ ...draft(), simulated: 'yes' }, 1024)!.simulated).toBeUndefined();
    expect(sanitizeDraft(draft(), 1024)!.simulated).toBeUndefined();
  });

  it('clamps and defaults its fields', () => {
    expect(sanitizeSimulatedInfo({ ruleId: 'r', action: 'delay', delayMs: 1e12, sent: 'yes' })).toEqual({
      ruleId: 'r',
      ruleName: 'r',
      action: 'delay',
      delayMs: 120_000,
      sent: false,
    });
  });
});
