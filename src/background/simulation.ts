// Worker-side simulation state: rules are durable (chrome.storage.local), the
// master switch is not (chrome.storage.session), so a browser restart or an
// extension reload always leaves simulation disarmed.
import type {
  SimulationChangeFailure,
  SimulationProbeResponse,
  SimulationRuleChange,
} from '../shared/messages';
import {
  MAX_SIMULATION_RULES,
  SIMULATION_ARMED_KEY,
  SIMULATION_RULES_KEY,
  normalizeSimulationRules,
  sanitizeSimulationAck,
  simulationRuleProblems,
} from '../shared/simulation';
import type { SimulationAck, SimulationRule, SimulationState } from '../shared/simulation';
import { createId } from '../shared/util';

export async function loadSimulationState(): Promise<SimulationState> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(SIMULATION_RULES_KEY),
    chrome.storage.session.get(SIMULATION_ARMED_KEY),
  ]);
  return {
    armed: session[SIMULATION_ARMED_KEY] === true,
    rules: normalizeSimulationRules(local[SIMULATION_RULES_KEY]),
  };
}

export async function setSimulationArmed(armed: boolean): Promise<void> {
  if (armed) await chrome.storage.session.set({ [SIMULATION_ARMED_KEY]: true });
  else await chrome.storage.session.remove(SIMULATION_ARMED_KEY);
}

export async function saveSimulationRules(rules: SimulationRule[]): Promise<void> {
  await chrome.storage.local.set({ [SIMULATION_RULES_KEY]: rules });
}

// What the worker last sent each tab, kept in session storage (the worker may be
// restarted at any time): the revision, when, and to which document if known.
const SENT_PREFIX = 'simulationSent:';

export interface SimulationSent {
  revision: string;
  sentAt: number;
  documentId?: string;
}

export async function getSimulationSent(tabId: number): Promise<SimulationSent | undefined> {
  const key = `${SENT_PREFIX}${tabId}`;
  return (await chrome.storage.session.get(key))[key] as SimulationSent | undefined;
}

/**
 * Records that a tab was sent rules with `revision` (undefined: no rules). Writes
 * only when the revision or the receiving document changes, so lease renewals add
 * no writes and a reloaded page has to acknowledge again.
 */
export async function recordSimulationSent(
  tabId: number,
  revision: string | undefined,
  documentId?: string,
  now = Date.now(),
): Promise<void> {
  const key = `${SENT_PREFIX}${tabId}`;
  const previous = await getSimulationSent(tabId);
  if (revision === undefined) {
    if (previous) await chrome.storage.session.remove(key);
    return;
  }
  const sameDocument = documentId === undefined || previous?.documentId === documentId;
  if (previous?.revision === revision && sameDocument) return;
  const next: SimulationSent = { revision, sentAt: now, documentId: documentId ?? previous?.documentId };
  await chrome.storage.session.set({ [key]: next });
}

export async function forgetSimulationSent(tabId: number): Promise<void> {
  await chrome.storage.session.remove(`${SENT_PREFIX}${tabId}`);
}

/**
 * Asks the bridge in the tab's top frame which simulation its page applies. Only
 * the tab's current document can answer; undefined when none does (no bridge, the
 * extension was reloaded, or no answer within `timeoutMs`).
 */
export async function probePageSimulation(
  tabId: number,
  timeoutMs = 1000,
): Promise<SimulationAck | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const answer = chrome.tabs
    .sendMessage(tabId, { type: 'simulation-probe' }, { frameId: 0 })
    .then((r: SimulationProbeResponse | undefined) => (r ? sanitizeSimulationAck(r.ack) : undefined))
    .catch(() => undefined);
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type SimulationChangeResult =
  { ok: true; rules: SimulationRule[]; id?: string } | SimulationChangeFailure;

const CONFLICT =
  'This rule was changed in another window or tab. The latest rules are shown; apply your change again.';
const NOT_FOUND = 'This rule no longer exists (it was deleted in another window or tab).';

/**
 * Applies one edit from an extension page to the rules stored now. Pure: the
 * worker loads, applies and saves inside its serial queue. A rule is validated
 * here as well as in the editor, and saved in its normalized form.
 */
export function applySimulationRuleChange(
  rules: readonly SimulationRule[],
  change: SimulationRuleChange,
  now: number,
  newId: () => string = createId,
): SimulationChangeResult {
  const fail = (reason: SimulationChangeFailure['reason'], message: string): SimulationChangeFailure => ({
    ok: false,
    reason,
    message,
  });
  // Strictly increasing, so a stale copy is always detected (and per-rule counters restart).
  const stamp = (previous = 0) => Math.max(now, previous + 1);
  const build = (raw: unknown, base: Pick<SimulationRule, 'id' | 'createdFrom' | 'updatedAt'>) => {
    const problems = simulationRuleProblems(raw);
    if (Object.keys(problems).length) {
      return {
        ...fail('invalid', `The rule was not saved: ${Object.values(problems).join(' ')}`),
        problems,
      } satisfies SimulationChangeFailure;
    }
    const [rule] = normalizeSimulationRules([
      { ...(raw as object), id: base.id, createdFrom: base.createdFrom, updatedAt: stamp(base.updatedAt) },
    ]);
    return rule ?? fail('invalid', 'The rule was not saved: it is not a valid rule.');
  };
  const find = (id: string, expectedUpdatedAt: number) => {
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) return fail('not-found', NOT_FOUND);
    if (rules[index]!.updatedAt !== expectedUpdatedAt) return fail('conflict', CONFLICT);
    return index;
  };

  switch (change.op) {
    case 'create': {
      if (rules.length >= MAX_SIMULATION_RULES)
        return fail('limit', `At most ${MAX_SIMULATION_RULES} rules can be saved. Delete one first.`);
      const raw = change.rule;
      const createdFrom =
        typeof raw === 'object' && raw !== null ? (raw as Partial<SimulationRule>).createdFrom : undefined;
      const rule = build(raw, { id: newId(), createdFrom, updatedAt: 0 });
      if ('ok' in rule) return rule;
      return { ok: true, rules: [...rules, rule], id: rule.id };
    }
    case 'update': {
      const raw = change.rule;
      const id = typeof raw === 'object' && raw !== null ? (raw as Partial<SimulationRule>).id : undefined;
      if (typeof id !== 'string') return fail('invalid', 'The rule was not saved: it has no id.');
      const index = find(id, change.expectedUpdatedAt);
      if (typeof index !== 'number') return index;
      const stored = rules[index]!;
      // Provenance is never edited, so it is kept from the stored rule.
      const rule = build(raw, stored);
      if ('ok' in rule) return rule;
      return { ok: true, rules: rules.map((r, i) => (i === index ? rule : r)), id };
    }
    case 'set-enabled': {
      const index = find(change.id, change.expectedUpdatedAt);
      if (typeof index !== 'number') return index;
      const stored = rules[index]!;
      const rule = { ...stored, enabled: change.enabled === true, updatedAt: stamp(stored.updatedAt) };
      return { ok: true, rules: rules.map((r, i) => (i === index ? rule : r)), id: change.id };
    }
    case 'delete': {
      const index = find(change.id, change.expectedUpdatedAt);
      if (typeof index !== 'number') return index;
      return { ok: true, rules: rules.filter((_, i) => i !== index) };
    }
    case 'reorder': {
      const current = rules.map((r) => r.id);
      if (!sameList(current, change.expectedIds)) return fail('conflict', CONFLICT);
      if (!Array.isArray(change.ids) || !sameList([...change.ids].sort(), [...current].sort()))
        return fail('invalid', 'The new order must list every rule exactly once.');
      const byId = new Map(rules.map((r) => [r.id, r]));
      return { ok: true, rules: change.ids.map((id) => byId.get(id)!) };
    }
  }
  return fail('invalid', 'Unknown change.');
}

const sameList = (a: readonly unknown[], b: unknown) =>
  Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
