// Full-stack findings beyond single HTTP failures: realtime connections and
// messages, authentication, requests that never finish, response mapping
// errors, cache suspicion, hydration, server spans, developer expectations and
// OpenAPI contracts. Every finding separates what was observed (its title and
// evidence level) from ranked hypotheses about why.
import type {
  NetworkEntry,
  RealtimeConnection,
  RealtimeExpectation,
  RealtimeMessage,
  ServerSpan,
} from '../shared/types';
import { MUTATING_METHODS, clip, formatDuration, headerValue, safeUrl, tryParseJson } from '../shared/util';
import type { DetectorInput, Evidence, Finding, Hypothesis } from './error-detector';
import { isFailure, statusClass } from './filter';
import type { OpenApiDoc } from './openapi';
import { validateEntryAgainstOpenApi } from './openapi';
import { endpointOf, fnv1a } from './realtime/decode';

export interface InvestigatorInput extends DetectorInput {
  connections?: RealtimeConnection[];
  messages?: RealtimeMessage[];
  spans?: ServerSpan[];
  expectations?: RealtimeExpectation[];
  openApi?: OpenApiDoc[];
  /** Reference time for "never finished" checks (defaults to the latest observed event). */
  now?: number;
  serverTracingConfigured?: boolean;
  adaptersEnabled?: boolean;
  advancedCapture?: boolean;
}

const time = (t: number) => new Date(t).toLocaleTimeString();
const pathOf = (url: string) => safeUrl(url)?.pathname ?? url;

/** The first application packet of a message, if decoded. */
export function appPacket(m: RealtimeMessage) {
  return m.decoded?.find((d) => d.category === 'app');
}

/** The payload object of an event (first argument for Socket.IO/SignalR, the JSON for plain frames). */
export function eventPayload(m: RealtimeMessage): unknown {
  const p = appPacket(m);
  return p?.args?.[0];
}

export function getPath(value: unknown, path: string): unknown {
  let v = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** Matches "/api/orders" or "/api/orders/:id" patterns against a URL path. */
export function pathMatches(pattern: string, url: string): boolean {
  const path = pathOf(url);
  if (!pattern.includes(':') && !pattern.includes('*')) return path === pattern.replace(/(.)\/$/, '$1');
  const re = new RegExp(
    `^${pattern
      .replace(/[.+?^$()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/:[^/]+/g, '[^/]+')}/?$`,
  );
  return re.test(path);
}

// ---- realtime ------------------------------------------------------------------

const CLOSE_MEANINGS: Record<number, string> = {
  1000: 'normal closure',
  1001: 'going away (page unload or server shutdown)',
  1002: 'protocol error',
  1003: 'unsupported data',
  1006: 'abnormal closure: no close frame (connection dropped)',
  1007: 'invalid payload data',
  1008: 'policy violation (often authentication or origin checks)',
  1009: 'message too big',
  1011: 'server internal error',
  1012: 'service restart',
  1013: 'try again later (server overloaded)',
  1015: 'TLS handshake failure',
};

function connectionFindings(input: InvestigatorInput): Finding[] {
  const findings: Finding[] = [];
  for (const c of input.connections ?? []) {
    const label = `${c.transport} ${pathOf(c.url)}`;
    const cdp = c.sources.includes('cdp');
    if (c.state === 'failed') {
      const hypotheses: Hypothesis[] = [
        {
          text: 'The server or endpoint is not reachable at this URL (wrong host, path or port, or server down).',
          level: 'possible',
          because: 'A failure before opening is consistent with an unreachable endpoint.',
        },
        {
          text: 'The server rejected the handshake (authentication, origin check, or unsupported upgrade).',
          level: 'possible',
          because: cdp
            ? 'Advanced capture saw the handshake; check its HTTP status in the timeline.'
            : 'Browsers hide the handshake response from pages.',
        },
        {
          text: 'A proxy or load balancer between the browser and server does not support this transport.',
          level: 'possible',
          because: 'Common in deployments; not distinguishable from the browser.',
        },
      ];
      findings.push({
        id: `rt-failed:${c.id}`,
        kind: 'realtime-connection',
        severity: 'error',
        title: `${label} failed before it opened`,
        observed: `The ${c.transport} connection created at ${time(c.createdAt)} never reached the open state${c.closeCode ? ` (close code ${c.closeCode})` : ''}.`,
        evidence: [
          {
            label: 'Connection',
            value: `${c.url} · ${c.state}${c.errorMessage ? ` · ${c.errorMessage}` : ''}`,
          },
          ...(c.closeCode
            ? [
                {
                  label: 'Close code',
                  value: `${c.closeCode}: ${CLOSE_MEANINGS[c.closeCode] ?? 'application-defined'}`,
                },
              ]
            : []),
        ],
        explanations: hypotheses.map((h) => h.text),
        hypotheses,
        nextSteps: [
          'Check that the realtime server is running and the URL (host, port, path, ws/wss) is correct.',
          'Look at the server logs for the rejected handshake.',
          cdp
            ? 'Open the handshake status from advanced capture in the timeline.'
            : 'Enable advanced capture to see the handshake HTTP status.',
        ],
        confidence: 'high',
        evidenceLevel: 'confirmed',
        missingEvidence: cdp
          ? ['Server-side handshake logs']
          : ['Handshake HTTP status (enable advanced capture)', 'Server-side handshake logs'],
        limitations: ['Browsers expose almost no detail about failed realtime handshakes to pages.'],
        entryIds: [],
        refs: [{ type: 'rt-connection', id: c.id }],
      });
      continue;
    }
    if (
      c.state === 'closed' &&
      c.closeCode !== undefined &&
      c.closeCode !== 1000 &&
      c.closeCode !== 1005 &&
      c.openedAt
    ) {
      const meaning =
        CLOSE_MEANINGS[c.closeCode] ??
        (c.closeCode >= 4000 ? 'application-defined code' : 'unrecognized code');
      const serverReported = c.closeCode === 1011 || c.closeCode === 1008 || c.closeCode >= 4000;
      const hypotheses: Hypothesis[] =
        c.closeCode === 1006
          ? [
              {
                text: 'The network path dropped the connection (idle timeout in a proxy, Wi-Fi change, sleep).',
                level: 'possible',
                because: '1006 means no close frame was received; the browser cannot see why.',
              },
              {
                text: 'The server process crashed or restarted.',
                level: 'possible',
                because: 'An abrupt server exit also produces 1006.',
              },
              {
                text: 'A heartbeat or ping timeout ended the connection.',
                level: 'possible',
                because: 'Check whether heartbeats stopped before the close.',
              },
            ]
          : [
              {
                text: `The server closed the connection: ${meaning}${c.closeReason ? ` ("${c.closeReason}")` : ''}.`,
                level: serverReported ? 'strong' : 'possible',
                because: serverReported
                  ? 'The close code was sent by the peer.'
                  : 'The code alone does not identify the cause.',
              },
            ];
      findings.push({
        id: `rt-close:${c.id}`,
        kind: 'realtime-close',
        severity: c.closeCode === 1001 ? 'info' : 'warning',
        title: `${label} closed with code ${c.closeCode} (${meaning})`,
        observed: `Opened at ${time(c.openedAt)}, closed at ${c.closedAt ? time(c.closedAt) : 'unknown time'}${c.wasClean === false ? ', not cleanly' : ''}.`,
        evidence: [
          {
            label: 'Close',
            value: `code ${c.closeCode}${c.closeReason ? `, reason "${c.closeReason}"` : ''}, wasClean=${String(c.wasClean)}`,
          },
        ],
        explanations: hypotheses.map((h) => h.text),
        hypotheses,
        nextSteps: [
          'Check server logs at the close time.',
          'Check whether the application reconnects, and how often.',
        ],
        confidence: 'high',
        evidenceLevel: 'confirmed',
        missingEvidence: ['Server-side logs for the connection'],
        limitations: [
          'Close codes 1006 and 1001 are generated by the browser and carry no server explanation.',
        ],
        entryIds: [],
        refs: [{ type: 'rt-connection', id: c.id }],
      });
    }
  }

  // Reconnect storms: several reconnects of one endpoint within a minute.
  const byEndpoint = new Map<string, RealtimeConnection[]>();
  for (const c of input.connections ?? []) {
    const key = `${c.tabId}|${c.transport}|${endpointOf(c.url)}`;
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), c]);
  }
  for (const [key, list] of byEndpoint) {
    const sorted = list.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i + 2 < sorted.length; i++) {
      const window = sorted.slice(i, i + 3);
      if (window[2]!.createdAt - window[0]!.createdAt > 60_000) continue;
      const all = sorted.filter(
        (c) => c.createdAt >= window[0]!.createdAt && c.createdAt <= window[0]!.createdAt + 60_000,
      );
      findings.push({
        id: `rt-storm:${key}`,
        kind: 'reconnect-storm',
        severity: 'warning',
        title: `${all.length} connections to ${pathOf(sorted[0]!.url)} within a minute`,
        observed: `The page opened ${all.length} ${sorted[0]!.transport} connections to the same endpoint between ${time(all[0]!.createdAt)} and ${time(all.at(-1)!.createdAt)}.`,
        evidence: all.slice(0, 6).map((c) => ({
          label: `#${c.attempt} ${c.state}`,
          value: `${time(c.createdAt)}${c.closeCode ? ` · closed ${c.closeCode}` : ''}`,
        })),
        explanations: [
          'Connections keep dropping and the client reconnects.',
          'Several components open their own connection instead of sharing one.',
        ],
        hypotheses: [
          {
            text: 'Each connection is dropped and the client reconnects (reconnect loop).',
            level: all.every((c) => c.state === 'closed' || c.state === 'failed') ? 'strong' : 'possible',
            because: 'All but the newest connection ended.',
          },
          {
            text: 'Several parts of the application open separate connections (duplicate subscriptions).',
            level: all.filter((c) => c.state === 'open').length > 1 ? 'strong' : 'possible',
            because: 'More than one connection was open at the same time.',
          },
        ],
        nextSteps: [
          'Compare close codes of the connections.',
          'Check where the application creates connections (one shared client vs. per component).',
        ],
        confidence: 'high',
        evidenceLevel: 'confirmed',
        limitations: ['Reconnects are counted per document; a reload is not a reconnect.'],
        entryIds: [],
        refs: all.map((c) => ({ type: 'rt-connection' as const, id: c.id })),
      });
      break;
    }
  }
  return findings;
}

function messageFindings(input: InvestigatorInput): Finding[] {
  const findings: Finding[] = [];
  const messages = input.messages ?? [];
  const conns = new Map((input.connections ?? []).map((c) => [c.id, c]));

  const malformed = messages.filter((m) => m.parseError);
  if (malformed.length) {
    findings.push({
      id: 'rt-malformed',
      kind: 'malformed-message',
      severity: 'warning',
      title: `${malformed.length} malformed realtime message(s)`,
      observed: `Messages looked like ${[...new Set(malformed.map((m) => conns.get(m.connectionId)?.protocol ?? 'JSON'))].join('/')} but could not be decoded.`,
      evidence: malformed
        .slice(0, 5)
        .map((m) => ({ label: m.parseError ?? 'parse error', value: clip(m.text ?? '', 120) })),
      explanations: [
        'The sender serialized the payload incorrectly.',
        'The payload was cut off by an intermediary.',
      ],
      hypotheses: [
        {
          text: 'The sender produced invalid payloads.',
          level: 'strong',
          because: 'The browser received the bytes exactly as shown.',
        },
        {
          text: 'The application tolerates these messages.',
          level: 'insufficient',
          because: 'Whether a handler failed is only visible with the page adapter or a console error.',
        },
      ],
      nextSteps: [
        'Find the code that sends this message type on the server.',
        'Check the console for parsing errors around the same time.',
      ],
      confidence: 'high',
      evidenceLevel: 'confirmed',
      limitations: ['Messages truncated at the size limit are not reported as malformed.'],
      entryIds: [],
      refs: malformed.slice(0, 50).map((m) => ({ type: 'rt-message' as const, id: m.id })),
    });
  }

  for (const m of messages) {
    for (const p of m.decoded ?? []) {
      if (!p.error) continue;
      findings.push({
        id: `rt-error:${m.id}`,
        kind: 'realtime-error',
        severity: 'error',
        title: `${p.protocol} ${p.kind} error: ${clip(p.error, 120)}`,
        observed: `The server reported an error in a ${p.kind} message${p.namespace ? ` on namespace ${p.namespace}` : ''}${p.invocationId ? ` (invocation ${p.invocationId})` : ''}.`,
        evidence: [{ label: 'Message', value: clip(m.text ?? '', 200) }],
        explanations: [
          p.kind === 'CONNECT_ERROR'
            ? 'The server middleware rejected the namespace connection (often authentication).'
            : 'The server-side handler threw or returned an error.',
        ],
        hypotheses: [
          {
            text: `Server-provided reason: ${p.error}`,
            level: 'strong',
            because: 'The error text was sent by the server.',
          },
        ],
        nextSteps: ['Search the server code and logs for this error message.'],
        confidence: 'high',
        evidenceLevel: 'confirmed',
        limitations: ['The server message may be generic and not state the underlying cause.'],
        entryIds: [],
        refs: [{ type: 'rt-message', id: m.id }],
      });
    }
  }

  // Duplicate events: same name and payload received more than once within 10 s in a tab.
  const groups = new Map<string, RealtimeMessage[]>();
  for (const m of messages) {
    const p = appPacket(m);
    if (m.direction !== 'in' || !p?.name || m.opcode !== 'text') continue;
    const key = `${m.tabId}|${p.name}|${fnv1a(JSON.stringify(p.args ?? m.text ?? ''))}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const [key, list] of groups) {
    const sorted = list.sort((a, b) => a.timestamp - b.timestamp);
    const burst = sorted.filter((m) => m.timestamp - sorted[0]!.timestamp <= 10_000);
    if (burst.length < 2) continue;
    const name = appPacket(burst[0]!)!.name!;
    const connections = new Set(burst.map((m) => m.connectionId));
    const reconnected = [...connections].some((id) => (conns.get(id)?.attempt ?? 0) > 0);
    findings.push({
      id: `rt-dup:${key}`,
      kind: 'duplicate-event',
      severity: 'warning',
      title: `"${name}" received ${burst.length} times with an identical payload`,
      observed: `${burst.length} identical "${name}" messages arrived within ${formatDuration(burst.at(-1)!.timestamp - burst[0]!.timestamp)} on ${connections.size} connection(s).`,
      evidence: burst.slice(0, 5).map((m) => ({ label: time(m.timestamp), value: clip(m.text ?? '', 120) })),
      explanations: [
        'The server emitted the event more than once.',
        'The page holds more than one subscribed connection.',
      ],
      hypotheses: [
        connections.size > 1
          ? {
              text: 'Several connections are subscribed and each delivered the event.',
              level: 'strong',
              because: `The copies arrived on ${connections.size} different connections.`,
            }
          : {
              text: 'The server sent the same event more than once on one connection.',
              level: 'strong',
              because: 'All copies arrived on the same connection.',
            },
        ...(reconnected
          ? [
              {
                text: 'A reconnect replayed missed events.',
                level: 'possible' as const,
                because: 'One of the connections is a reconnect.',
              },
            ]
          : []),
      ],
      nextSteps: [
        'Check whether the UI shows the notification once per copy (see the notification checklist).',
        'Deduplicate by an event id on the client, or fix the duplicate emission on the server.',
      ],
      confidence: 'high',
      evidenceLevel: 'confirmed',
      missingEvidence: ['Server-side emission logs (to tell a double emit from double subscription)'],
      limitations: [
        'Identical payloads within 10 s are treated as duplicates; legitimately repeated events look the same.',
      ],
      entryIds: [],
      refs: burst.map((m) => ({ type: 'rt-message' as const, id: m.id })),
    });
  }
  return findings;
}

/** Developer-configured expectations: event after request, required payload fields. */
function expectationFindings(input: InvestigatorInput): Finding[] {
  const findings: Finding[] = [];
  const messages = (input.messages ?? []).filter((m) => m.direction === 'in');
  for (const exp of input.expectations ?? []) {
    const matching = messages.filter((m) => appPacket(m)?.name === exp.eventName);
    if (exp.requiredFields.length) {
      for (const m of matching) {
        const payload = eventPayload(m);
        const missing = exp.requiredFields.filter((f) => {
          const v = getPath(payload, f);
          return v === undefined || v === null || v === '';
        });
        if (!missing.length) continue;
        findings.push({
          id: `exp-fields:${exp.id}:${m.id}`,
          kind: 'expectation',
          severity: 'error',
          title: `"${exp.eventName}" is missing required field(s): ${missing.join(', ')}`,
          observed: `A "${exp.eventName}" message at ${time(m.timestamp)} did not contain ${missing.map((f) => `"${f}"`).join(', ')} (expectation "${exp.label}").`,
          evidence: [
            { label: 'Payload', value: clip(JSON.stringify(payload) ?? '', 300) },
            ...missing.map((f) => ({
              label: `$.${f}`,
              value: `expected a value, got ${JSON.stringify(getPath(payload, f)) ?? 'absent'}`,
            })),
          ],
          explanations: [
            'The server built the event without these fields.',
            'The field was renamed (contract change).',
          ],
          hypotheses: [
            {
              text: 'The server-side event payload does not include these fields.',
              level: 'strong',
              because: 'The message was received exactly like this.',
            },
            {
              text: 'The frontend handler ignores or fails on this message.',
              level: input.adaptersEnabled ? 'possible' : 'insufficient',
              because: input.adaptersEnabled
                ? 'Check the handler stages in the notification checklist.'
                : 'Handler execution is not instrumented.',
            },
          ],
          nextSteps: [
            'Compare with an earlier valid message of the same event.',
            'Check the server code that emits this event.',
          ],
          confidence: 'high',
          evidenceLevel: 'confirmed',
          limitations: ['Only fields listed in the expectation are checked.'],
          entryIds: [],
          refs: [{ type: 'rt-message', id: m.id }],
        });
      }
    }
    if (!exp.afterPath && !exp.afterMethod) continue;
    const triggers = input.entries.filter(
      (e) =>
        (!exp.afterMethod || e.method === exp.afterMethod) &&
        (!exp.afterPath || pathMatches(exp.afterPath, e.url)) &&
        statusClass(e) === 'success',
    );
    for (const t of triggers) {
      const end = t.endedAt ?? t.startedAt;
      const received = matching.find(
        (m) => m.tabId === t.tabId && m.timestamp >= t.startedAt && m.timestamp <= end + exp.withinMs,
      );
      if (received) continue;
      const deadline = end + exp.withinMs;
      const now =
        input.now ??
        Math.max(
          ...input.entries.map((e) => e.endedAt ?? e.startedAt),
          ...messages.map((m) => m.timestamp),
          end,
        );
      if (now < deadline) continue; // not yet decidable
      const tabConns = (input.connections ?? []).filter((c) => c.tabId === t.tabId);
      const openAtTrigger = tabConns.filter(
        (c) => c.createdAt <= end && (!c.closedAt || c.closedAt >= end) && c.state !== 'failed',
      );
      const hypotheses: Hypothesis[] = openAtTrigger.length
        ? [
            {
              text: 'The server did not emit the event (or emitted it to other clients/rooms).',
              level: 'possible',
              because: `${openAtTrigger.length} connection(s) were open, but no "${exp.eventName}" arrived.`,
            },
            {
              text: 'The event was emitted under a different name.',
              level: 'possible',
              because: 'Only the exact name is matched; check other events in the window.',
            },
          ]
        : [
            {
              text: 'No realtime connection was open when the request completed, so the browser could not receive the event.',
              level: 'strong',
              because: 'No open connection was recorded in this tab at that time.',
            },
          ];
      findings.push({
        id: `exp-missing:${exp.id}:${t.id}`,
        kind: 'expectation',
        severity: 'error',
        title: `"${exp.eventName}" was not received within ${formatDuration(exp.withinMs)} after ${t.method} ${pathOf(t.url)}`,
        observed: `The request completed at ${time(end)} (HTTP ${t.status}); no "${exp.eventName}" message was observed by ${time(deadline)}.`,
        evidence: [
          { label: 'Trigger request', value: `${t.method} ${t.url} → ${t.status}`, entryId: t.id },
          {
            label: 'Open connections at that time',
            value: openAtTrigger.map((c) => `${c.transport} ${pathOf(c.url)}`).join(', ') || 'none',
          },
        ],
        explanations: hypotheses.map((h) => h.text),
        hypotheses,
        nextSteps: [
          'Check the server emits the event after this request (logs or server tracing).',
          'Verify the client is subscribed to the right room/channel/group.',
        ],
        confidence: 'medium',
        evidenceLevel: 'confirmed',
        missingEvidence: [
          ...(input.serverTracingConfigured
            ? []
            : ['Server-side evidence that the event was emitted (no server integration configured)']),
          'Messages sent to Web Workers or iframes are not observed',
        ],
        limitations: ['"Not received" means not observed in the recorded top-level document.'],
        entryIds: [t.id],
      });
    }
  }
  return findings;
}

// ---- HTTP-level additions ---------------------------------------------------------

function authFindings(input: InvestigatorInput): Finding[] {
  const out: Finding[] = [];
  const byOrigin = new Map<string, NetworkEntry[]>();
  for (const e of input.entries) {
    const origin = safeUrl(e.url)?.origin ?? '';
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), e]);
  }
  for (const [origin, list] of byOrigin) {
    const sorted = list.sort((a, b) => a.startedAt - b.startedAt);
    const firstAuthFail = sorted.find((e) => e.status === 401 || e.status === 403);
    if (!firstAuthFail) continue;
    const failures = sorted.filter((e) => e.status === 401 || e.status === 403);
    const earlierSuccess = [...sorted]
      .reverse()
      .find(
        (e) =>
          e.startedAt < firstAuthFail.startedAt &&
          statusClass(e) === 'success' &&
          e.requestHeaders.some((h) => h.name.toLowerCase() === 'authorization'),
      );
    const sentAuth = firstAuthFail.requestHeaders.some((h) => h.name.toLowerCase() === 'authorization');
    const hypotheses: Hypothesis[] = [];
    if (earlierSuccess && firstAuthFail.status === 401) {
      hypotheses.push({
        text: 'The session or token expired (or was revoked) between the requests.',
        level: 'strong',
        because: `An authenticated request succeeded at ${time(earlierSuccess.startedAt)}, then requests started failing with 401.`,
      });
    }
    if (!sentAuth)
      hypotheses.push({
        text: 'The request was sent without an Authorization header.',
        level: 'possible',
        because:
          'No Authorization header set by the page was captured (cookies are not visible to the recorder).',
      });
    if (firstAuthFail.status === 403)
      hypotheses.push({
        text: 'The user is authenticated but lacks permission for this action.',
        level: 'possible',
        because: '403 usually means authenticated but forbidden.',
      });
    hypotheses.push({
      text: 'A cookie-based session is missing or blocked (SameSite, third-party cookie settings).',
      level: 'possible',
      because: 'Cookies are browser-managed and invisible to page scripts.',
    });
    out.push({
      id: `auth:${origin}`,
      kind: 'auth',
      severity: 'warning',
      title: `${failures.length} authentication/authorization failure(s) from ${new URL(firstAuthFail.url).host}`,
      observed: `First ${firstAuthFail.status} at ${time(firstAuthFail.startedAt)} for ${firstAuthFail.method} ${pathOf(firstAuthFail.url)}.`,
      evidence: failures
        .slice(0, 5)
        .map((e) => ({ label: `${e.status} ${e.method}`, value: pathOf(e.url), entryId: e.id })),
      explanations: hypotheses.map((h) => h.text),
      hypotheses,
      nextSteps: [
        'Check token/session expiry times and the refresh logic.',
        'Compare request headers of the last successful and the first failing request (Compare A/B).',
      ],
      confidence: 'high',
      evidenceLevel: 'confirmed',
      missingEvidence: ['Cookie values (never captured)', 'Server-side auth logs'],
      limitations: ['Credential values are redacted, so token changes are not visible.'],
      entryIds: failures.map((e) => e.id),
    });
  }
  return out;
}

function pendingForeverFindings(input: InvestigatorInput): Finding[] {
  const now = input.now ?? Math.max(0, ...input.entries.map((e) => e.endedAt ?? e.startedAt));
  const threshold = Math.max(30_000, input.slowRequestMs * 10);
  const stuck = input.entries.filter((e) => e.state === 'pending' && now - e.startedAt > threshold);
  if (!stuck.length) return [];
  return [
    {
      id: 'pending-forever',
      kind: 'pending-forever',
      severity: 'warning',
      title: `${stuck.length} request(s) never finished`,
      observed: `Still pending after more than ${formatDuration(threshold)}; any loading state waiting on them would not end.`,
      evidence: stuck.slice(0, 5).map((e) => ({
        label: `${e.method} pending since ${time(e.startedAt)}`,
        value: pathOf(e.url),
        entryId: e.id,
      })),
      explanations: [
        'The server never responded or the connection hangs.',
        'A long-poll or streaming request is expected to stay open.',
      ],
      hypotheses: [
        {
          text: 'The server or an upstream dependency hangs without timing out.',
          level: 'possible',
          because: 'No response headers were received.',
        },
        {
          text: 'This is an intentional long-lived request (long polling, streaming).',
          level: /poll|stream|events|sse|socket\.io|hubs?\//i.test(stuck.map((e) => e.url).join(' '))
            ? 'strong'
            : 'possible',
          because: 'Long-lived endpoints look the same as hung requests.',
        },
      ],
      nextSteps: [
        'Check the server for the hung request.',
        'Add a client-side timeout (AbortSignal.timeout) and an error state for loading UIs.',
      ],
      confidence: 'medium',
      evidenceLevel: 'confirmed',
      limitations: ['Requests from the current page that are still in progress also count.'],
      entryIds: stuck.map((e) => e.id),
    },
  ];
}

const PROPERTY_OF_UNDEFINED = [
  /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']+)'\)/,
  /Cannot read property '([^']+)' of (?:undefined|null)/,
  /(?:undefined|null) is not an object \(evaluating '[^']*?\.?([\w$]+)'\)/,
  /\.(\w+) is not a function/,
];

/**
 * A TypeError right after an error response (4xx/5xx JSON) that lacks the accessed
 * field: the classic "error body used as data" bug. Success responses are not
 * considered, because the error message alone does not say which object was undefined.
 */
function responseMappingFindings(input: InvestigatorInput): Finding[] {
  const out: Finding[] = [];
  if (!input.bodies) return out;
  for (const t of input.timeline) {
    if (t.kind !== 'js-error' && t.kind !== 'unhandled-rejection' && t.kind !== 'console-error') continue;
    const field = PROPERTY_OF_UNDEFINED.map((re) => re.exec(t.message)?.[1]).find(Boolean);
    if (!field) continue;
    const candidates = input.entries.filter(
      (e) =>
        e.tabId === t.tabId &&
        (e.endedAt ?? 0) <= t.timestamp + 500 &&
        t.timestamp - (e.endedAt ?? 0) <= 5000 &&
        e.responseBodyKind === 'json' &&
        isFailure(e),
    );
    for (const e of candidates) {
      const parsed = tryParseJson(input.bodies.get(e.id)?.response?.text ?? '');
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') continue;
      const keys = Object.keys(parsed.value as object);
      if (keys.includes(field)) continue;
      out.push({
        id: `mapping:${t.id}:${e.id}`,
        kind: 'response-mapping',
        severity: 'error',
        title: `"${field}" accessed on undefined shortly after ${e.method} ${pathOf(e.url)} returned ${e.status}`,
        observed: `"${clip(t.message, 160)}" at ${time(t.timestamp)}, ${formatDuration(t.timestamp - (e.endedAt ?? e.startedAt))} after the response.`,
        evidence: [
          { label: 'Error', value: clip(t.message, 200) },
          {
            label: 'Response top-level fields',
            value: keys.slice(0, 20).join(', ') || '(none)',
            entryId: e.id,
          },
        ],
        explanations: [
          `The code expected a field that this response does not contain (the response has: ${keys.slice(0, 8).join(', ')}).`,
        ],
        hypotheses: [
          {
            text: `The code treats the error response (${e.status}) as success data and reads a field it does not have.`,
            level: 'strong',
            because: `The ${e.status} body has no "${field}" and the TypeError followed within ${formatDuration(t.timestamp - (e.endedAt ?? e.startedAt))}.`,
          },
          {
            text: 'The error comes from unrelated code that ran at the same time.',
            level: 'possible',
            because: 'The link is time-based.',
          },
        ],
        nextSteps: [
          'Open the error stack to find the access.',
          'Compare the response body with the shape the code expects; check status handling for error responses.',
        ],
        confidence: 'medium',
        evidenceLevel: 'strong',
        limitations: ['Only top-level response fields are compared; minified code may rename properties.'],
        entryIds: [e.id],
        refs: [{ type: 'timeline', id: t.id }],
      });
      break;
    }
  }
  return out;
}

function staleCacheFindings(input: InvestigatorInput): Finding[] {
  const out: Finding[] = [];
  const mutations = input.entries.filter(
    (e) => MUTATING_METHODS.has(e.method) && statusClass(e) === 'success',
  );
  if (!mutations.length) return out;
  // Only cached GET responses can be stale; parse their paths once.
  const cachedGets = input.entries
    .filter(
      (e) =>
        e.method === 'GET' &&
        e.responseHeaders.some((h) => /^(age|x-nextjs-cache|x-cache|cf-cache-status)$/i.test(h.name)),
    )
    .map((e) => ({ e, path: pathOf(e.url) }));
  if (!cachedGets.length) return out;
  for (const m of mutations) {
    const collection = pathOf(m.url).replace(/\/[^/]+$/, '') || '/';
    const later = cachedGets
      .map((c) => c.e)
      .find((e, i) => {
        if (e.startedAt <= (m.endedAt ?? m.startedAt) || e.startedAt - (m.endedAt ?? 0) > 60_000)
          return false;
        if (!cachedGets[i]!.path.startsWith(collection)) return false;
        const age = Number(headerValue(e.responseHeaders, 'age') ?? 0);
        const hit = /hit/i.test(
          headerValue(e.responseHeaders, 'x-nextjs-cache') ??
            headerValue(e.responseHeaders, 'x-cache') ??
            headerValue(e.responseHeaders, 'cf-cache-status') ??
            '',
        );
        return age > 0 || hit;
      });
    if (!later) continue;
    out.push({
      id: `stale:${m.id}:${later.id}`,
      kind: 'stale-cache',
      severity: 'info',
      title: `Cached response for ${pathOf(later.url)} after ${m.method} ${pathOf(m.url)}`,
      observed: `The GET at ${time(later.startedAt)} was served from a cache after a successful mutation at ${time(m.startedAt)}.`,
      evidence: [
        { label: 'Mutation', value: `${m.method} ${m.url} → ${m.status}`, entryId: m.id },
        {
          label: 'Cache headers',
          value: later.responseHeaders
            .filter((h) => /age|cache/i.test(h.name))
            .map((h) => `${h.name}: ${h.value}`)
            .join('; '),
          entryId: later.id,
        },
      ],
      explanations: ['The UI may show data from before the mutation (stale cache).'],
      hypotheses: [
        {
          text: 'A cache (CDN, framework data cache or HTTP cache) returned data from before the mutation.',
          level: 'possible',
          because: 'Cache headers indicate a cached response; whether it is stale depends on content.',
        },
      ],
      nextSteps: [
        'Compare the response with the mutation result.',
        'Check cache invalidation (revalidatePath/revalidateTag, cache-control, client query cache).',
      ],
      confidence: 'low',
      evidenceLevel: 'possible',
      limitations: [
        'Client-side query caches (React Query, SWR, Apollo) are not visible unless they refetch over the network.',
      ],
      entryIds: [m.id, later.id],
    });
  }
  return out;
}

function hydrationFindings(input: InvestigatorInput): Finding[] {
  const events = input.timeline.filter((t) => t.data?.hydrationPattern === true);
  if (!events.length) return [];
  return [
    {
      id: 'hydration',
      kind: 'hydration',
      severity: 'warning',
      title: `${events.length} error(s) that look like hydration mismatches`,
      observed: 'Console or uncaught errors match known hydration-error wording.',
      evidence: events.slice(0, 5).map((t) => ({ label: time(t.timestamp), value: clip(t.message, 200) })),
      explanations: [
        'Server-rendered HTML differs from the first client render (dates, random values, browser-only APIs, user-specific data).',
      ],
      hypotheses: [
        {
          text: 'A server/client render mismatch.',
          level: 'possible',
          because: 'Identified by message wording only.',
        },
      ],
      nextSteps: [
        'Read the full message and component stack in DevTools.',
        'Look for values that differ between server and browser (Date.now(), Math.random(), window/localStorage).',
      ],
      confidence: 'low',
      evidenceLevel: 'possible',
      missingEvidence: ['React component stack (not captured)'],
      limitations: ['React internals are not inspected; this is a text pattern match.'],
      entryIds: [],
      refs: events.map((t) => ({ type: 'timeline' as const, id: t.id })),
    },
  ];
}

// ---- server spans --------------------------------------------------------------

function serverFindings(input: InvestigatorInput): Finding[] {
  const out: Finding[] = [];
  for (const s of input.spans ?? []) {
    const exception = s.events.find((e) => e.name === 'exception');
    const failedOutbound = s.outbound && ((s.httpStatus ?? 0) >= 400 || s.status === 'error');
    if (!exception && !failedOutbound && !(s.status === 'error' && !s.outbound)) continue;
    const evidence: Evidence[] = [
      {
        label: s.phase ?? s.kind,
        value: `${s.name}${s.httpStatus ? ` → ${s.httpStatus}` : ''}${s.duration !== undefined ? ` · ${formatDuration(s.duration)}` : ''}`,
      },
    ];
    if (s.statusMessage) evidence.push({ label: 'Status message', value: s.statusMessage });
    if (exception) {
      evidence.push({
        label: String(exception.attributes?.['exception.type'] ?? 'exception'),
        value: String(exception.attributes?.['exception.message'] ?? ''),
      });
    }
    if (s.responseBody) evidence.push({ label: 'Upstream response', value: clip(s.responseBody, 200) });
    out.push({
      id: `server:${s.id}`,
      kind: failedOutbound ? 'server-outbound' : 'server-error',
      severity: 'error',
      title: failedOutbound
        ? `Server-side call failed: ${s.httpMethod ?? ''} ${s.httpUrl ? pathOf(s.httpUrl) : s.name} → ${s.httpStatus ?? 'error'}`
        : `Server span failed: ${s.name}`,
      observed: `Reported by the server integration (${s.source}) at ${time(s.startTime)}${s.phase ? ` during ${s.phase}` : ''}.`,
      evidence,
      explanations: failedOutbound
        ? ['An upstream service the server depends on failed; the browser only sees the effect.']
        : ['The server code threw or marked the operation as failed.'],
      hypotheses: failedOutbound
        ? [
            {
              text: `The upstream service ${s.httpUrl ? safeUrl(s.httpUrl)?.host : ''} returned an error.`,
              level: 'confirmed',
              because: 'The outbound response status was recorded by the server.',
            },
          ]
        : exception
          ? [
              {
                text: `Unhandled ${String(exception.attributes?.['exception.type'] ?? 'exception')} in server code.`,
                level: 'confirmed',
                because: 'The server recorded an exception event.',
              },
            ]
          : [
              {
                text: 'The server marked the operation as failed.',
                level: 'strong',
                because: 'Span status is error; no exception detail recorded.',
              },
            ],
      nextSteps: [
        'Open the trace waterfall to see what else ran in this request.',
        'Check the upstream service or the stack trace in the exception event.',
      ],
      confidence: 'high',
      evidenceLevel: 'confirmed',
      limitations: ['Spans are only as complete as the server instrumentation.'],
      entryIds: [],
      refs: [{ type: 'span', id: s.id }],
    });
  }
  return out;
}

function openApiFindings(input: InvestigatorInput): Finding[] {
  const out: Finding[] = [];
  if (!input.openApi?.length) return out;
  for (const e of input.entries) {
    for (const doc of input.openApi) {
      const result = validateEntryAgainstOpenApi(e, input.bodies?.get(e.id), doc);
      if (!result.matched || !result.issues.length) continue;
      out.push({
        id: `openapi:${e.id}:${doc.title}`,
        kind: 'openapi',
        severity: result.issues.some((i) => i.part === 'response.status' || i.part === 'response.body')
          ? 'error'
          : 'warning',
        title: `${result.issues.length} contract violation(s) for ${result.operation} (${doc.title})`,
        observed: `Validated against the configured OpenAPI document "${doc.title}" ${doc.version}.`,
        evidence: result.issues.slice(0, 10).map((i) => ({
          label: `${i.part} ${i.path}`,
          value: `${i.message}${i.expected ? ` · expected ${i.expected}` : ''}${i.actual ? ` · actual ${i.actual}` : ''}`,
          entryId: e.id,
        })),
        explanations: ['The implementation and the contract disagree (one of them changed).'],
        hypotheses: [
          {
            text: 'The API or the client deviates from the documented contract.',
            level: 'confirmed',
            because: 'Checked field by field against the configured schema.',
          },
        ],
        nextSteps: ['Decide whether the contract or the implementation is wrong, and add a contract test.'],
        confidence: 'high',
        evidenceLevel: 'confirmed',
        limitations: [...result.notes, 'Only a JSON Schema subset and local $refs are supported.'],
        entryIds: [e.id],
      });
    }
  }
  return out;
}

export function investigatorFindings(input: InvestigatorInput): Finding[] {
  return [
    ...connectionFindings(input),
    ...messageFindings(input),
    ...expectationFindings(input),
    ...authFindings(input),
    ...pendingForeverFindings(input),
    ...responseMappingFindings(input),
    ...staleCacheFindings(input),
    ...hydrationFindings(input),
    ...serverFindings(input),
    ...openApiFindings(input),
  ];
}

/** Fills evidence levels for findings produced by the original Error Detective rules. */
export function withEvidenceLevels(f: Finding): Finding {
  if (f.evidenceLevel) return f;
  const level =
    f.kind === 'http-error' || f.kind === 'network-failure' || f.kind === 'slow'
      ? 'confirmed'
      : f.kind === 'contract'
        ? f.confidence === 'high'
          ? 'confirmed'
          : 'possible'
        : f.confidence === 'high'
          ? 'strong'
          : 'possible';
  return {
    ...f,
    evidenceLevel: level,
    hypotheses:
      f.hypotheses ??
      f.explanations.map((text) => ({
        text,
        level: 'possible',
        because: 'Common cause for this observation; not verified.',
      })),
  };
}
