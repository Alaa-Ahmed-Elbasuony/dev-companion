// Builds an evidence-based investigation around one anchor event: what
// happened, related events (with how strongly each is linked), the earliest
// verified point of divergence, ranked causes, missing evidence, next steps,
// reproduction steps and regression-test suggestions. Never invents data:
// every statement is derived from recorded records and labeled.
import type {
  EntryBodies,
  InvestigationAnchor,
  NetworkEntry,
  RealtimeConnection,
  RealtimeExpectation,
  RealtimeMessage,
  ServerSpan,
  TimelineEvent,
} from '../shared/types';
import { MUTATING_METHODS, clip, formatDuration, safeUrl } from '../shared/util';
import { correlate } from './correlate';
import type { EvidenceLevel, Finding, Hypothesis } from './error-detector';
import { isFailure } from './filter';
import { appPacket, eventPayload, getPath } from './investigator-rules';
import type { EventRef, Link } from './trace-correlate';
import { linkBrowserToServer, linkRequestsToRealtime } from './trace-correlate';
import { messageTitle } from './unified-timeline';

export interface InvestigationData {
  entries: NetworkEntry[];
  timeline: TimelineEvent[];
  connections: RealtimeConnection[];
  messages: RealtimeMessage[];
  spans: ServerSpan[];
  findings: Finding[];
  bodies?: Map<string, EntryBodies>;
  expectations?: RealtimeExpectation[];
  serverTracingConfigured: boolean;
  adaptersEnabled: boolean;
  advancedCapture: boolean;
}

export type StepStatus = 'observed' | 'failed' | 'not-observed' | 'not-instrumented' | 'unknown';

export interface RelatedEvent {
  ref: EventRef;
  time: number;
  title: string;
  /** 'anchor' for the anchor itself; otherwise how the relation is supported. */
  relation: 'anchor' | 'explicit' | 'probable' | 'ambiguous' | 'same-trace' | 'same-connection';
  evidence: string;
  failed: boolean;
  /** When the outcome became known (response received, span ended); used to order failures. */
  outcomeAt: number;
}

export interface Divergence {
  ref: EventRef;
  title: string;
  time: number;
  /** confirmed: observed and explicitly linked; possible: earlier failure linked only by time. */
  level: EvidenceLevel;
  why: string;
}

export interface ChecklistStep {
  stage: string;
  status: StepStatus;
  detail: string;
  refs: EventRef[];
}

export interface InvestigationResult {
  anchor: InvestigationAnchor;
  title: string;
  whatHappened: string;
  related: RelatedEvent[];
  divergence?: Divergence;
  causes: (Hypothesis & { findingId: string; findingTitle: string })[];
  findings: Finding[];
  missingEvidence: string[];
  nextSteps: string[];
  reproduction: string[];
  regressionTests: string[];
  notificationChecklist?: ChecklistStep[];
  links: Link[];
}

const time = (t: number) => new Date(t).toLocaleTimeString();
const pathOf = (url: string) => {
  const u = safeUrl(url);
  return u ? `${u.pathname}${u.search}` : url;
};
const LEVEL_RANK: Record<EvidenceLevel, number> = { confirmed: 0, strong: 1, possible: 2, insufficient: 3 };

function describe(
  ref: EventRef,
  data: InvestigationData,
): { time: number; title: string; failed: boolean; outcomeAt: number } | null {
  switch (ref.type) {
    case 'request': {
      const e = data.entries.find((x) => x.id === ref.id);
      return e
        ? {
            time: e.startedAt,
            outcomeAt: e.endedAt ?? e.startedAt,
            title: `${e.method} ${pathOf(e.url)} → ${e.status ?? e.state}`,
            failed: isFailure(e),
          }
        : null;
    }
    case 'timeline': {
      const t = data.timeline.find((x) => x.id === ref.id);
      return t
        ? {
            time: t.timestamp,
            outcomeAt: t.timestamp,
            title: `${t.kind}: ${clip(t.message, 140)}`,
            failed: ['console-error', 'js-error', 'unhandled-rejection'].includes(t.kind),
          }
        : null;
    }
    case 'rt-message': {
      const m = data.messages.find((x) => x.id === ref.id);
      return m
        ? {
            time: m.timestamp,
            outcomeAt: m.timestamp,
            title: messageTitle(m),
            failed: !!m.parseError || m.lifecycle === 'error' || !!m.decoded?.some((d) => d.error),
          }
        : null;
    }
    case 'rt-connection': {
      const c = data.connections.find((x) => x.id === ref.id);
      return c
        ? {
            time: c.createdAt,
            outcomeAt: c.closedAt ?? c.openedAt ?? c.createdAt,
            title: `${c.transport} ${pathOf(c.url)} ${c.state}`,
            failed: c.state === 'failed',
          }
        : null;
    }
    case 'span': {
      const s = data.spans.find((x) => x.id === ref.id);
      return s
        ? {
            time: s.startTime,
            outcomeAt: s.endTime ?? s.startTime,
            title: `server ${s.outbound ? '→' : '←'} ${s.name}${s.httpStatus ? ` → ${s.httpStatus}` : ''}`,
            failed:
              s.status === 'error' ||
              (s.outbound && (s.httpStatus ?? 0) >= 400) ||
              (s.httpStatus ?? 0) >= 500,
          }
        : null;
    }
    case 'trace':
      return null;
  }
}

/** All links among the session's records (computed once per investigation). */
export function computeLinks(data: InvestigationData): Link[] {
  const links: Link[] = [];
  const responseTexts = new Map<string, string>();
  for (const [id, b] of data.bodies ?? []) if (b.response?.text) responseTexts.set(id, b.response.text);
  links.push(...linkBrowserToServer(data.entries, data.timeline, data.spans));
  links.push(...linkRequestsToRealtime(data.entries, data.messages, responseTexts));
  for (const [eventId, requestIds] of correlate(data.entries, data.timeline)) {
    const event = data.timeline.find((t) => t.id === eventId)!;
    for (const id of requestIds) {
      const interaction = event.kind === 'click' || event.kind === 'form-submit';
      links.push({
        from: interaction ? { type: 'timeline', id: eventId } : { type: 'request', id },
        to: interaction ? { type: 'request', id } : { type: 'timeline', id: eventId },
        strength: 'probable',
        evidence: interaction
          ? 'request started within 1.5 s after the interaction (time only)'
          : 'error logged within 5 s after the failed request (time only)',
      });
    }
  }
  return links;
}

function anchorRef(anchor: InvestigationAnchor): EventRef {
  return { type: anchor.type, id: anchor.id };
}

export function buildInvestigation(
  anchor: InvestigationAnchor,
  data: InvestigationData,
  links: Link[] = computeLinks(data),
): InvestigationResult | null {
  const anchorInfo = describe(anchorRef(anchor), data);
  if (!anchorInfo) return null;
  const related = new Map<string, RelatedEvent>();
  const add = (ref: EventRef, relation: RelatedEvent['relation'], evidence: string) => {
    const key = `${ref.type}:${ref.id}`;
    const info = describe(ref, data);
    if (!info) return;
    const existing = related.get(key);
    const order = ['anchor', 'explicit', 'same-trace', 'same-connection', 'probable', 'ambiguous'];
    if (existing && order.indexOf(existing.relation) <= order.indexOf(relation)) return;
    related.set(key, { ref, ...info, relation, evidence });
  };
  add(anchorRef(anchor), 'anchor', 'Selected event');

  // Spans of a trace become related through the trace.
  const traceSpans = (traceId: string, relation: RelatedEvent['relation'], evidence: string) => {
    for (const s of data.spans.filter((x) => x.traceId === traceId)) {
      if (
        s.outbound ||
        s.kind === 'server' ||
        s.status === 'error' ||
        s.events.some((e) => e.name === 'exception')
      ) {
        add({ type: 'span', id: s.id }, relation, evidence);
      }
    }
  };
  const isAnchor = (ref: EventRef) => ref.type === anchor.type && ref.id === anchor.id;
  for (const l of links) {
    if (l.strength === 'ambiguous') {
      if (isAnchor(l.from)) add(l.from, 'anchor', l.evidence);
      continue;
    }
    const other = isAnchor(l.from) ? l.to : isAnchor(l.to) ? l.from : null;
    if (!other) continue;
    if (other.type === 'trace') traceSpans(other.id, l.strength, l.evidence);
    else add(other, l.strength, l.evidence);
  }
  // Anchor is a span: everything in its trace, and browser events linked to that trace.
  if (anchor.type === 'span') {
    const span = data.spans.find((s) => s.id === anchor.id)!;
    traceSpans(span.traceId, 'same-trace', `same trace ${span.traceId.slice(0, 8)}…`);
    for (const l of links) {
      if (l.to.type === 'trace' && l.to.id === span.traceId && l.strength !== 'ambiguous')
        add(l.from, l.strength, l.evidence);
    }
  }
  // Anchor is a message or connection: lifecycle of the same connection.
  const connId =
    anchor.type === 'rt-connection'
      ? anchor.id
      : anchor.type === 'rt-message'
        ? data.messages.find((m) => m.id === anchor.id)?.connectionId
        : undefined;
  if (connId) {
    add({ type: 'rt-connection', id: connId }, 'same-connection', 'same connection');
    for (const m of data.messages.filter(
      (x) => x.connectionId === connId && (x.opcode === 'lifecycle' || x.parseError),
    )) {
      add({ type: 'rt-message', id: m.id }, 'same-connection', 'lifecycle of the same connection');
    }
    // Requests that the anchor message is linked to.
    for (const l of links)
      if (l.to.type === 'rt-message' && l.to.id === anchor.id) add(l.from, l.strength, l.evidence);
  }

  const relatedList = [...related.values()].sort((a, b) => a.time - b.time);
  const refKeys = new Set(relatedList.map((r) => `${r.ref.type}:${r.ref.id}`));
  const relatedEntryIds = new Set(relatedList.filter((r) => r.ref.type === 'request').map((r) => r.ref.id));
  const findings = data.findings.filter(
    (f) =>
      f.entryIds.some((id) => relatedEntryIds.has(id)) ||
      f.refs?.some((r) => refKeys.has(`${r.type}:${r.id}`)),
  );

  // Earliest verified divergence: the first failure among events linked by evidence.
  // Failures are ordered by when their outcome became known: an upstream 503 inside a
  // request is observed before the browser receives that request's 500.
  const byOutcome = [...relatedList].sort((a, b) => a.outcomeAt - b.outcomeAt);
  const verified = byOutcome.filter(
    (r) =>
      r.failed &&
      (r.relation === 'anchor' ||
        r.relation === 'explicit' ||
        r.relation === 'same-trace' ||
        r.relation === 'same-connection'),
  );
  const earliestVerified = verified[0];
  const earlierProbable = byOutcome.find(
    (r) =>
      r.failed &&
      r.relation === 'probable' &&
      (!earliestVerified || r.outcomeAt < earliestVerified.outcomeAt),
  );
  let divergence: Divergence | undefined;
  if (earliestVerified) {
    divergence = {
      ref: earliestVerified.ref,
      title: earliestVerified.title,
      time: earliestVerified.time,
      level: 'confirmed',
      why:
        earliestVerified.relation === 'anchor'
          ? 'The selected event is the earliest failure linked to it by evidence.'
          : `Earliest failure linked by evidence (${earliestVerified.evidence}).`,
    };
  } else if (!anchorInfo.failed) {
    divergence = undefined;
  }
  const missingEvidence = new Set<string>(findings.flatMap((f) => f.missingEvidence ?? []));
  if (earlierProbable) {
    missingEvidence.add(
      `An earlier failure (${earlierProbable.title} at ${time(earlierProbable.time)}) is linked only by time; a shared request or trace id would confirm it`,
    );
  }

  // Missing instrumentation that matters for this anchor.
  const anchorEntry = anchor.type === 'request' ? data.entries.find((e) => e.id === anchor.id) : undefined;
  const hasServerLink = relatedList.some((r) => r.ref.type === 'span');
  if (!data.serverTracingConfigured) {
    missingEvidence.add(
      'Backend/SSR spans: no server integration is configured, so server-side requests and errors are not visible',
    );
  } else if (anchorEntry && !hasServerLink) {
    missingEvidence.add(
      'No server span is linked to this request (no shared trace id, and no unambiguous path/time match)',
    );
  }
  const bodies = anchorEntry ? data.bodies?.get(anchorEntry.id) : undefined;
  if (bodies?.request?.truncated || bodies?.response?.truncated)
    missingEvidence.add('The request or response body was truncated at capture');
  if (anchor.type === 'rt-message' || anchor.type === 'rt-connection') {
    if (!data.adaptersEnabled)
      missingEvidence.add('Whether the frontend handler ran (enable the page adapter for this origin)');
    if (!data.advancedCapture)
      missingEvidence.add(
        'SSE event types the page does not subscribe to, and handshake status (advanced capture is off)',
      );
  }

  const causes = findings
    .flatMap((f) =>
      (
        f.hypotheses ??
        f.explanations.map((text) => ({
          text,
          level: 'possible' as const,
          because: 'Common cause; not verified.',
        }))
      ).map((h) => ({ ...h, findingId: f.id, findingTitle: f.title })),
    )
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);

  const nextSteps = [...new Set(findings.flatMap((f) => f.nextSteps))].slice(0, 10);
  const reproduction = reproductionSteps(anchorInfo.time, anchorInfo, data, anchor);
  const regressionTests = regressionSuggestions(findings, anchorEntry);

  const messageAnchor =
    anchor.type === 'rt-message' ? data.messages.find((m) => m.id === anchor.id) : undefined;
  const checklist =
    messageAnchor ||
    (anchorEntry &&
      MUTATING_METHODS.has(anchorEntry.method) &&
      (data.connections.length || data.expectations?.length))
      ? notificationChecklist(data, { message: messageAnchor, trigger: anchorEntry }, links)
      : undefined;

  return {
    anchor,
    title: anchorInfo.title,
    whatHappened: `${anchorInfo.title} at ${time(anchorInfo.time)}.${anchorInfo.failed ? ' This event failed.' : ''} ${relatedList.length - 1} related event(s): ${relatedList.filter((r) => r.relation === 'explicit' || r.relation === 'same-trace').length} linked by shared identifiers, ${relatedList.filter((r) => r.relation === 'probable').length} by time only.`,
    related: relatedList,
    divergence,
    causes,
    findings,
    missingEvidence: [...missingEvidence],
    nextSteps,
    reproduction,
    regressionTests,
    notificationChecklist: checklist,
    links,
  };
}

/** Steps observed in the 60 s before the anchor in the same tab: navigations, interactions and mutations. */
function reproductionSteps(
  anchorTime: number,
  anchorInfo: { title: string },
  data: InvestigationData,
  anchor: InvestigationAnchor,
): string[] {
  const tab =
    anchor.type === 'request'
      ? data.entries.find((e) => e.id === anchor.id)?.tabId
      : anchor.type === 'timeline'
        ? data.timeline.find((t) => t.id === anchor.id)?.tabId
        : anchor.type === 'rt-message'
          ? data.messages.find((m) => m.id === anchor.id)?.tabId
          : undefined;
  const from = anchorTime - 60_000;
  const steps: { time: number; text: string }[] = [];
  for (const t of data.timeline) {
    if ((tab !== undefined && t.tabId !== tab) || t.timestamp < from || t.timestamp > anchorTime) continue;
    if (t.kind === 'page-load') steps.push({ time: t.timestamp, text: `Open ${t.pageUrl}` });
    else if (t.kind === 'route-change')
      steps.push({ time: t.timestamp, text: `Navigate in-app (${t.detail ?? t.message})` });
    else if (t.kind === 'click')
      steps.push({ time: t.timestamp, text: t.message.replace(/^Clicked/, 'Click') });
    else if (t.kind === 'form-submit')
      steps.push({
        time: t.timestamp,
        text: `Submit ${t.message.replace(/ submitted.*/, '')} (field values are not recorded; enter the same data manually)`,
      });
  }
  for (const e of data.entries) {
    if ((tab !== undefined && e.tabId !== tab) || e.startedAt < from || e.startedAt > anchorTime) continue;
    if (MUTATING_METHODS.has(e.method)) {
      steps.push({
        time: e.startedAt,
        text: `(app sends ${e.method} ${pathOf(e.url)} → ${e.status ?? e.state}; MUTATION: creates or changes server data)`,
      });
    }
  }
  const out = steps.sort((a, b) => a.time - b.time).map((s, i) => `${i + 1}. ${s.text}`);
  out.push(`${out.length + 1}. Observe: ${anchorInfo.title}`);
  if (out.length === 1)
    out.unshift(
      'No interactions were recorded before the event (enable "Record clicks and form submissions" or reproduce from a page load).',
    );
  return out;
}

function regressionSuggestions(findings: Finding[], anchorEntry: NetworkEntry | undefined): string[] {
  const out = new Set<string>();
  for (const f of findings) {
    switch (f.kind) {
      case 'http-error':
        if (anchorEntry)
          out.add(
            `API test: ${anchorEntry.method} ${pathOf(anchorEntry.url)} with the recorded payload returns the expected status (got ${anchorEntry.status}).`,
          );
        out.add('UI test: the page shows an error state (not a crash) when this endpoint fails.');
        break;
      case 'response-mapping':
        out.add('Unit test: the response handler checks the status before reading success fields.');
        break;
      case 'duplicate-event':
        out.add(
          'UI test: delivering the same realtime event twice shows one notification (idempotent handler).',
        );
        break;
      case 'expectation':
        out.add(
          'Integration test: after the triggering request, the client receives the event with all required fields.',
        );
        break;
      case 'reconnect-storm':
      case 'realtime-close':
        out.add(
          'Test: the client reconnects with backoff and resubscribes exactly once after a dropped connection.',
        );
        break;
      case 'server-outbound':
        out.add(
          'Server test: rendering degrades gracefully when the upstream returns an error (as recorded).',
        );
        break;
      case 'openapi':
      case 'contract':
        out.add('Contract test for this operation using the configured schema.');
        break;
      case 'pending-forever':
        out.add('Test: requests have a timeout and the loading state ends with an error message.');
        break;
      case 'auth':
        out.add('Test: an expired session triggers re-authentication instead of failing silently.');
        break;
      default:
        break;
    }
  }
  if (!out.size && anchorEntry)
    out.add(
      `Add a test that performs the reproduction steps and asserts ${anchorEntry.method} ${pathOf(anchorEntry.url)} succeeds.`,
    );
  return [...out];
}

/**
 * Stage-by-stage check of a realtime notification. A stage the extension cannot
 * observe is "not-instrumented", never assumed to have happened.
 */
export function notificationChecklist(
  data: InvestigationData,
  target: { message?: RealtimeMessage; trigger?: NetworkEntry },
  links: Link[] = [],
): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  const msg =
    target.message ?? (target.trigger ? firstLinkedMessage(target.trigger, data, links) : undefined);
  const at = msg?.timestamp ?? target.trigger?.endedAt ?? target.trigger?.startedAt ?? 0;
  const tabId = msg?.tabId ?? target.trigger?.tabId;
  const name = msg ? appPacket(msg)?.name : undefined;
  const expectation = data.expectations?.find((e) =>
    name
      ? e.eventName === name
      : target.trigger && (!e.afterMethod || e.afterMethod === target.trigger.method),
  );

  // 1. Connection established.
  const conns = data.connections.filter(
    (c) => c.tabId === tabId && c.createdAt <= at && (c.openedAt !== undefined || c.transport === 'polling'),
  );
  const conn = msg
    ? data.connections.find((c) => c.id === msg.connectionId)
    : conns.find((c) => !c.closedAt || c.closedAt >= at);
  steps.push(
    conn
      ? {
          stage: 'Realtime connection established',
          status: 'observed',
          detail: `${conn.transport} ${pathOf(conn.url)} (${conn.protocol}) opened ${conn.openedAt ? time(conn.openedAt) : 'before recording'}`,
          refs: [{ type: 'rt-connection', id: conn.id }],
        }
      : {
          stage: 'Realtime connection established',
          status: 'not-observed',
          detail: 'No open realtime connection was recorded in this tab at that time',
          refs: [],
        },
  );
  // 2. Server message reached the browser.
  steps.push(
    msg
      ? {
          stage: 'Server message reached the browser',
          status: 'observed',
          detail: `${messageTitle(msg)} at ${time(msg.timestamp)}`,
          refs: [{ type: 'rt-message', id: msg.id }],
        }
      : {
          stage: 'Server message reached the browser',
          status: 'not-observed',
          detail: target.trigger
            ? `No application message linked to ${target.trigger.method} ${pathOf(target.trigger.url)} was received`
            : 'No message',
          refs: [],
        },
  );
  // 3. Expected event.
  if (expectation) {
    const ok = !!msg && name === expectation.eventName;
    steps.push({
      stage: `Expected event "${expectation.eventName}" received`,
      status: ok ? 'observed' : 'not-observed',
      detail: ok
        ? 'Name matches the expectation'
        : `Received ${name ? `"${name}"` : 'nothing matching'} instead`,
      refs: msg ? [{ type: 'rt-message', id: msg.id }] : [],
    });
  } else {
    steps.push({
      stage: 'Expected event received',
      status: 'unknown',
      detail: name
        ? `Received "${name}"; no expectation configured to compare with`
        : 'No expectation configured (Settings → Realtime expectations)',
      refs: [],
    });
  }
  // 4. Payload valid.
  if (msg?.parseError) {
    steps.push({
      stage: 'Payload valid',
      status: 'failed',
      detail: msg.parseError,
      refs: [{ type: 'rt-message', id: msg.id }],
    });
  } else if (msg && expectation?.requiredFields.length) {
    const payload = eventPayload(msg);
    const missing = expectation.requiredFields.filter(
      (f) => getPath(payload, f) === undefined || getPath(payload, f) === null,
    );
    steps.push({
      stage: 'Payload valid',
      status: missing.length ? 'failed' : 'observed',
      detail: missing.length
        ? `Missing: ${missing.join(', ')}`
        : `All required fields present (${expectation.requiredFields.join(', ')})`,
      refs: [{ type: 'rt-message', id: msg.id }],
    });
  } else {
    steps.push({
      stage: 'Payload valid',
      status: msg ? 'unknown' : 'not-observed',
      detail: msg ? 'Decoded without errors; no required fields configured' : 'No message to check',
      refs: [],
    });
  }
  // 5. Handler ran (page adapter only).
  const after = (t: TimelineEvent, ms: number) =>
    t.tabId === tabId && t.timestamp >= at && t.timestamp - at <= ms;
  const handler = data.timeline.find(
    (t) => t.kind === 'app-signal' && after(t, 3000) && /handler|dispatched/i.test(t.message),
  );
  steps.push(
    !data.adaptersEnabled
      ? {
          stage: 'Frontend handler ran',
          status: 'not-instrumented',
          detail:
            'Not observable without the page adapter (Settings → Integrations); a received message does not prove the handler ran',
          refs: [],
        }
      : handler
        ? {
            stage: 'Frontend handler ran',
            status: 'observed',
            detail: `Reported by the page: ${handler.message} (${formatDuration(handler.timestamp - at)} later)`,
            refs: [{ type: 'timeline', id: handler.id }],
          }
        : {
            stage: 'Frontend handler ran',
            status: 'not-observed',
            detail: 'Adapter enabled, but the page reported no handler stage within 3 s',
            refs: [],
          },
  );
  // 6. UI notification displayed.
  const shown = data.timeline.filter(
    (t) =>
      (t.kind === 'ui-notification' || (t.kind === 'app-signal' && /toast|notif|shown/i.test(t.message))) &&
      after(t, 5000),
  );
  steps.push(
    !data.adaptersEnabled
      ? {
          stage: 'UI notification displayed',
          status: 'not-instrumented',
          detail: 'Not observable without the notification observer (Settings → Integrations)',
          refs: [],
        }
      : shown.length
        ? {
            stage: 'UI notification displayed',
            status: 'observed',
            detail: `"${clip(shown[0]!.message, 80)}"${shown.length > 1 ? ` and ${shown.length - 1} more` : ''}`,
            refs: shown.map((t) => ({ type: 'timeline' as const, id: t.id })),
          }
        : {
            stage: 'UI notification displayed',
            status: 'not-observed',
            detail: 'No text appeared in a watched notification region within 5 s',
            refs: [],
          },
  );
  // 7. Duplicates / reconnects.
  if (msg && name) {
    const dupes = data.messages.filter(
      (m) =>
        m.id !== msg.id &&
        m.tabId === tabId &&
        appPacket(m)?.name === name &&
        Math.abs(m.timestamp - msg.timestamp) <= 10_000 &&
        m.text === msg.text,
    );
    const reconnect = conn && conn.attempt > 0;
    steps.push({
      stage: 'No duplicates or reconnect replays',
      status: dupes.length || shown.length > 1 ? 'failed' : 'observed',
      detail: dupes.length
        ? `${dupes.length + 1} identical "${name}" messages within 10 s${shown.length > 1 ? `; ${shown.length} notifications shown` : ''}`
        : shown.length > 1
          ? `${shown.length} notifications appeared for one message`
          : `No identical "${name}" message within 10 s${reconnect ? '; note: this connection is a reconnect' : ''}`,
      refs: dupes.map((m) => ({ type: 'rt-message' as const, id: m.id })),
    });
  }
  return steps;
}

function firstLinkedMessage(
  trigger: NetworkEntry,
  data: InvestigationData,
  links: Link[],
): RealtimeMessage | undefined {
  const ordered = links
    .filter((l) => l.from.type === 'request' && l.from.id === trigger.id && l.to.type === 'rt-message')
    .sort((a, b) => (a.strength === 'explicit' ? -1 : 0) - (b.strength === 'explicit' ? -1 : 0));
  for (const l of ordered) {
    const m = data.messages.find((x) => x.id === l.to.id);
    if (m) return m;
  }
  return undefined;
}
