// Simulated traffic in analysis. A request a simulation rule produced or altered
// carries NetworkEntry.simulated. It stays visible wherever requests are listed
// or inspected, and findings use it according to what they describe:
// - backend timing and lifecycle (slow, network failures, never-finished
//   requests) and the previous-session comparison use real traffic only;
// - backend findings derived from the response (status, body, headers) also use
//   simulated requests whose recorded response came from the server (a delay
//   that was sent and answered), never a response a rule produced;
// - findings about the page's own behavior (console errors after a failure,
//   error bodies used as data, repeated requests) use every request.
// Findings that involve a simulated request are labeled with its rule.
// Entries without the marker, including everything captured or imported before
// simulation existed, are real traffic.
import type { Finding } from './error-detector';
import { isFailure } from './filter';
import type { SimulatedInfo } from '../shared/simulation';
import type { NetworkEntry } from '../shared/types';

type Marked = Pick<NetworkEntry, 'simulated'>;
type Lifecycle = Pick<
  NetworkEntry,
  'simulated' | 'state' | 'status' | 'startedAt' | 'responseAt' | 'endedAt'
>;

export const isSimulated = (e: Marked): boolean => !!e.simulated;

/** The page received an HTTP response from the network (headers and a status). */
const responseRecorded = (e: Lifecycle) =>
  e.state === 'complete' && (e.status ?? 0) > 0 && e.responseAt !== undefined;

/**
 * Whether the request left the browser. `sent` is set when a delay rule decides,
 * so a request the page cancelled (or timed out) during the delay keeps it: one
 * that ended before the delay was over, without a response, was never sent.
 */
export function reachedNetwork(e: Lifecycle): boolean {
  const info = e.simulated;
  if (!info) return true;
  if (!info.sent) return false;
  if (responseRecorded(e)) return true;
  return !(info.action === 'delay' && e.endedAt !== undefined && e.endedAt - e.startedAt < info.delayMs);
}

/**
 * The recorded outcome is the server's response: real traffic, or a simulated
 * request that was sent and answered (a delay, or one released when simulation
 * was switched off). Its timing still is not the server's.
 */
export const serverResponded = (e: Lifecycle): boolean =>
  !e.simulated || (e.simulated.sent && responseRecorded(e) && reachedNetwork(e));

/**
 * A failure the backend is responsible for, as counted in the failed-request
 * statistics: a real request that failed, or a delayed request whose failing
 * response the server returned. Synthetic failures, requests never sent and
 * timeouts or cancellations during or after an added delay do not count.
 */
export const isBackendFailure = (e: NetworkEntry): boolean => isFailure(e) && serverResponded(e);

/** A failure a simulation rule produced or caused (see isBackendFailure). */
export const isSimulatedFailure = (e: NetworkEntry): boolean => isFailure(e) && !serverResponded(e);

/** Real traffic only; the same array when nothing was simulated. */
export function realTraffic<T extends Marked>(entries: T[]): T[] {
  return entries.some(isSimulated) ? entries.filter((e) => !isSimulated(e)) : entries;
}

type AnalysisInput = { entries: NetworkEntry[]; baselineEntries?: NetworkEntry[] };

/** Analysis input with simulated entries removed from the session and its baseline session. */
export function forBackendAnalysis<T extends AnalysisInput>(input: T): T {
  const entries = realTraffic(input.entries);
  const baselineEntries = input.baselineEntries && realTraffic(input.baselineEntries);
  if (entries === input.entries && baselineEntries === input.baselineEntries) return input;
  return { ...input, entries, baselineEntries };
}

/**
 * The input each kind of finding sees: `real` for backend timing, lifecycle and
 * baselines, `responses` for backend findings derived from the response, `all`
 * for the page's own behavior. Without simulated entries all three are `input`.
 */
export function analysisInputs<T extends AnalysisInput>(input: T): { real: T; responses: T; all: T } {
  const real = forBackendAnalysis(input);
  if (real === input) return { real, responses: input, all: input };
  const responses = { ...real, entries: input.entries.filter(serverResponded) };
  return { real, responses, all: input };
}

/**
 * What each finding kind describes, judged by its detection logic: the backend
 * (a status, body, timing or lifecycle the server is responsible for) or the
 * page (how its code reacted to traffic). Realtime findings are not classified.
 */
export const FINDING_BASIS: Partial<Record<Finding['kind'], 'backend' | 'frontend'>> = {
  'http-error': 'backend',
  'network-failure': 'backend',
  slow: 'backend',
  contract: 'backend',
  'session-diff': 'backend',
  auth: 'backend',
  'pending-forever': 'backend',
  'stale-cache': 'backend',
  expectation: 'backend',
  openapi: 'backend',
  'server-error': 'backend',
  'server-outbound': 'backend',
  'console-near-failure': 'frontend',
  'response-mapping': 'frontend',
  repeated: 'frontend',
  hydration: 'frontend',
};

const ruleList = (names: string[]) =>
  `${names.length === 1 ? 'rule' : 'rules'} ${names.map((n) => `"${n}"`).join(', ')}`;

/**
 * Adds the basis to each finding and labels findings that involve simulated
 * requests: their rule, and whether the outcome came from the server.
 */
export function labelFindings(findings: Finding[], entries: NetworkEntry[]): Finding[] {
  const simulated = new Map(entries.filter(isSimulated).map((e) => [e.id, e]));
  return findings.map((f) => {
    const basis = FINDING_BASIS[f.kind];
    const involved = f.entryIds.map((id) => simulated.get(id)).filter((e): e is NetworkEntry => !!e);
    if (!involved.length) return basis ? { ...f, basis } : f;
    const names = (list: NetworkEntry[]) => [...new Set(list.map((e) => e.simulated!.ruleName))];
    const ruleNames = names(involved);
    // Named in the title: the rules that produced an outcome, or, if the server answered every one, the delays.
    const synthetic = involved.filter((e) => !serverResponded(e));
    const outcomeFromServer = synthetic.length === 0;
    const rules = ruleList(outcomeFromServer ? ruleNames : names(synthetic));
    return {
      ...f,
      basis,
      title: `${f.title} · ${outcomeFromServer ? 'delayed' : 'simulated'} by ${rules}`,
      limitations: [
        outcomeFromServer
          ? `The response came from the server, but simulation ${rules} held the request before sending it: durations include that time.`
          : `The outcome of ${synthetic.length === 1 ? 'a request' : `${synthetic.length} requests`} here was produced by simulation ${rules} (a mock, a simulated failure, or a timeout or cancellation during an added delay), not by the server. This describes how the page reacted, not a backend failure.`,
        ...f.limitations,
      ],
      simulation: { entryIds: involved.map((e) => e.id), ruleNames, outcomeFromServer },
    };
  });
}

/**
 * The tag shown on a simulated request (list, timeline), consistent with the
 * finding labels: "delayed by simulation" only when the server's response is
 * confirmed; otherwise the outcome is the rule's ("simulated").
 */
export function simulationLabel(e: Lifecycle): 'simulated' | 'delayed by simulation' | undefined {
  if (!e.simulated) return undefined;
  return serverResponded(e) ? 'delayed by simulation' : 'simulated';
}

/** What happened to a simulated request, e.g. `mocked response; the request was not sent`. */
export function simulationOutcome(info: SimulatedInfo, entry?: Lifecycle): string {
  const delay = info.delayMs ? ` after ${info.delayMs} ms` : '';
  // Cancelled or timed out by the page during the delay.
  if (entry && info.sent && !reachedNetwork(entry))
    return `delayed ${info.delayMs} ms; the request ended during the delay and was not sent`;
  // Released: simulation was switched off (or its lease ran out) while the request was held.
  if (info.sent && info.action !== 'delay')
    return 'simulation ended while it was held; sent to the network unchanged';
  switch (info.action) {
    case 'mock':
      return `mocked response${delay}; the request was not sent`;
    case 'delay':
      return `delayed ${info.delayMs} ms, then sent to the network`;
    case 'network-error':
      return `simulated network error${delay}; the request was not sent`;
    case 'timeout':
      return 'simulated timeout; the request was not sent';
    case 'hang':
      return 'simulated hanging request; the request was not sent';
  }
}

/** One-line description, e.g. `Simulated by rule "Orders 500": mocked response; ...`. */
export function describeSimulated(info: SimulatedInfo, entry?: Lifecycle): string {
  return `Simulated by rule "${info.ruleName}": ${simulationOutcome(info, entry)}`;
}

/** Where the recorded outcome came from. */
export function responseOrigin(info: SimulatedInfo | undefined, entry?: Lifecycle): string {
  if (!info) return 'server';
  const rule = `rule "${info.ruleName}"`;
  if (!info.sent) return `${rule} (no server response)`;
  if (!entry || serverResponded(entry)) return `server, with timing changed by ${rule}`;
  return reachedNetwork(entry)
    ? `no response: sent after ${rule} delayed it, then ended without one`
    : `${rule} (ended during the delay; never sent)`;
}
