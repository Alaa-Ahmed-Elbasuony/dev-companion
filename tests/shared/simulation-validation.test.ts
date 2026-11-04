import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import {
  MAX_MOCK_BODY_BYTES,
  normalizeSimulationRules,
  pageSimulationStatus,
  simulationRuleProblems,
} from '../../src/shared/simulation';

const valid = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'Items down',
  enabled: true,
  match: { methods: ['GET'], urlPattern: '/api/items', query: 'ignore' },
  action: { kind: 'mock', status: 503, headers: [], body: '{}', bodyKind: 'json' },
  delayMs: 0,
  pattern: { kind: 'always' },
  allowSensitive: false,
  ...over,
});
const mock = (action: Record<string, unknown>) =>
  valid({ action: { kind: 'mock', status: 200, headers: [], body: '', bodyKind: 'json', ...action } });

describe('simulationRuleProblems', () => {
  it('accepts every supported rule type', () => {
    expect(simulationRuleProblems(valid())).toEqual({});
    expect(simulationRuleProblems(valid({ action: { kind: 'delay' }, delayMs: 300 }))).toEqual({});
    for (const mode of ['network-error', 'hang'])
      expect(simulationRuleProblems(valid({ action: { kind: 'fail', mode } }))).toEqual({});
    expect(
      simulationRuleProblems(valid({ action: { kind: 'fail', mode: 'timeout', timeoutMs: 500 } })),
    ).toEqual({});
  });

  it('rejects what normalization would silently coerce', () => {
    expect(simulationRuleProblems(mock({ status: 700 })).status).toMatch(/200 to 599/);
    expect(simulationRuleProblems(mock({ status: 100 })).status).toBeDefined();
    expect(simulationRuleProblems(mock({ status: 200.5 })).status).toBeDefined();
    expect(simulationRuleProblems(mock({ status: Number.NaN })).status).toBeDefined();
    expect(simulationRuleProblems(valid({ delayMs: 120_001 })).delayMs).toBeDefined();
    expect(simulationRuleProblems(valid({ delayMs: -1 })).delayMs).toBeDefined();
    expect(
      simulationRuleProblems(valid({ pattern: { kind: 'random', percent: 101 } })).pattern,
    ).toBeDefined();
    expect(simulationRuleProblems(valid({ pattern: { kind: 'first-n', n: 0 } })).pattern).toBeDefined();
    expect(simulationRuleProblems(valid({ pattern: { kind: 'every-nth', n: 1.5 } })).pattern).toBeDefined();
    expect(
      simulationRuleProblems(valid({ action: { kind: 'fail', mode: 'timeout', timeoutMs: 999_999 } }))
        .timeoutMs,
    ).toBeDefined();
  });

  it('checks the URL pattern', () => {
    const p = (urlPattern: unknown) =>
      simulationRuleProblems(valid({ match: { methods: [], urlPattern } })).urlPattern;
    expect(p('')).toMatch(/Enter a URL pattern/);
    expect(p('   ')).toBeDefined();
    expect(p(undefined)).toBeDefined();
    expect(p('/api/a b')).toMatch(/spaces/);
    expect(p('ws://localhost:3000/socket')).toMatch(/http/);
    expect(p('x'.repeat(2001))).toBeDefined();
    for (const ok of ['/api/*', 'localhost:3000/api/:id', 'https://app.test/api?x=*'])
      expect(p(ok)).toBeUndefined();
  });

  it('checks methods, headers, status text and the body', () => {
    expect(
      simulationRuleProblems(valid({ match: { methods: ['GET', 'P0ST'], urlPattern: '/a' } })).methods,
    ).toBeDefined();
    expect(
      simulationRuleProblems(mock({ headers: [{ name: 'bad name', value: 'x' }] })).headers,
    ).toBeDefined();
    expect(simulationRuleProblems(mock({ headers: [{ name: 'x-a', value: 'a\nb' }] })).headers).toBeDefined();
    expect(
      simulationRuleProblems(mock({ headers: [{ name: 'X-Ok', value: 'fine' }] })).headers,
    ).toBeUndefined();
    expect(simulationRuleProblems(mock({ statusText: 'Ünicode' })).statusText).toBeDefined();
    expect(simulationRuleProblems(mock({ status: 204, body: 'x' })).body).toMatch(/204 cannot have a body/);
    expect(simulationRuleProblems(mock({ status: 204, body: '' })).body).toBeUndefined();
    expect(simulationRuleProblems(mock({ body: 'x'.repeat(MAX_MOCK_BODY_BYTES + 1) })).body).toMatch(/1 MB/);
    expect(simulationRuleProblems(mock({ bodyKind: 'xml' })).body).toBeDefined();
  });

  it('requires a delay for delay rules and a known action', () => {
    expect(simulationRuleProblems(valid({ action: { kind: 'delay' }, delayMs: 0 })).delayMs).toMatch(
      /above 0/,
    );
    expect(simulationRuleProblems(valid({ action: { kind: 'teleport' } })).action).toBeDefined();
    expect(simulationRuleProblems(valid({ action: { kind: 'fail', mode: 'explode' } })).action).toBeDefined();
    expect(simulationRuleProblems(null)).toEqual({ action: 'Not a rule.' });
  });

  it('agrees with normalization for valid rules (nothing is changed on save)', () => {
    const rule = valid({ delayMs: 250, pattern: { kind: 'every-nth', n: 3 }, updatedAt: 5 });
    const [normalized] = normalizeSimulationRules([rule]);
    expect(normalized).toMatchObject({
      match: rule.match,
      action: { kind: 'mock', status: 503, body: '{}', bodyKind: 'json', headers: [] },
      delayMs: 250,
      pattern: { kind: 'every-nth', n: 3 },
    });
  });
});

describe('pageSimulationStatus', () => {
  const ORIGIN = 'http://localhost:3000';
  const rules = normalizeSimulationRules([valid()]);
  const settings = { ...DEFAULT_SETTINGS, simulationOrigins: [ORIGIN] };
  const armed = { armed: true, rules };

  it('is active only when armed, allowlisted, recording, not paused and with an enabled rule', () => {
    const rec = { origin: ORIGIN, paused: false };
    expect(pageSimulationStatus(settings, armed, rec, ORIGIN, 0)).toEqual({
      origin: ORIGIN,
      recording: true,
      paused: false,
      allowlisted: true,
      active: true,
    });
    expect(pageSimulationStatus(settings, { ...armed, armed: false }, rec, ORIGIN, 0).active).toBe(false);
    expect(pageSimulationStatus(DEFAULT_SETTINGS, armed, rec, ORIGIN, 0)).toMatchObject({
      allowlisted: false,
      active: false,
    });
    expect(pageSimulationStatus(settings, armed, { ...rec, paused: true }, ORIGIN, 0)).toMatchObject({
      paused: true,
      active: false,
    });
    expect(pageSimulationStatus(settings, armed, null, ORIGIN, 0)).toMatchObject({
      recording: false,
      active: false,
    });
    const disabled = normalizeSimulationRules([valid({ enabled: false })]);
    expect(pageSimulationStatus(settings, { armed: true, rules: disabled }, rec, ORIGIN, 0).active).toBe(
      false,
    );
  });

  it('is not active when the tab navigated away from the recorded origin', () => {
    const s = pageSimulationStatus(settings, armed, { origin: ORIGIN }, 'http://localhost:4000', 0);
    expect(s).toMatchObject({ recording: false, allowlisted: false, active: false });
  });
});
