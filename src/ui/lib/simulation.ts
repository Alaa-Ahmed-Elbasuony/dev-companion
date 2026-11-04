// Simulation UI state: the worker's view of the rules, the master switch and the
// current tab, plus conversion between rules and the editor's form. Every change
// goes through the worker, which validates it and rejects edits made from a stale copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sensitiveCategory } from '../../analysis/simulation-match';
import type {
  SimulationRuleChange,
  SimulationStateResponse,
  SimulationUpdateResponse,
} from '../../shared/messages';
import { SIMULATION_ARMED_KEY, SIMULATION_RULES_KEY, simulationRuleProblems } from '../../shared/simulation';
import type {
  FailurePattern,
  PageSimulationStatus,
  SimulationAction,
  SimulationRule,
  SimulationRuleField,
} from '../../shared/simulation';
import type { HeaderPair } from '../../shared/types';
import { sendToWorker } from './extension';

export type Problems = Partial<Record<SimulationRuleField, string>>;

export function workerErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/context invalidated/i.test(text))
    return 'The extension was reloaded or updated. Reload this page to continue.';
  return `The extension did not respond: ${text}`;
}

function checkedState(res: unknown): SimulationStateResponse {
  const s = res as SimulationStateResponse | undefined;
  if (!s || typeof s.armed !== 'boolean' || !Array.isArray(s.rules)) {
    const message = (res as { message?: string; reason?: string } | undefined)?.message;
    throw new Error(message ?? (res as { reason?: string } | undefined)?.reason ?? 'unexpected response');
  }
  return s;
}

/**
 * The simulation state as the worker reports it, refreshed when rules, the
 * allowlist, the switch or the tab change. Only the newest response is shown.
 */
export function useSimulationState(tabId: number | undefined, version: number) {
  const [state, setState] = useState<SimulationStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const next = checkedState(await sendToWorker({ type: 'get-simulation-state', tabId }));
      if (id !== seq.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (id === seq.current) setError(workerErrorText(err));
    }
  }, [tabId]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  useEffect(() => {
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        (area === 'local' && (changes[SIMULATION_RULES_KEY] || changes.settings)) ||
        (area === 'session' && changes[SIMULATION_ARMED_KEY])
      )
        void refresh();
    };
    const onTab = (id: number, info: { url?: string; status?: string }) => {
      if (id === tabId && (info.url || info.status === 'complete')) void refresh();
    };
    // The worker relays when the tab's page applies a different simulation.
    const onMessage = (message: { type?: string; tabId?: number }) => {
      if (message?.type === 'simulation-page-changed' && message.tabId === tabId) void refresh();
    };
    chrome.storage.onChanged.addListener(onStorage);
    chrome.runtime.onMessage?.addListener(onMessage);
    const tabEvents = chrome.tabs?.onUpdated;
    if (typeof tabEvents?.addListener === 'function') tabEvents.addListener(onTab);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage?.removeListener(onMessage);
      if (typeof tabEvents?.removeListener === 'function') tabEvents.removeListener(onTab);
    };
  }, [refresh, tabId]);

  // While the page has not confirmed rules it was sent, look once more when the wait ends.
  const ackDeadline = state?.page?.delivery === 'sent' ? state.page.ackDeadline : undefined;
  useEffect(() => {
    if (ackDeadline === undefined) return;
    const timer = setTimeout(() => void refresh(), Math.max(0, ackDeadline - Date.now()) + 100);
    return () => clearTimeout(timer);
  }, [ackDeadline, refresh]);

  /** Sends one change; resolves with the worker's answer (which always carries the latest state). */
  const update = useCallback(
    async (change: SimulationRuleChange): Promise<SimulationUpdateResponse> => {
      const res = (await sendToWorker({ type: 'update-simulation-rules', change })) as
        SimulationUpdateResponse | undefined;
      const latest = checkedState(res?.state ?? res);
      // Newer than any refresh still in flight; the tab status follows with the refresh.
      ++seq.current;
      setState((prev) => ({ ...latest, page: prev?.page }));
      void refresh();
      return { ...res!, state: latest };
    },
    [refresh],
  );

  const setArmed = useCallback(
    async (armed: boolean): Promise<SimulationStateResponse> => {
      const latest = checkedState(await sendToWorker({ type: 'set-simulation-armed', armed }));
      ++seq.current;
      setState((prev) => ({ ...latest, page: prev?.page }));
      await refresh();
      return latest;
    },
    [refresh],
  );

  return { state, error, refresh, update, setArmed };
}

/** The badge for the tab, and an explanation when the page has not confirmed the rules. */
export function simulationDeliveryText(page: PageSimulationStatus | undefined): {
  badge: string;
  detail?: string;
} {
  if (!page?.active) return { badge: 'Not running on this tab' };
  switch (page.delivery) {
    case 'acknowledged':
      return { badge: 'Active on this tab' };
    case 'sent':
      return {
        badge: 'Sent to this tab, not confirmed yet',
        detail: 'The rules were sent to the page; it has not confirmed that it applies them yet.',
      };
    case 'timed-out':
      return {
        badge: 'Not confirmed by this tab',
        detail:
          'The rules were sent, but the page did not confirm them. Requests may not be simulated: reload the page.',
      };
    case 'not-connected':
      return {
        badge: 'Page not connected',
        detail:
          'Dev Companion is not connected to this page, so it cannot simulate. Reload the page to connect it.',
      };
    default:
      return {
        badge: 'Saved, not sent to this tab yet',
        detail:
          'The rules are saved; this page has not received them yet. Reload it if this does not change.',
      };
  }
}

/** Why simulation is not running on the tab; empty when it is. */
export function simulationBlockers(state: SimulationStateResponse): string[] {
  const out: string[] = [];
  if (!state.armed) out.push('Simulation is turned off.');
  if (!state.rules.length) out.push('There are no rules yet.');
  else if (!state.enabledRules) out.push('No rule is enabled.');
  const page = state.page;
  if (!page) {
    out.push('No tab is selected. Open this workspace from the toolbar popup of the tab you are testing.');
    return out;
  }
  if (!page.recording)
    out.push(page.origin ? `This tab is not recording ${page.origin}.` : 'This tab is not recording.');
  else if (page.paused) out.push('Recording is paused, so simulation is paused too.');
  if (page.origin && !page.allowlisted) out.push(`${page.origin} is not on the allowlist.`);
  if (!out.length && !page.active) out.push('The tab does not receive rules right now.');
  return out;
}

export type RuleKind = 'mock' | 'delay' | 'network-error' | 'timeout' | 'hang';

export const RULE_KINDS: { id: RuleKind; label: string }[] = [
  { id: 'mock', label: 'Mock a response' },
  { id: 'delay', label: 'Delay, then send the real request' },
  { id: 'network-error', label: 'Network error' },
  { id: 'timeout', label: 'Timeout' },
  { id: 'hang', label: 'Hang (never respond)' },
];

export const kindOf = (action: SimulationAction): RuleKind =>
  action.kind === 'fail' ? action.mode : action.kind;

/** Default for a new timeout rule (the same as normalizeSimulationRules uses). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The editor's fields, as typed. */
export interface RuleForm {
  name: string;
  enabled: boolean;
  urlPattern: string;
  methods: string;
  query: 'ignore' | 'exact';
  kind: RuleKind;
  status: string;
  statusText: string;
  headers: string;
  body: string;
  bodyKind: 'json' | 'text';
  timeoutMs: string;
  delayMs: string;
  when: FailurePattern['kind'];
  percent: string;
  firstN: string;
  everyNth: string;
  allowSensitive: boolean;
}

export function formFromRule(rule?: SimulationRule): RuleForm {
  const action = rule?.action;
  const mock = action?.kind === 'mock' ? action : undefined;
  const p = rule?.pattern;
  return {
    name: rule?.name ?? '',
    enabled: rule?.enabled ?? true,
    urlPattern: rule?.match.urlPattern ?? '',
    methods: rule?.match.methods.join(', ') ?? '',
    query: rule?.match.query ?? 'ignore',
    kind: action ? kindOf(action) : 'mock',
    status: String(mock?.status ?? 200),
    statusText: mock?.statusText ?? '',
    headers: (mock?.headers ?? []).map((h) => `${h.name}: ${h.value}`).join('\n'),
    body: mock?.body ?? '',
    bodyKind: mock?.bodyKind ?? 'json',
    timeoutMs: String(
      action?.kind === 'fail' ? (action.timeoutMs ?? DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    ),
    delayMs: String(rule?.delayMs ?? 0),
    when: p?.kind ?? 'always',
    percent: String(p?.kind === 'random' ? p.percent : 50),
    firstN: String(p?.kind === 'first-n' ? p.n : 1),
    everyNth: String(p?.kind === 'every-nth' ? p.n : 2),
    allowSensitive: rule?.allowSensitive ?? false,
  };
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s.trim()));

/**
 * The rule the form describes, on top of `base` (the rule being edited), so
 * fields the form does not show (id, provenance, timestamps) are kept.
 */
export function ruleFromForm(form: RuleForm, base?: SimulationRule): { rule: unknown; problems: Problems } {
  const problems: Problems = {};
  const headers: HeaderPair[] = [];
  for (const line of form.headers.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i <= 0) {
      problems.headers = `“${line.trim()}” is not in the form “Name: value”.`;
      continue;
    }
    headers.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  const action =
    form.kind === 'mock'
      ? {
          kind: 'mock',
          status: num(form.status),
          statusText: form.statusText.trim() || undefined,
          headers,
          body: form.body,
          bodyKind: form.bodyKind,
        }
      : form.kind === 'delay'
        ? { kind: 'delay' }
        : form.kind === 'timeout'
          ? { kind: 'fail', mode: 'timeout', timeoutMs: num(form.timeoutMs) }
          : { kind: 'fail', mode: form.kind };
  const pattern =
    form.when === 'random'
      ? { kind: 'random', percent: num(form.percent) }
      : form.when === 'first-n'
        ? { kind: 'first-n', n: num(form.firstN) }
        : form.when === 'every-nth'
          ? { kind: 'every-nth', n: num(form.everyNth) }
          : { kind: 'always' };
  const rule = {
    ...base,
    name: form.name.trim(),
    enabled: form.enabled,
    match: {
      methods: form.methods
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((m) => m.toUpperCase()),
      urlPattern: form.urlPattern.trim(),
      query: form.query,
    },
    action,
    delayMs: form.delayMs.trim() === '' ? 0 : num(form.delayMs),
    pattern,
    allowSensitive: form.allowSensitive,
  };
  return { rule, problems: { ...simulationRuleProblems(rule), ...problems } };
}

/** The sensitive category a literal pattern targets (wildcards and :params count as plain segments). */
export function patternSensitivity(urlPattern: string): 'authentication' | 'payment' | undefined {
  const p = (urlPattern.trim().split('?')[0] ?? '').replace(/\*+/g, 'x').replace(/:[A-Za-z_][\w-]*/g, 'x');
  if (!p) return undefined;
  const url = /^https?:\/\//i.test(p) ? p : p.startsWith('/') ? `http://example.invalid${p}` : `http://${p}`;
  return sensitiveCategory(url);
}

/** Advice that does not block saving. */
export function ruleWarnings(form: RuleForm): string[] {
  const out: string[] = [];
  const pattern = form.urlPattern.trim();
  const sensitive = patternSensitivity(pattern);
  if (sensitive && !form.allowSensitive)
    out.push(
      `This pattern targets ${sensitive} endpoints, which are never simulated unless you allow it below.`,
    );
  const host = pattern.split(/[/?]/)[0] ?? '';
  if (
    pattern &&
    !pattern.startsWith('/') &&
    !/^https?:/i.test(pattern) &&
    host &&
    !/[.:*]/.test(host) &&
    host !== 'localhost'
  )
    out.push(`“${host}” is read as a host name. To match a path on any host, start the pattern with “/”.`);
  if (form.kind === 'mock' && form.bodyKind === 'json' && form.body.trim()) {
    try {
      JSON.parse(form.body);
    } catch {
      out.push('The body is not valid JSON. It is sent exactly as written.');
    }
  }
  return out;
}

export function actionLabel(rule: SimulationRule): string {
  const a = rule.action;
  if (a.kind === 'delay') return `Delay ${rule.delayMs} ms, then send`;
  const label =
    a.kind === 'mock'
      ? `Mock ${a.status}`
      : a.mode === 'timeout'
        ? `Timeout after ${a.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
        : a.mode === 'network-error'
          ? 'Network error'
          : 'Hang';
  return rule.delayMs > 0 ? `${label} (${rule.delayMs} ms delay first)` : label;
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
};

export function whenLabel(pattern: FailurePattern): string {
  if (pattern.kind === 'random') return `${pattern.percent}% of matching requests`;
  if (pattern.kind === 'first-n')
    return pattern.n === 1 ? 'First matching request' : `First ${pattern.n} matching requests`;
  if (pattern.kind === 'every-nth') return `Every ${ordinal(pattern.n)} matching request`;
  return 'Every matching request';
}

/** The ids with one rule moved by `delta` places (clamped). */
export function moveId(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  const out = [...ids];
  if (from === -1 || from === to) return out;
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
}
