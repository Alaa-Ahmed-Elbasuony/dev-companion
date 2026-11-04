// Request simulation in the page: decides whether a rule applies to a request and
// produces the simulated outcome (mocked response, delay, network error, timeout,
// hang). Only active while the page holds unexpired rules (see shared/simulation.ts);
// otherwise the recorders never call into it beyond `active()` / `gate()`.
import { compileRules, matchRule } from '../analysis/simulation-match';
import type { CompiledRule } from '../analysis/simulation-match';
import { activeSimulationRules } from '../shared/simulation';
import type { FailurePattern, SimulatedInfo, SimulationAction, SimulationRule } from '../shared/simulation';
import type { RecorderContext } from './context';

/** How long the armed recorder holds startup requests while waiting for the rules. */
export const ARMED_WAIT_MS = 1500;
/** Used when a timeout rule does not say how long to wait. */
export const DEFAULT_SIMULATED_TIMEOUT_MS = 30_000;

export interface SimulationDecision {
  rule: SimulationRule;
  info: SimulatedInfo;
}

/** How a hold ended: its time elapsed, or simulation was switched off meanwhile. */
type HoldResult = 'elapsed' | 'released';

export interface Simulator {
  /** The page holds unexpired rules. */
  active: () => boolean;
  /** Pending while the armed recorder waits for its first configuration. */
  gate: () => Promise<void> | undefined;
  /** True if the startup wait ended without receiving a configuration. */
  gateTimedOut: () => boolean;
  /** The rule to apply to this request, if any. Counts the request for first-N / every-Nth. */
  decide: (method: string, url: string) => SimulationDecision | undefined;
  /** Waits `ms` (Infinity: until released or aborted). Rejects like fetch when the signal aborts. */
  hold: (ms: number, signal: AbortSignal | undefined) => Promise<HoldResult>;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function actionName(action: SimulationAction): SimulatedInfo['action'] {
  if (action.kind === 'fail') return action.mode;
  return action.kind;
}

function patternApplies(pattern: FailurePattern, count: number, random: () => number): boolean {
  switch (pattern.kind) {
    case 'always':
      return true;
    case 'random':
      return random() * 100 < pattern.percent;
    case 'first-n':
      return count <= pattern.n;
    case 'every-nth':
      return count % pattern.n === 0;
  }
}

export function createSimulator(ctx: RecorderContext): Simulator {
  const random = ctx.random ?? Math.random;
  // Counters live as long as the document; editing a rule (new updatedAt) restarts its count.
  const counters = new Map<string, number>();
  const holds = new Set<() => void>();
  let compiledFor: readonly SimulationRule[] | undefined;
  let compiled: CompiledRule[] = [];

  let gate: Promise<void> | undefined;
  let timedOut = false;
  if (ctx.simulationArmed) {
    gate = new Promise<void>((resolve) => {
      const open = () => {
        gate = undefined;
        resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        open();
      }, ARMED_WAIT_MS);
      void ctx.whenConfigured?.().then(() => {
        clearTimeout(timer);
        open();
      });
    });
  }

  const releaseAll = () => {
    for (const release of [...holds]) release();
  };
  const rules = () => activeSimulationRules(ctx.config(), ctx.now());

  // The lease ends simulation even if no further configuration arrives (renewal lost:
  // worker unreachable, bridge gone): held requests are then released, as by the switch.
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const watchLease = (leaseUntil: number | undefined) => {
    if (leaseTimer !== undefined) clearTimeout(leaseTimer);
    leaseTimer = undefined;
    if (leaseUntil === undefined) return;
    leaseTimer = setTimeout(
      () => {
        leaseTimer = undefined;
        if (rules().length) return;
        releaseAll();
        ctx.acknowledgeSimulation?.(null);
      },
      Math.max(0, leaseUntil - ctx.now()) + 1,
    );
  };

  if (rules().length) watchLease(ctx.config().simulation?.leaseUntil);

  // Every configuration replaces the rules. Switching simulation off (kill switch,
  // pause, stop, allowlist change) releases every held request at once. The page then
  // reports what it applies, so the extension never shows rules as active unconfirmed.
  ctx.onConfig?.((config) => {
    const current = activeSimulationRules(config, ctx.now());
    if (!current.length) {
      watchLease(undefined);
      releaseAll();
      ctx.acknowledgeSimulation?.(null);
      return;
    }
    compiled = compileRules(current);
    compiledFor = current;
    watchLease(config.simulation!.leaseUntil);
    ctx.acknowledgeSimulation?.({
      revision: config.simulation!.revision ?? '',
      leaseUntil: config.simulation!.leaseUntil,
      rules: compiled.length,
    });
  });

  return {
    active: () => rules().length > 0,
    gate: () => gate,
    gateTimedOut: () => timedOut,
    decide(method, url) {
      const current = rules();
      if (!current.length) return undefined;
      if (current !== compiledFor) {
        compiled = compileRules(current);
        compiledFor = current;
      }
      const rule = matchRule(compiled, method, url);
      if (!rule) return undefined;
      const key = `${rule.id}@${rule.updatedAt}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      if (!patternApplies(rule.pattern, count, random)) return undefined;
      return {
        rule,
        info: {
          ruleId: rule.id,
          ruleName: rule.name,
          action: actionName(rule.action),
          delayMs: rule.delayMs,
          sent: rule.action.kind === 'delay',
        },
      };
    },
    hold(ms, signal) {
      return new Promise<HoldResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          holds.delete(release);
        };
        const release = () => {
          cleanup();
          resolve('released');
        };
        const onAbort = () => {
          cleanup();
          reject(abortReason(signal!));
        };
        if (Number.isFinite(ms)) {
          timer = setTimeout(() => {
            cleanup();
            resolve('elapsed');
          }, ms);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        holds.add(release);
      });
    },
  };
}

const simulators = new WeakMap<RecorderContext, Simulator>();

/**
 * The page's one simulator: fetch and XHR share rule counters (first-N / every-Nth
 * count both), the startup gate and the set of held requests.
 */
export function simulatorFor(ctx: RecorderContext): Simulator {
  let sim = simulators.get(ctx);
  if (!sim) {
    sim = createSimulator(ctx);
    simulators.set(ctx, sim);
  }
  return sim;
}

/** Waits for the startup gate, rejecting like fetch if the request is aborted meanwhile. */
export function waitForGate(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return gate;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

export type MockAction = Extract<SimulationAction, { kind: 'mock' }>;

/** Response headers and body of a mock; the body is null when the response has none. */
export function mockParts(action: MockAction): { headers: Headers; body: string | null } {
  const headers = new Headers();
  for (const h of action.headers) {
    try {
      headers.append(h.name, h.value);
    } catch {
      /* invalid header: skipped */
    }
  }
  const nullBody = NULL_BODY_STATUS.has(action.status);
  if (!nullBody && action.body !== '' && !headers.has('content-type')) {
    headers.set('content-type', action.bodyKind === 'json' ? 'application/json' : 'text/plain;charset=UTF-8');
  }
  // An empty string body would get an implicit "text/plain" content type.
  return { headers, body: nullBody || action.body === '' ? null : action.body };
}

/** A Response the page cannot tell apart from a same-origin network response, except for `type`. */
export function mockResponse(action: MockAction, url: string): Response {
  const { headers, body } = mockParts(action);
  const response = new Response(body, {
    status: action.status,
    statusText: action.statusText ?? '',
    headers,
  });
  // A constructed Response has an empty url; pages often read it.
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
  } catch {
    /* keep the empty url */
  }
  return response;
}

export interface SimulateFetchOptions {
  url: string;
  signal: AbortSignal | undefined;
  /** Calls the original fetch with the page's receiver and arguments. */
  send: () => Promise<Response>;
  /** Simulation was switched off while the request was held; it is sent unchanged. */
  onReleased: () => void;
}

/**
 * What a simulated request ends in, after its holds:
 * - send: the real request goes out (a delay elapsed, or simulation was switched
 *   off while it was held: `released`)
 * - mock / network-error / timeout: produced without sending anything.
 * Rejects with the signal's reason when the signal aborts during a hold.
 */
export type SimulationOutcome =
  | { kind: 'send'; released: boolean }
  | { kind: 'mock'; action: MockAction }
  | { kind: 'network-error' }
  | { kind: 'timeout' };

/** Runs a decision's holds (shared by the fetch and XHR simulations). */
export async function resolveSimulation(
  sim: Simulator,
  decision: SimulationDecision,
  signal: AbortSignal | undefined,
): Promise<SimulationOutcome> {
  const { rule } = decision;
  const action = rule.action;
  if ((await sim.hold(rule.delayMs, signal)) === 'released') return { kind: 'send', released: true };
  switch (action.kind) {
    case 'delay':
      return { kind: 'send', released: false };
    case 'mock':
      return { kind: 'mock', action };
    case 'fail':
      if (action.mode === 'network-error') return { kind: 'network-error' };
      if (action.mode === 'timeout') {
        const waited = await sim.hold(action.timeoutMs ?? DEFAULT_SIMULATED_TIMEOUT_MS, signal);
        return waited === 'released' ? { kind: 'send', released: true } : { kind: 'timeout' };
      }
      await sim.hold(Infinity, signal);
      return { kind: 'send', released: true };
  }
}

/**
 * Produces the outcome of a simulated fetch. Mocks, failures, timeouts and hangs
 * never call `send`; a delay calls it once the delay has elapsed.
 */
export async function simulateFetch(
  sim: Simulator,
  decision: SimulationDecision,
  opts: SimulateFetchOptions,
): Promise<Response> {
  const outcome = await resolveSimulation(sim, decision, opts.signal);
  switch (outcome.kind) {
    case 'send':
      if (outcome.released) opts.onReleased();
      return opts.send();
    case 'mock':
      return mockResponse(outcome.action, opts.url);
    case 'network-error':
      throw new TypeError('Failed to fetch');
    case 'timeout':
      throw new DOMException('The operation timed out.', 'TimeoutError');
  }
}

/** Stored when simulation ended (switched off, or the lease ran out) while a request was held. */
export const RELEASED_NOTE =
  'Simulation was switched off (or its lease ran out) while this request was held; it was sent to the network unchanged';
/** Stored when the armed recorder gave up waiting for the rules at page startup. */
export const GATE_TIMEOUT_NOTE =
  'Held at page startup for simulation rules that did not arrive in time; sent unchanged';

/** The warning stored with a simulated request. */
export function describeSimulation(decision: SimulationDecision): string {
  const { rule, info } = decision;
  const delay = info.delayMs ? ` after ${info.delayMs} ms` : '';
  const action = rule.action;
  let what: string;
  if (action.kind === 'mock') what = `mocked ${action.status} response${delay}; the request was not sent`;
  else if (action.kind === 'delay') what = `delayed ${info.delayMs} ms, then sent to the network`;
  else if (action.mode === 'network-error')
    what = `simulated network error${delay}; the request was not sent`;
  else if (action.mode === 'timeout') what = `simulated timeout; the request was not sent`;
  else what = 'simulated hanging request; the request was not sent';
  return `Simulated by rule "${rule.name}": ${what}`;
}
