// Evidence-based diagnostics. Each finding states what was observed, the
// evidence, plausible (not certain) explanations, next steps, confidence and
// limitations. Nothing here claims a root cause.
import type { ContractBaseline, EntryBodies, NetworkEntry, TimelineEvent } from '../shared/types';
import {
  endpointKey,
  formatDuration,
  headerValue,
  MUTATING_METHODS,
  safeUrl,
  tryParseJson,
  clip,
} from '../shared/util';
import { compareToShape, inferShape, validateJsonSchema } from './contracts';
import type { Shape } from './contracts';
import { correlate, ERROR_KINDS } from './correlate';
import { statusClass } from './filter';

export type Confidence = 'low' | 'medium' | 'high';

export interface Evidence {
  label: string;
  value: string;
  entryId?: string;
}

export interface Finding {
  id: string;
  kind:
    | 'http-error'
    | 'network-failure'
    | 'slow'
    | 'repeated'
    | 'contract'
    | 'session-diff'
    | 'console-near-failure'
    | 'auth'
    | 'pending-forever'
    | 'response-mapping'
    | 'stale-cache'
    | 'hydration'
    | 'realtime-connection'
    | 'realtime-close'
    | 'reconnect-storm'
    | 'duplicate-event'
    | 'malformed-message'
    | 'realtime-error'
    | 'expectation'
    | 'openapi'
    | 'server-error'
    | 'server-outbound';
  severity: 'error' | 'warning' | 'info';
  title: string;
  observed: string;
  evidence: Evidence[];
  explanations: string[];
  nextSteps: string[];
  confidence: Confidence;
  limitations: string[];
  entryIds: string[];
  /**
   * How well the finding's main claim (its title) is supported:
   * confirmed = directly observed; strong / possible = inferred; insufficient = cannot tell.
   */
  evidenceLevel?: EvidenceLevel;
  /** Ranked possible causes, each with its own evidence level and reason. */
  hypotheses?: Hypothesis[];
  /** Evidence that would distinguish between the hypotheses but was not captured. */
  missingEvidence?: string[];
  /** Non-request evidence (realtime messages, connections, timeline events, spans). */
  refs?: { type: 'timeline' | 'rt-message' | 'rt-connection' | 'span'; id: string }[];
}

export type EvidenceLevel = 'confirmed' | 'strong' | 'possible' | 'insufficient';

export interface Hypothesis {
  text: string;
  level: Exclude<EvidenceLevel, 'confirmed'> | 'confirmed';
  /** Why it is ranked this way. */
  because: string;
}

export interface DetectorInput {
  entries: NetworkEntry[];
  timeline: TimelineEvent[];
  bodies?: Map<string, EntryBodies>;
  contracts?: ContractBaseline[];
  slowRequestMs: number;
  /** Entries from an earlier session of the same origin, for session comparison. */
  baselineEntries?: NetworkEntry[];
  baselineBodies?: Map<string, EntryBodies>;
}

const STATUS_HINTS: Record<number, string[]> = {
  400: [
    'The request payload or parameters were rejected as malformed.',
    'A required field may be missing or have the wrong format.',
  ],
  401: ['Authentication is missing, expired or invalid (e.g. an expired token or missing session cookie).'],
  403: [
    'The authenticated user may lack permission for this resource or action.',
    'A CSRF token or origin check may have failed.',
  ],
  404: [
    'The resource or route does not exist on the server (wrong id, path or API version).',
    'The frontend may build the URL incorrectly.',
  ],
  405: ['The endpoint does not accept this HTTP method.'],
  409: ['The request conflicts with the current server state (duplicate creation, version conflict).'],
  413: ['The payload exceeds a server size limit.'],
  415: ['The server does not accept the request Content-Type.'],
  422: [
    'The server understood the request but rejected it during validation (business rule or field validation).',
  ],
  429: ['Rate limiting: too many requests in a short period. Check for repeated or looping requests.'],
  500: ['An unhandled server-side error occurred. The server logs are the primary evidence.'],
  502: ['A gateway or proxy received an invalid response from an upstream service.'],
  503: ['The service is unavailable or overloaded, or under maintenance.'],
  504: ['A gateway timed out waiting for an upstream service.'],
};

/** Extracts a short server-provided error message from a JSON or text body. */
export function extractErrorMessage(bodies: EntryBodies | undefined): string | undefined {
  const text = bodies?.response?.text;
  if (!text) return undefined;
  const parsed = tryParseJson(text);
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
    const obj = parsed.value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['message', 'error', 'detail', 'title', 'code', 'errors']) {
      const v = obj[key];
      if (v === undefined || v === null) continue;
      parts.push(`${key}: ${typeof v === 'string' ? v : clip(JSON.stringify(v), 200)}`);
    }
    if (parts.length) return clip(parts.join('; '), 400);
  }
  return clip(text.trim(), 200) || undefined;
}

function httpErrorFindings(input: DetectorInput): Finding[] {
  const groups = new Map<string, NetworkEntry[]>();
  for (const e of input.entries) {
    const c = statusClass(e);
    if (c !== 'client-error' && c !== 'server-error') continue;
    const key = `${endpointKey(e.method, e.url)} → ${e.status}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const first = list[0]!;
    const status = first.status!;
    const serverMessage = extractErrorMessage(input.bodies?.get(first.id));
    const evidence: Evidence[] = list.slice(0, 5).map((e) => ({
      label: `${e.method} ${e.status} ${e.statusText ?? ''}`.trim(),
      value: `${e.url} at ${new Date(e.startedAt).toLocaleTimeString()}`,
      entryId: e.id,
    }));
    if (serverMessage)
      evidence.unshift({ label: 'Server response', value: serverMessage, entryId: first.id });
    const isServer = status >= 500;
    const explanations = STATUS_HINTS[status] ?? [
      isServer
        ? 'The server reported an internal failure.'
        : 'The server rejected the request as a client error.',
    ];
    return {
      id: `http:${key}`,
      kind: 'http-error' as const,
      severity: isServer ? ('error' as const) : ('warning' as const),
      title: `${status} from ${endpointKey(first.method, first.url)}`,
      observed: `${list.length} request(s) returned HTTP ${status}${first.statusText ? ` ${first.statusText}` : ''}.`,
      evidence,
      explanations,
      nextSteps: [
        'Open the request and compare the payload with what the endpoint expects.',
        serverMessage
          ? 'Read the server-provided error message in the response body.'
          : 'Inspect the response body for an error message.',
        isServer
          ? 'Check backend logs around the request time (and any request id header).'
          : 'Compare with a successful request to the same endpoint, if one exists.',
      ],
      confidence: 'high' as const,
      limitations: [
        isServer
          ? 'The status code shows the server failed, but not why; the cause is usually only visible in server logs.'
          : 'The status code is reliable evidence that the server rejected the request, but not of why.',
        isServer
          ? 'A 5xx response can still be triggered by an unexpected request from the frontend.'
          : 'A 4xx response does not necessarily indicate a frontend bug.',
      ],
      entryIds: list.map((e) => e.id),
    };
  });
}

function networkFailureFindings(input: DetectorInput): Finding[] {
  const groups = new Map<string, NetworkEntry[]>();
  for (const e of input.entries) {
    if (e.state !== 'error' && e.state !== 'timeout') continue;
    const key = `${e.state}:${endpointKey(e.method, e.url)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const first = list[0]!;
    const target = safeUrl(first.url);
    const page = safeUrl(first.pageUrl);
    const crossOrigin = !!target && !!page && target.origin !== page.origin;
    const mixedContent = page?.protocol === 'https:' && target?.protocol === 'http:';
    const explanations: string[] = [];
    if (first.state === 'timeout')
      explanations.push('The request exceeded a client-side timeout (AbortSignal.timeout or xhr.timeout).');
    if (mixedContent)
      explanations.push('Mixed content: an HTTPS page requested an HTTP URL, which browsers block.');
    if (crossOrigin)
      explanations.push(
        'CORS: the cross-origin response may lack Access-Control-Allow-Origin, or the preflight failed.',
      );
    explanations.push(
      'The server may be unreachable (DNS failure, connection refused, offline).',
      'A browser extension or content blocker may have blocked the request.',
      'A TLS/certificate error can also surface as a generic network error.',
    );
    return {
      id: `net:${key}`,
      kind: 'network-failure' as const,
      severity: 'error' as const,
      title: `${first.state === 'timeout' ? 'Timeout' : 'Network failure'}: ${endpointKey(first.method, first.url)}`,
      observed: `${list.length} request(s) failed without an HTTP response.`,
      evidence: [
        {
          label: 'Error',
          value: `${first.errorName ?? 'Error'}: ${first.errorMessage ?? 'unknown'}`,
          entryId: first.id,
        },
        {
          label: 'Request origin vs page origin',
          value: `${target?.origin ?? '?'} vs ${page?.origin ?? '?'}`,
        },
        ...list.slice(1, 4).map((e) => ({ label: e.method, value: e.url, entryId: e.id })),
      ],
      explanations,
      nextSteps: [
        "Check the browser console for a CORS or mixed-content message (the page's JavaScript only sees a generic error).",
        'Open the URL directly or with cURL to check reachability.',
        crossOrigin
          ? "Inspect the server's CORS headers (including the OPTIONS preflight)."
          : 'Disable content blockers and retry.',
      ],
      confidence: mixedContent ? ('high' as const) : ('medium' as const),
      limitations: [
        'Browsers deliberately hide the reason for network failures from page scripts, so the cause cannot be determined from the capture alone.',
      ],
      entryIds: list.map((e) => e.id),
    };
  });
}

function slowFindings(input: DetectorInput): Finding[] {
  const groups = new Map<string, NetworkEntry[]>();
  for (const e of input.entries) {
    if (e.duration === undefined || e.duration < input.slowRequestMs) continue;
    const key = endpointKey(e.method, e.url);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    const worst = sorted[0]!;
    const serverTiming = headerValue(worst.responseHeaders, 'server-timing');
    const ttfb = worst.responseAt !== undefined ? worst.responseAt - worst.startedAt : undefined;
    const download =
      worst.responseAt !== undefined && worst.endedAt !== undefined
        ? worst.endedAt - worst.responseAt
        : undefined;
    const concurrent = input.entries.filter(
      (e) =>
        e.id !== worst.id &&
        e.startedAt <= (worst.endedAt ?? worst.startedAt) &&
        (e.endedAt ?? Infinity) >= worst.startedAt,
    ).length;
    const evidence: Evidence[] = [
      { label: 'Slowest', value: `${formatDuration(worst.duration)} — ${worst.url}`, entryId: worst.id },
    ];
    if (ttfb !== undefined) evidence.push({ label: 'Time to response headers', value: formatDuration(ttfb) });
    if (download !== undefined)
      evidence.push({ label: 'Body download (as observed)', value: formatDuration(download) });
    if (serverTiming) evidence.push({ label: 'Server-Timing', value: serverTiming });
    if (worst.responseBodySize)
      evidence.push({ label: 'Response size', value: `${worst.responseBodySize} bytes` });
    evidence.push({ label: 'Concurrent requests', value: String(concurrent) });
    const explanations: string[] = [];
    if (ttfb !== undefined && download !== undefined && download > ttfb)
      explanations.push('Most time was spent receiving the body: large payload or slow network.');
    else
      explanations.push(
        'Most time was spent waiting for the server: slow processing, database queries, or upstream calls.',
      );
    if (concurrent > 6)
      explanations.push('Many requests were in flight at once; the browser may have queued this one.');
    explanations.push('Cold starts, throttling or network conditions may be involved.');
    return {
      id: `slow:${key}`,
      kind: 'slow' as const,
      severity: 'warning' as const,
      title: `Slow requests: ${key}`,
      observed: `${list.length} request(s) took longer than ${formatDuration(input.slowRequestMs)}.`,
      evidence,
      explanations,
      nextSteps: [
        'Check server-side timing (Server-Timing header, APM, logs) for the slowest request.',
        'Compare durations across repeated calls to see whether the slowness is consistent.',
        'Check whether the response can be paginated, cached or made smaller.',
      ],
      confidence: 'medium' as const,
      limitations: [
        'Durations are measured in the page and include queueing and body reading; they are not server processing times.',
        'The threshold is configurable in Settings and may not reflect your performance budget.',
      ],
      entryIds: list.map((e) => e.id),
    };
  });
}

/** Groups requests with the same method, URL and request body that were issued close together. */
export function findRepeatedClusters(
  entries: NetworkEntry[],
  bodies: Map<string, EntryBodies> | undefined,
  gapMs = 2000,
) {
  const groups = new Map<string, NetworkEntry[]>();
  for (const e of entries) {
    if (e.source === 'replay') continue;
    const bodyText = bodies?.get(e.id)?.request?.text ?? '';
    const key = `${e.tabId}|${e.method}|${e.url}|${bodyText}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const clusters: NetworkEntry[][] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt);
    let current: NetworkEntry[] = [];
    for (const e of sorted) {
      const prev = current[current.length - 1];
      if (prev && e.startedAt - prev.startedAt > gapMs) {
        if (current.length > 1) clusters.push(current);
        current = [];
      }
      current.push(e);
    }
    if (current.length > 1) clusters.push(current);
  }
  return clusters;
}

function repeatedFindings(input: DetectorInput): Finding[] {
  const findings: Finding[] = [];
  for (const cluster of findRepeatedClusters(input.entries, input.bodies)) {
    const first = cluster[0]!;
    const mutation = MUTATING_METHODS.has(first.method);
    if (!mutation && cluster.length < 3) continue;
    const gaps = cluster.slice(1).map((e, i) => e.startedAt - cluster[i]!.startedAt);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    const regular = gaps.length >= 2 && mean >= 500 && sd / mean < 0.2;
    const overlapping = cluster.some((e, i) => i > 0 && e.startedAt < (cluster[i - 1]!.endedAt ?? Infinity));
    const precededByFailure = cluster.slice(0, -1).some((e) => {
      const c = statusClass(e);
      return c === 'failed' || c === 'server-error' || e.status === 429;
    });

    const explanations: string[] = [];
    if (precededByFailure)
      explanations.push(
        'An earlier attempt failed, so later calls are likely retries (intentional retry logic).',
      );
    if (regular)
      explanations.push(
        `Requests are evenly spaced (~${formatDuration(mean)}), which suggests intentional polling.`,
      );
    if (overlapping)
      explanations.push(
        'Requests overlapped in time: possibly intentional parallel fetching, or an effect firing twice (e.g. React StrictMode double-invoking effects in development, or missing dependency memoization).',
      );
    if (mutation && !precededByFailure)
      explanations.push(
        'Identical state-changing requests close together can indicate a double submit (e.g. a button not disabled while pending).',
      );
    if (!explanations.length)
      explanations.push(
        'Several components may be requesting the same data independently (missing shared cache).',
      );

    const likelyIntentional = precededByFailure || regular;
    findings.push({
      id: `repeat:${first.id}`,
      kind: 'repeated',
      severity: mutation && !likelyIntentional ? 'warning' : 'info',
      title: `Repeated ${first.method} ${endpointKey(first.method, first.url).split(' ')[1]}`,
      observed: `${cluster.length} identical ${first.method} requests (same URL${input.bodies ? ' and body' : ''}) within ${formatDuration(cluster[cluster.length - 1]!.startedAt - first.startedAt)}.`,
      evidence: cluster.slice(0, 6).map((e) => ({
        label: `${new Date(e.startedAt).toLocaleTimeString()} · ${e.state}${e.status ? ` ${e.status}` : ''}`,
        value: e.initiatorStack?.split('\n')[0]?.trim() ?? e.url,
        entryId: e.id,
      })),
      explanations,
      nextSteps: [
        'Compare the initiator stacks of the requests to see whether they come from the same code path.',
        mutation
          ? 'Check whether the server created duplicate records; verify idempotency keys if any.'
          : 'Check whether a shared cache (React Query, SWR, etc.) should deduplicate these calls.',
        'Check whether the behavior also happens in a production build (StrictMode double effects only run in development).',
      ],
      confidence: likelyIntentional ? 'low' : mutation ? 'medium' : 'low',
      limitations: [
        'Retries, polling and intentional parallel requests look identical to duplicates at the network level.',
        'Requests are grouped by exact URL and captured body; truncated or uncaptured bodies may group differently.',
      ],
      entryIds: cluster.map((e) => e.id),
    });
  }
  return findings;
}

function parseBody(bodies: EntryBodies | undefined): { ok: true; value: unknown } | { ok: false } {
  const res = bodies?.response;
  if (!res?.text || res.truncated || (res.kind !== 'json' && res.kind !== 'text')) return { ok: false };
  return tryParseJson(res.text);
}

function contractFindings(input: DetectorInput): Finding[] {
  if (!input.contracts?.length || !input.bodies) return [];
  const contracts = new Map(input.contracts.map((c) => [c.endpointKey, c]));
  const findings: Finding[] = [];
  for (const e of input.entries) {
    const contract = contracts.get(endpointKey(e.method, e.url));
    if (!contract || e.id === contract.sourceEntryId || statusClass(e) !== 'success') continue;
    const parsed = parseBody(input.bodies.get(e.id));
    if (!parsed.ok) continue;
    const issues =
      contract.kind === 'json-schema'
        ? validateJsonSchema(parsed.value, contract.schema)
        : compareToShape(parsed.value, contract.schema as Shape);
    if (!issues.length) continue;
    const explicit = contract.kind === 'json-schema';
    findings.push({
      id: `contract:${e.id}`,
      kind: 'contract',
      severity: explicit ? 'error' : 'warning',
      title: `${explicit ? 'Schema violation' : 'Response differs from baseline'}: ${contract.endpointKey}`,
      observed: `${issues.length} difference(s) between the response and the ${explicit ? 'JSON schema' : 'saved baseline shape'}.`,
      evidence: issues
        .slice(0, 10)
        .map((i) => ({ label: `${i.kind} ${i.path}`, value: i.message, entryId: e.id })),
      explanations: explicit
        ? ['The backend response does not match the provided schema.', 'The schema itself may be outdated.']
        : [
            'The API may have changed its response shape.',
            'The baseline may not cover legitimate variations (optional fields, nullable values, different object states).',
          ],
      nextSteps: [
        'Check whether the frontend code relies on the missing or changed fields.',
        explicit
          ? 'Confirm the schema matches the current API documentation.'
          : 'Provide an explicit JSON schema for a reliable contract check.',
      ],
      confidence: explicit ? 'high' : 'medium',
      limitations: explicit
        ? ['Only a subset of JSON Schema keywords is supported; unsupported keywords are ignored.']
        : [
            'An inferred baseline is a single example, not a contract. Differences are not proof of a backend bug.',
          ],
      entryIds: [e.id],
    });
  }
  return findings;
}

function sessionDiffFindings(input: DetectorInput): Finding[] {
  if (!input.baselineEntries?.length) return [];
  const latest = (list: NetworkEntry[]) => {
    const m = new Map<string, NetworkEntry>();
    for (const e of list)
      if (e.state === 'complete' && e.source !== 'replay') m.set(endpointKey(e.method, e.url), e);
    return m;
  };
  const current = latest(input.entries);
  const baseline = latest(input.baselineEntries);
  const findings: Finding[] = [];
  for (const [key, cur] of current) {
    const base = baseline.get(key);
    if (!base) continue;
    const curClass = statusClass(cur);
    const baseClass = statusClass(base);
    const evidence: Evidence[] = [
      {
        label: 'Previous session',
        value: `${base.status} in ${formatDuration(base.duration)}`,
        entryId: base.id,
      },
      { label: 'This session', value: `${cur.status} in ${formatDuration(cur.duration)}`, entryId: cur.id },
    ];
    let observed: string | undefined;
    if (curClass !== baseClass) observed = `Status changed from ${base.status} to ${cur.status}.`;
    else if (curClass === 'success') {
      const a = parseBody(input.baselineBodies?.get(base.id));
      const b = parseBody(input.bodies?.get(cur.id));
      if (a.ok && b.ok) {
        const issues = compareToShape(b.value, inferShape(a.value));
        if (issues.length) {
          observed = `Response shape differs from the previous session (${issues.length} difference(s)).`;
          evidence.push(
            ...issues
              .slice(0, 6)
              .map((i) => ({ label: `${i.kind} ${i.path}`, value: i.message, entryId: cur.id })),
          );
        }
      }
    }
    if (!observed) continue;
    findings.push({
      id: `session:${key}`,
      kind: 'session-diff',
      severity: curClass === 'success' ? 'info' : 'warning',
      title: `Changed since previous session: ${key}`,
      observed,
      evidence,
      explanations: [
        'The backend, data, user state or environment may differ between the sessions.',
        'The difference may be legitimate (different records, permissions or feature flags).',
      ],
      nextSteps: [
        'Open both requests in Compare to see the full difference.',
        'Check what changed between the two sessions (deploys, data, login).',
      ],
      confidence: 'low',
      limitations: ['Only the latest request per endpoint in each session is compared.'],
      entryIds: [base.id, cur.id],
    });
  }
  return findings;
}

function consoleNearFailureFindings(input: DetectorInput): Finding[] {
  const related = correlate(input.entries, input.timeline);
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const findings: Finding[] = [];
  for (const event of input.timeline) {
    if (!ERROR_KINDS.has(event.kind)) continue;
    const ids = related.get(event.id);
    if (!ids?.length) continue;
    const reqs = ids.map((id) => byId.get(id)!).filter(Boolean);
    findings.push({
      id: `console:${event.id}`,
      kind: 'console-near-failure',
      severity: 'warning',
      title: `${event.kind === 'console-error' ? 'Console error' : 'Uncaught error'} after failed request`,
      observed: `"${clip(event.message, 160)}" was reported within seconds of ${reqs.length} failed request(s).`,
      evidence: [
        { label: event.kind, value: clip(event.message, 400) },
        ...reqs
          .slice(0, 4)
          .map((r) => ({ label: `${r.method} ${r.status ?? r.state}`, value: r.url, entryId: r.id })),
      ],
      explanations: [
        'The error may be how the app reports the failed request (expected error handling).',
        'The app may not handle the failure and crash while reading the response (e.g. accessing a field of an error payload).',
        'The timing may be coincidental.',
      ],
      nextSteps: [
        'Read the error stack to find the code that logged it.',
        'Check whether the code handling this response checks the status before using the data.',
      ],
      confidence: 'low',
      limitations: [
        'The link is based on timing only (within 5 seconds in the same tab); there is no causal trace.',
      ],
      entryIds: reqs.map((r) => r.id),
    });
  }
  return findings;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function detectIssues(input: DetectorInput): Finding[] {
  return [
    ...httpErrorFindings(input),
    ...networkFailureFindings(input),
    ...contractFindings(input),
    ...consoleNearFailureFindings(input),
    ...repeatedFindings(input),
    ...slowFindings(input),
    ...sessionDiffFindings(input),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
