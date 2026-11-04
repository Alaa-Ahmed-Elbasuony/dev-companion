// The rule editor's form: round trips, preserved fields, validation and labels.
import { describe, expect, it } from 'vitest';
import type { SimulationStateResponse } from '../../src/shared/messages';
import { normalizeSimulationRules } from '../../src/shared/simulation';
import {
  actionLabel,
  formFromRule,
  moveId,
  patternSensitivity,
  ruleFromForm,
  ruleWarnings,
  simulationBlockers,
  whenLabel,
} from '../../src/ui/lib/simulation';

const [MOCK] = normalizeSimulationRules([
  {
    id: 'm1',
    name: 'Orders down',
    enabled: true,
    match: { methods: ['GET', 'PROPFIND'], urlPattern: 'localhost:3000/api/orders?page=*', query: 'exact' },
    action: {
      kind: 'mock',
      status: 503,
      statusText: 'Service Unavailable',
      headers: [{ name: 'x-mock', value: 'a: b' }],
      body: '{"error":"down"}',
      bodyKind: 'json',
    },
    delayMs: 150,
    pattern: { kind: 'every-nth', n: 3 },
    allowSensitive: true,
    createdFrom: { entryId: 'e9', endpointKey: 'GET /api/orders' },
    updatedAt: 42,
  },
]);

describe('rule form', () => {
  it('round-trips every stored field, including ones the form does not show', () => {
    const { rule, problems } = ruleFromForm(formFromRule(MOCK), MOCK);
    expect(problems).toEqual({});
    expect(normalizeSimulationRules([rule])[0]).toEqual(MOCK);
  });

  it('keeps id, provenance and timestamp while changing only the edited field', () => {
    const form = { ...formFromRule(MOCK), name: 'Renamed' };
    const { rule } = ruleFromForm(form, MOCK);
    expect(rule).toMatchObject({
      id: 'm1',
      name: 'Renamed',
      createdFrom: MOCK!.createdFrom,
      updatedAt: 42,
      match: { methods: ['GET', 'PROPFIND'], query: 'exact' },
      action: {
        status: 503,
        statusText: 'Service Unavailable',
        headers: [{ name: 'x-mock', value: 'a: b' }],
      },
    });
  });

  it('round-trips the failure kinds and patterns', () => {
    const rules = normalizeSimulationRules([
      {
        id: 't',
        match: { urlPattern: '/a' },
        action: { kind: 'fail', mode: 'timeout', timeoutMs: 700 },
        pattern: { kind: 'random', percent: 30 },
      },
      {
        id: 'h',
        match: { urlPattern: '/b' },
        action: { kind: 'fail', mode: 'hang' },
        pattern: { kind: 'first-n', n: 2 },
      },
      { id: 'n', match: { urlPattern: '/c' }, action: { kind: 'fail', mode: 'network-error' } },
      { id: 'd', match: { urlPattern: '/d' }, action: { kind: 'delay' }, delayMs: 900 },
    ]);
    for (const r of rules)
      expect(normalizeSimulationRules([ruleFromForm(formFromRule(r), r).rule])[0]).toEqual(r);
  });

  it('has sensible defaults for a new rule', () => {
    const form = formFromRule();
    expect(form).toMatchObject({
      enabled: true,
      kind: 'mock',
      status: '200',
      bodyKind: 'json',
      when: 'always',
    });
    expect(form.allowSensitive).toBe(false);
    // Only the URL pattern is required.
    expect(ruleFromForm(form).problems).toEqual({ urlPattern: 'Enter a URL pattern.' });
    expect(ruleFromForm({ ...form, urlPattern: '/api/x' }).problems).toEqual({});
  });

  it('reports invalid input instead of coercing it', () => {
    const form = { ...formFromRule(), urlPattern: '/api/x' };
    expect(ruleFromForm({ ...form, status: '' }).problems.status).toBeDefined();
    expect(ruleFromForm({ ...form, status: 'abc' }).problems.status).toBeDefined();
    expect(ruleFromForm({ ...form, delayMs: '-5' }).problems.delayMs).toBeDefined();
    expect(ruleFromForm({ ...form, headers: 'no colon here' }).problems.headers).toMatch(/Name: value/);
    expect(ruleFromForm({ ...form, kind: 'delay', delayMs: '0' }).problems.delayMs).toMatch(/above 0/);
    expect(ruleFromForm({ ...form, kind: 'timeout', timeoutMs: '' }).problems.timeoutMs).toBeDefined();
    expect(ruleFromForm({ ...form, when: 'first-n', firstN: '0' }).problems.pattern).toBeDefined();
    expect(ruleFromForm({ ...form, methods: 'GET, P0ST' }).problems.methods).toBeDefined();
  });

  it('drops mock fields only when the user changes the rule type', () => {
    const { rule } = ruleFromForm({ ...formFromRule(MOCK), kind: 'network-error' }, MOCK);
    expect((rule as { action: unknown }).action).toEqual({ kind: 'fail', mode: 'network-error' });
  });

  it('warns about sensitive patterns, host-like paths and invalid JSON', () => {
    const form = formFromRule();
    expect(ruleWarnings({ ...form, urlPattern: '/api/auth/login' }).join()).toMatch(/authentication/);
    expect(ruleWarnings({ ...form, urlPattern: '/api/auth/login', allowSensitive: true })).toEqual([]);
    expect(ruleWarnings({ ...form, urlPattern: 'api/orders' }).join()).toMatch(/host name/);
    expect(ruleWarnings({ ...form, urlPattern: 'localhost/api' })).toEqual([]);
    expect(ruleWarnings({ ...form, urlPattern: '/a', body: '{oops' }).join()).toMatch(/not valid JSON/);
    expect(ruleWarnings({ ...form, urlPattern: '/a', body: '{oops', bodyKind: 'text' })).toEqual([]);
    expect(patternSensitivity('localhost:3000/checkout/:id')).toBe('payment');
    expect(patternSensitivity('/api/*')).toBeUndefined();
  });
});

describe('labels', () => {
  it('describes what a rule does and when', () => {
    expect(actionLabel(MOCK!)).toBe('Mock 503 (150 ms delay first)');
    const [delay, timeout] = normalizeSimulationRules([
      { id: 'd', match: { urlPattern: '/d' }, action: { kind: 'delay' }, delayMs: 900 },
      { id: 't', match: { urlPattern: '/t' }, action: { kind: 'fail', mode: 'timeout', timeoutMs: 700 } },
    ]);
    expect(actionLabel(delay!)).toBe('Delay 900 ms, then send');
    expect(actionLabel(timeout!)).toBe('Timeout after 700 ms');
    expect(whenLabel({ kind: 'always' })).toBe('Every matching request');
    expect(whenLabel({ kind: 'every-nth', n: 3 })).toBe('Every 3rd matching request');
    expect(whenLabel({ kind: 'every-nth', n: 11 })).toBe('Every 11th matching request');
    expect(whenLabel({ kind: 'first-n', n: 1 })).toBe('First matching request');
    expect(whenLabel({ kind: 'random', percent: 25 })).toBe('25% of matching requests');
  });

  it('moves a rule by one place, clamped at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
  });
});

describe('simulationBlockers', () => {
  const base: SimulationStateResponse = {
    armed: true,
    enabledRules: 1,
    origins: ['http://localhost:3000'],
    rules: [MOCK!],
    page: {
      origin: 'http://localhost:3000',
      recording: true,
      paused: false,
      allowlisted: true,
      active: true,
    },
  };

  it('is empty while the tab receives rules', () => {
    expect(simulationBlockers(base)).toEqual([]);
  });

  it('explains every reason simulation cannot run', () => {
    expect(simulationBlockers({ ...base, armed: false, page: { ...base.page!, active: false } })).toEqual([
      'Simulation is turned off.',
    ]);
    expect(simulationBlockers({ ...base, enabledRules: 0, page: { ...base.page!, active: false } })).toEqual([
      'No rule is enabled.',
    ]);
    expect(
      simulationBlockers({ ...base, rules: [], enabledRules: 0, page: { ...base.page!, active: false } }),
    ).toEqual(['There are no rules yet.']);
    expect(simulationBlockers({ ...base, page: { ...base.page!, paused: true, active: false } })).toEqual([
      'Recording is paused, so simulation is paused too.',
    ]);
    expect(
      simulationBlockers({
        ...base,
        page: { ...base.page!, recording: false, allowlisted: false, active: false },
      }),
    ).toEqual([
      'This tab is not recording http://localhost:3000.',
      'http://localhost:3000 is not on the allowlist.',
    ]);
    expect(simulationBlockers({ ...base, page: undefined }).join()).toMatch(/No tab is selected/);
  });

  it('never reports a switched-on, allowlisted page as running unless the worker says so', () => {
    expect(simulationBlockers({ ...base, page: { ...base.page!, active: false } })).toEqual([
      'The tab does not receive rules right now.',
    ]);
  });
});
