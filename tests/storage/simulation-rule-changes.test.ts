// Rule edits from extension pages: applied to the stored rules, validated, and
// rejected when they were made from a stale copy.
import { describe, expect, it } from 'vitest';
import {
  applySimulationRuleChange,
  loadSimulationState,
  saveSimulationRules,
} from '../../src/background/simulation';
import {
  MAX_SIMULATION_RULES,
  SIMULATION_RULES_KEY,
  normalizeSimulationRules,
} from '../../src/shared/simulation';
import type { SimulationRule } from '../../src/shared/simulation';
import { installFakeChrome } from '../helpers/fake-chrome';

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `rule ${id}`,
  enabled: true,
  match: { methods: [], urlPattern: `/api/${id}`, query: 'ignore' },
  action: { kind: 'fail', mode: 'network-error' },
  delayMs: 0,
  pattern: { kind: 'always' },
  allowSensitive: false,
  updatedAt: 10,
  ...over,
});
const RULES = normalizeSimulationRules([rule('a'), rule('b'), rule('c')]);
const ids = (rules: readonly SimulationRule[]) => rules.map((r) => r.id);

function ok(result: ReturnType<typeof applySimulationRuleChange>) {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.message}`);
  return result;
}

describe('applySimulationRuleChange', () => {
  it('creates a rule at the lowest priority with a new id and timestamp', () => {
    const r = ok(
      applySimulationRuleChange(
        RULES,
        { op: 'create', rule: { ...rule('ignored'), id: 'a' } },
        1000,
        () => 'new',
      ),
    );
    expect(ids(r.rules)).toEqual(['a', 'b', 'c', 'new']);
    expect(r.id).toBe('new');
    expect(r.rules[3]).toMatchObject({ id: 'new', updatedAt: 1000, match: { urlPattern: '/api/ignored' } });
    expect(RULES).toHaveLength(3);
  });

  it('rejects invalid rules with per-field problems and changes nothing', () => {
    const bad = {
      ...rule('x'),
      action: { kind: 'mock', status: 999, headers: [], body: '', bodyKind: 'json' },
    };
    const r = applySimulationRuleChange(RULES, { op: 'create', rule: bad }, 1000);
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect(!r.ok && r.problems?.status).toMatch(/200 to 599/);
    const noPattern = { ...rule('x'), match: { methods: [], urlPattern: '' } };
    expect(applySimulationRuleChange(RULES, { op: 'create', rule: noPattern }, 1)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(applySimulationRuleChange(RULES, { op: 'create', rule: 'nope' }, 1)).toMatchObject({ ok: false });
  });

  it('enforces the rule limit', () => {
    const many = normalizeSimulationRules(
      Array.from({ length: MAX_SIMULATION_RULES }, (_, i) => rule(`r${i}`)),
    );
    expect(applySimulationRuleChange(many, { op: 'create', rule: rule('x') }, 1)).toMatchObject({
      ok: false,
      reason: 'limit',
    });
  });

  it('updates a rule in place, keeping its priority and provenance', () => {
    const stored = normalizeSimulationRules([
      rule('a', { createdFrom: { entryId: 'e1', endpointKey: 'GET /api/a' } }),
      rule('b'),
    ]);
    const edited = { ...stored[0]!, name: 'renamed', createdFrom: undefined };
    const r = ok(
      applySimulationRuleChange(stored, { op: 'update', rule: edited, expectedUpdatedAt: 10 }, 2000),
    );
    expect(ids(r.rules)).toEqual(['a', 'b']);
    expect(r.rules[0]).toMatchObject({
      name: 'renamed',
      updatedAt: 2000,
      createdFrom: { entryId: 'e1', endpointKey: 'GET /api/a' },
    });
    expect(r.rules[1]).toBe(stored[1]);
  });

  it('rejects an update made from a stale copy, or of a deleted rule', () => {
    const edited = { ...RULES[1]!, name: 'mine' };
    expect(
      applySimulationRuleChange(RULES, { op: 'update', rule: edited, expectedUpdatedAt: 9 }, 1),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      applySimulationRuleChange(
        RULES,
        { op: 'update', rule: { ...edited, id: 'gone' }, expectedUpdatedAt: 10 },
        1,
      ),
    ).toMatchObject({ ok: false, reason: 'not-found' });
    expect(
      applySimulationRuleChange(RULES, { op: 'update', rule: { name: 'no id' }, expectedUpdatedAt: 10 }, 1),
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('always moves the timestamp forward, even with a clock behind the stored one', () => {
    const r = ok(
      applySimulationRuleChange(
        RULES,
        { op: 'set-enabled', id: 'a', enabled: false, expectedUpdatedAt: 10 },
        5,
      ),
    );
    expect(r.rules[0]).toMatchObject({ enabled: false, updatedAt: 11 });
    // The old timestamp no longer matches, so a second stale toggle is rejected.
    expect(
      applySimulationRuleChange(
        r.rules,
        { op: 'set-enabled', id: 'a', enabled: true, expectedUpdatedAt: 10 },
        6,
      ),
    ).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('enables and disables a single rule without touching the others', () => {
    const r = ok(
      applySimulationRuleChange(
        RULES,
        { op: 'set-enabled', id: 'b', enabled: false, expectedUpdatedAt: 10 },
        99,
      ),
    );
    expect(r.rules.map((x) => x.enabled)).toEqual([true, false, true]);
    expect(r.rules[0]).toBe(RULES[0]);
    expect({ ...r.rules[1], enabled: true, updatedAt: 10 }).toEqual(RULES[1]);
  });

  it('deletes only with the current timestamp', () => {
    expect(
      applySimulationRuleChange(RULES, { op: 'delete', id: 'b', expectedUpdatedAt: 3 }, 1),
    ).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(
      ids(ok(applySimulationRuleChange(RULES, { op: 'delete', id: 'b', expectedUpdatedAt: 10 }, 1)).rules),
    ).toEqual(['a', 'c']);
  });

  it('reorders when the order it was based on is still current', () => {
    const r = ok(
      applySimulationRuleChange(
        RULES,
        { op: 'reorder', ids: ['c', 'a', 'b'], expectedIds: ['a', 'b', 'c'] },
        1,
      ),
    );
    expect(ids(r.rules)).toEqual(['c', 'a', 'b']);
    // Reordering does not change a rule, so its counters keep running.
    expect(r.rules.map((x) => x.updatedAt)).toEqual([10, 10, 10]);
    expect(
      applySimulationRuleChange(
        RULES,
        { op: 'reorder', ids: ['b', 'a', 'c'], expectedIds: ['b', 'a', 'c'] },
        1,
      ),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    for (const bad of [
      ['a', 'b'],
      ['a', 'a', 'b'],
      ['a', 'b', 'x'],
    ])
      expect(
        applySimulationRuleChange(RULES, { op: 'reorder', ids: bad, expectedIds: ['a', 'b', 'c'] }, 1),
      ).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('saveSimulationRules', () => {
  it('stores the rules where the worker loads them from', async () => {
    const { local } = installFakeChrome();
    await saveSimulationRules(RULES);
    expect(local.get(SIMULATION_RULES_KEY)).toEqual(RULES);
    expect((await loadSimulationState()).rules).toEqual(RULES);
  });
});
