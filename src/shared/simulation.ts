// Mock / latency / failure simulation: rule model, validation and the per-page
// configuration slice. Pure, so the main-world bundle and the worker share it.
//
// Safety model: simulation runs only while (1) the tab is recording and not paused,
// (2) the page's origin is allowlisted in settings, and (3) the user armed it.
// The armed flag lives in chrome.storage.session, so a browser restart or an
// extension reload always disarms it. Pages receive the rules with a lease that the
// bridge must keep renewing; an orphaned page (extension reloaded) stops simulating.
import type { CaptureConfig, HeaderPair, Settings } from './types';
import { clip } from './util';

/** chrome.storage.local: the user's rules (durable). */
export const SIMULATION_RULES_KEY = 'simulationRules';
/** chrome.storage.session: master switch (cleared on browser restart and extension reload). */
export const SIMULATION_ARMED_KEY = 'simulationArmed';

/** How long a page may apply rules without hearing from the extension. */
export const SIMULATION_LEASE_MS = 60_000;
/** How often the bridge renews the lease while simulation is active. */
export const SIMULATION_LEASE_RENEW_MS = 20_000;

export const MAX_SIMULATION_RULES = 200;
export const MAX_MOCK_BODY_BYTES = 1024 * 1024;
export const MAX_SIMULATION_DELAY_MS = 120_000;
export const MAX_MOCK_HEADERS = 50;

export type SimulationAction =
  | {
      kind: 'mock';
      status: number;
      statusText?: string;
      headers: HeaderPair[];
      body: string;
      bodyKind: 'json' | 'text';
    }
  /** Sends the real request after the rule's delay. */
  | { kind: 'delay' }
  /** Never sends the request. */
  | { kind: 'fail'; mode: 'network-error' | 'timeout' | 'hang'; timeoutMs?: number };

/** When a matching rule applies; otherwise the request passes through untouched. */
export type FailurePattern =
  | { kind: 'always' }
  | { kind: 'random'; percent: number }
  /** Apply to the first N matching requests of the page, then pass through (retry testing). */
  | { kind: 'first-n'; n: number }
  /** Apply to every Nth matching request (deterministic intermittent failures). */
  | { kind: 'every-nth'; n: number };

export interface SimulationRule {
  id: string;
  name: string;
  enabled: boolean;
  match: {
    /** Upper-case methods; empty means any method. */
    methods: string[];
    /** Glob over host + path, e.g. "localhost:3000/api/orders/:id" or "localhost:3000/api/*". */
    urlPattern: string;
    query: 'ignore' | 'exact';
  };
  action: SimulationAction;
  /** Applied before any action, 0 for none. */
  delayMs: number;
  pattern: FailurePattern;
  /** Required for rules that match authentication or payment URLs. */
  allowSensitive: boolean;
  createdFrom?: { entryId: string; endpointKey: string };
  updatedAt: number;
}

/** What the page receives (CaptureConfig.simulation). Absent means: do not simulate. */
export interface PageSimulationConfig {
  /** Enabled rules, in priority order (first match wins). */
  rules: SimulationRule[];
  /** Page clock time after which the rules must no longer be applied. */
  leaseUntil: number;
  /** Identifies the rules (not the lease): the page acknowledges it once applied. */
  revision?: string;
}

/**
 * What the page reports after applying a configuration: the revision it simulates
 * with and until when, or null when it does not simulate.
 */
export type SimulationAck = { revision: string; leaseUntil: number; rules: number } | null;

/** How long the worker waits for a page to acknowledge rules it was sent. */
export const SIMULATION_ACK_TIMEOUT_MS = 5000;

/** Recorded on a request that a rule changed. */
export interface SimulatedInfo {
  ruleId: string;
  ruleName: string;
  action: 'mock' | 'delay' | 'network-error' | 'timeout' | 'hang';
  delayMs: number;
  /** Whether the real request reached the network. */
  sent: boolean;
}

export interface SimulationState {
  armed: boolean;
  rules: SimulationRule[];
}

export const DISARMED: SimulationState = { armed: false, rules: [] };

/** Status codes `new Response()` rejects a body for. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);
const SIMULATED_ACTIONS: readonly SimulatedInfo['action'][] = [
  'mock',
  'delay',
  'network-error',
  'timeout',
  'hang',
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v.trim(), max) : '');
const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

function normalizeHeaders(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) return [];
  const out: HeaderPair[] = [];
  for (const raw of value.slice(0, MAX_MOCK_HEADERS)) {
    if (!isObj(raw)) continue;
    const name = text(raw.name, 200).toLowerCase();
    // Header names must be valid tokens or `new Headers()` throws in the page.
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) continue;
    const value = typeof raw.value === 'string' ? clip(raw.value.replace(/[\r\n]/g, ' '), 4000) : '';
    out.push({ name, value });
  }
  return out;
}

function normalizeAction(value: unknown): SimulationAction | null {
  if (!isObj(value)) return null;
  if (value.kind === 'delay') return { kind: 'delay' };
  if (value.kind === 'fail') {
    const mode = value.mode;
    if (mode !== 'network-error' && mode !== 'timeout' && mode !== 'hang') return null;
    return mode === 'timeout'
      ? { kind: 'fail', mode, timeoutMs: int(value.timeoutMs, 0, MAX_SIMULATION_DELAY_MS, 30_000) }
      : { kind: 'fail', mode };
  }
  if (value.kind !== 'mock') return null;
  // `new Response()` accepts 200–599 only; 1xx and 0 cannot be produced.
  const status = int(value.status, 200, 599, 200);
  let body = typeof value.body === 'string' ? value.body : '';
  if (NULL_BODY_STATUS.has(status)) body = '';
  if (utf8Bytes(body) > MAX_MOCK_BODY_BYTES) return null;
  const statusText = text(value.statusText, 200).replace(/[^\t\x20-\x7e]/g, '');
  return {
    kind: 'mock',
    status,
    statusText: statusText || undefined,
    headers: normalizeHeaders(value.headers),
    body,
    bodyKind: value.bodyKind === 'text' ? 'text' : 'json',
  };
}

function normalizePattern(value: unknown): FailurePattern {
  if (!isObj(value)) return { kind: 'always' };
  if (value.kind === 'random') return { kind: 'random', percent: int(value.percent, 0, 100, 50) };
  if (value.kind === 'first-n') return { kind: 'first-n', n: int(value.n, 1, 10_000, 1) };
  if (value.kind === 'every-nth') return { kind: 'every-nth', n: int(value.n, 1, 10_000, 2) };
  return { kind: 'always' };
}

function normalizeRule(value: unknown, index: number): SimulationRule | null {
  if (!isObj(value)) return null;
  const match = isObj(value.match) ? value.match : {};
  const urlPattern = text(match.urlPattern, 2000);
  const action = normalizeAction(value.action);
  if (!urlPattern || !action) return null;
  const methods = Array.isArray(match.methods)
    ? [
        ...new Set(
          match.methods
            .filter((m): m is string => typeof m === 'string')
            .map((m) => m.trim().toUpperCase())
            .filter((m) => /^[A-Z]{1,16}$/.test(m)),
        ),
      ].slice(0, 16)
    : [];
  const id = text(value.id, 100) || `rule-${index + 1}`;
  return {
    id,
    name: text(value.name, 200) || urlPattern,
    enabled: value.enabled === true,
    match: { methods, urlPattern, query: match.query === 'exact' ? 'exact' : 'ignore' },
    action,
    delayMs: int(value.delayMs, 0, MAX_SIMULATION_DELAY_MS, 0),
    pattern: normalizePattern(value.pattern),
    allowSensitive: value.allowSensitive === true,
    createdFrom:
      isObj(value.createdFrom) &&
      typeof value.createdFrom.entryId === 'string' &&
      typeof value.createdFrom.endpointKey === 'string'
        ? {
            entryId: clip(value.createdFrom.entryId, 100),
            endpointKey: clip(value.createdFrom.endpointKey, 2000),
          }
        : undefined,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** Coerces stored or user-provided rules into valid rules; invalid entries and duplicate ids are dropped. */
export function normalizeSimulationRules(raw: unknown): SimulationRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SimulationRule[] = [];
  const ids = new Set<string>();
  raw.slice(0, MAX_SIMULATION_RULES).forEach((value, index) => {
    const rule = normalizeRule(value, index);
    if (!rule || ids.has(rule.id)) return;
    ids.add(rule.id);
    out.push(rule);
  });
  return out;
}

/** Rule fields the editor reports problems for. */
export type SimulationRuleField =
  | 'name'
  | 'urlPattern'
  | 'methods'
  | 'action'
  | 'status'
  | 'statusText'
  | 'headers'
  | 'body'
  | 'timeoutMs'
  | 'delayMs'
  | 'pattern';

const isWholeIn = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Problems that keep a rule from being saved, by field. normalizeSimulationRules
 * coerces whatever is stored; this rejects instead, so a rule is saved exactly as
 * the user wrote it. The editor shows these and the worker refuses a rule with any.
 */
export function simulationRuleProblems(raw: unknown): Partial<Record<SimulationRuleField, string>> {
  const problems: Partial<Record<SimulationRuleField, string>> = {};
  if (!isObj(raw)) return { action: 'Not a rule.' };
  if (typeof raw.name === 'string' && raw.name.trim().length > 200)
    problems.name = 'Use at most 200 characters.';

  const match = isObj(raw.match) ? raw.match : {};
  const pattern = typeof match.urlPattern === 'string' ? match.urlPattern.trim() : '';
  if (!pattern) problems.urlPattern = 'Enter a URL pattern.';
  else if (pattern.length > 2000) problems.urlPattern = 'Use at most 2000 characters.';
  else if (/\s/.test(pattern)) problems.urlPattern = 'URL patterns cannot contain spaces.';
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) && !/^https?:\/\//i.test(pattern))
    problems.urlPattern = 'Only http:// and https:// requests can be simulated.';

  const methods: unknown[] = Array.isArray(match.methods) ? match.methods : [];
  if (methods.length > 16) problems.methods = 'List at most 16 methods.';
  else if (methods.some((m) => typeof m !== 'string' || !/^[A-Za-z]{1,16}$/.test(m.trim())))
    problems.methods = 'Methods are letters only, e.g. GET, POST.';

  const action = isObj(raw.action) ? raw.action : {};
  if (action.kind === 'mock') {
    if (!isWholeIn(action.status, 200, 599))
      problems.status = 'Use a status from 200 to 599 (browsers cannot produce other codes).';
    if (action.statusText !== undefined) {
      if (typeof action.statusText !== 'string' || !/^[\t\x20-\x7e]*$/.test(action.statusText))
        problems.statusText = 'Use printable ASCII characters only.';
      else if (action.statusText.length > 200) problems.statusText = 'Use at most 200 characters.';
    }
    const headers: unknown[] = Array.isArray(action.headers) ? action.headers : [];
    if (headers.length > MAX_MOCK_HEADERS) problems.headers = `Use at most ${MAX_MOCK_HEADERS} headers.`;
    else {
      const bad = headers.find(
        (h) =>
          !isObj(h) ||
          typeof h.name !== 'string' ||
          !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(h.name.trim()) ||
          typeof h.value !== 'string' ||
          /[\r\n]/.test(h.value) ||
          h.value.length > 4000,
      );
      if (bad) problems.headers = 'Each header needs a valid name and a single-line value.';
    }
    const body = typeof action.body === 'string' ? action.body : '';
    if (typeof action.body !== 'string' && action.body !== undefined)
      problems.body = 'The body must be text.';
    else if (utf8Bytes(body) > MAX_MOCK_BODY_BYTES) problems.body = 'The body is larger than 1 MB.';
    else if (body && typeof action.status === 'number' && NULL_BODY_STATUS.has(action.status))
      problems.body = `Status ${action.status} cannot have a body.`;
    if (action.bodyKind !== 'json' && action.bodyKind !== 'text') problems.body ??= 'Choose JSON or text.';
  } else if (action.kind === 'fail') {
    if (action.mode !== 'network-error' && action.mode !== 'timeout' && action.mode !== 'hang')
      problems.action = 'Choose a failure type.';
    else if (action.mode === 'timeout' && !isWholeIn(action.timeoutMs, 0, MAX_SIMULATION_DELAY_MS))
      problems.timeoutMs = `Use a whole number of milliseconds from 0 to ${MAX_SIMULATION_DELAY_MS}.`;
  } else if (action.kind !== 'delay') {
    problems.action = 'Choose what the rule does.';
  }

  if (!isWholeIn(raw.delayMs, 0, MAX_SIMULATION_DELAY_MS))
    problems.delayMs = `Use a whole number of milliseconds from 0 to ${MAX_SIMULATION_DELAY_MS}.`;
  else if (action.kind === 'delay' && raw.delayMs === 0)
    problems.delayMs = 'A delay rule needs a delay above 0 ms.';

  const when = isObj(raw.pattern) ? raw.pattern : { kind: 'always' };
  if (when.kind === 'random') {
    if (!isWholeIn(when.percent, 0, 100)) problems.pattern = 'Use a whole percentage from 0 to 100.';
  } else if (when.kind === 'first-n' || when.kind === 'every-nth') {
    if (!isWholeIn(when.n, 1, 10_000)) problems.pattern = 'Use a whole number from 1 to 10000.';
  } else if (when.kind !== 'always') {
    problems.pattern = 'Choose when the rule applies.';
  }
  return problems;
}

/**
 * Where the rules for a tab are, when the tab should simulate:
 * - saved: stored, not sent to this tab's page yet
 * - sent: sent; the page has not confirmed them yet (within SIMULATION_ACK_TIMEOUT_MS)
 * - acknowledged: the page's current document reported it applies exactly these rules
 * - timed-out: sent, but the page did not confirm them in time
 * - not-connected: no Dev Companion bridge answers in the tab's current document
 */
export type SimulationDelivery = 'saved' | 'sent' | 'acknowledged' | 'timed-out' | 'not-connected';

/** What the extension currently sends one tab, as shown in the UI. */
export interface PageSimulationStatus {
  /** The tab's current origin, when it is an http(s) page. */
  origin?: string;
  /** The tab is recording its current origin (paused or not). */
  recording: boolean;
  paused: boolean;
  allowlisted: boolean;
  /** The extension gives the page rules right now: the same decision as its capture config. */
  active: boolean;
  /** Set when `active`: whether the page confirmed it applies them (see SimulationDelivery). */
  delivery?: SimulationDelivery;
  /** For `sent`: when the worker stops waiting for the acknowledgement. */
  ackDeadline?: number;
}

/** Fingerprint of the rules a page simulates with (FNV-1a over their JSON). */
export function simulationRevision(rules: readonly SimulationRule[]): string {
  let h = 0x811c9dc5;
  const text = JSON.stringify(rules);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${rules.length}-${h.toString(16)}`;
}

/** Validates an acknowledgement the page reported through the bridge. */
export function sanitizeSimulationAck(v: unknown): SimulationAck | undefined {
  if (v === null) return null;
  if (!isObj(v) || typeof v.revision !== 'string' || v.revision.length > 64) return undefined;
  const leaseUntil = Number(v.leaseUntil);
  const rules = Number(v.rules);
  if (!Number.isFinite(leaseUntil) || !Number.isInteger(rules) || rules < 0) return undefined;
  return { revision: v.revision, leaseUntil, rules };
}

/**
 * The delivery state of the rules `expected` for a tab, from what the worker last
 * sent it (`sent`) and what the tab's current document answered (`ack`; undefined
 * when nothing answered). An answer only counts for the same revision and an
 * unexpired lease, so an old document or an earlier configuration never confirms.
 */
export function simulationDelivery(
  expected: string,
  sent: { revision: string; sentAt: number } | undefined,
  ack: SimulationAck | undefined,
  now: number,
): { delivery: SimulationDelivery; ackDeadline?: number } {
  if (ack === undefined) return { delivery: 'not-connected' };
  if (ack && ack.revision === expected && ack.leaseUntil > now) return { delivery: 'acknowledged' };
  if (!sent || sent.revision !== expected) return { delivery: 'saved' };
  const ackDeadline = sent.sentAt + SIMULATION_ACK_TIMEOUT_MS;
  return now < ackDeadline ? { delivery: 'sent', ackDeadline } : { delivery: 'timed-out' };
}

export function pageSimulationStatus(
  settings: Settings,
  state: SimulationState,
  rec: { origin: string; paused?: boolean } | null,
  origin: string | undefined,
  now: number,
): PageSimulationStatus {
  const recording = !!rec && !!origin && rec.origin === origin;
  const paused = recording && !!rec?.paused;
  return {
    origin,
    recording,
    paused,
    allowlisted: !!origin && settings.simulationOrigins.includes(origin),
    active: !!pageSimulationConfig(settings, recording && !paused, origin, state, now),
  };
}

/**
 * The simulation slice of a page's capture config, or undefined when the page
 * must not simulate: not capturing (stopped or paused), not armed, origin not
 * allowlisted, or no enabled rules.
 */
export function pageSimulationConfig(
  settings: Settings,
  enabled: boolean,
  origin: string | undefined,
  state: SimulationState,
  now: number,
): PageSimulationConfig | undefined {
  if (!enabled || !state.armed || !origin || !settings.simulationOrigins.includes(origin)) return undefined;
  const rules = state.rules.filter((r) => r.enabled);
  if (!rules.length) return undefined;
  return { rules, leaseUntil: now + SIMULATION_LEASE_MS, revision: simulationRevision(rules) };
}

/** The rules a page may apply right now; empty when simulation is off or the lease expired. */
export function activeSimulationRules(config: CaptureConfig, now: number): SimulationRule[] {
  const sim = config.simulation;
  if (!config.enabled || !sim || !(sim.leaseUntil > now)) return [];
  return sim.rules;
}

/** Whether an origin should get the armed recorder (holds startup requests until rules arrive). */
export function isArmedOrigin(settings: Settings, state: SimulationState, origin: string): boolean {
  return state.armed && settings.simulationOrigins.includes(origin) && state.rules.some((r) => r.enabled);
}

/** Validates the `simulated` marker on a draft posted by the page. */
export function sanitizeSimulatedInfo(v: unknown): SimulatedInfo | undefined {
  if (!isObj(v)) return undefined;
  const ruleId = text(v.ruleId, 100);
  const action = SIMULATED_ACTIONS.includes(v.action as SimulatedInfo['action'])
    ? (v.action as SimulatedInfo['action'])
    : undefined;
  if (!ruleId || !action) return undefined;
  return {
    ruleId,
    ruleName: text(v.ruleName, 200) || ruleId,
    action,
    delayMs: int(v.delayMs, 0, MAX_SIMULATION_DELAY_MS, 0),
    sent: v.sent === true,
  };
}
