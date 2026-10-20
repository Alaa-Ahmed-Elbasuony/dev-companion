// Evidence-based links between browser events, realtime messages and server
// spans. A link is "explicit" only when both sides carry the same identifier
// (W3C trace id, request/correlation id). Otherwise a time-and-path match is
// "probable"; several equally good candidates are "ambiguous" and not linked.
import { parseTraceparent } from '../capture/document-recorder';
import { isNegotiateUrl } from './realtime/signalr';
import { parseSocketIoUrl } from './realtime/socketio';
import type { NetworkEntry, RealtimeMessage, ServerSpan, TimelineEvent } from '../shared/types';
import { MUTATING_METHODS, headerValue, safeUrl } from '../shared/util';

export type RefType = 'request' | 'timeline' | 'rt-message' | 'rt-connection' | 'span' | 'trace';
export interface EventRef {
  type: RefType;
  id: string;
}

export type LinkStrength = 'explicit' | 'probable' | 'ambiguous';

export interface Link {
  from: EventRef;
  to: EventRef;
  strength: LinkStrength;
  /** Human-readable reason, e.g. 'shared trace id 4bf9…' or 'same path, started 12 ms later (time only)'. */
  evidence: string;
  /** For ambiguous links: the competing candidates. */
  candidates?: EventRef[];
}

const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id', 'request-id', 'x-amzn-requestid', 'cf-ray'];

export function traceIdOfEntry(entry: NetworkEntry): { traceId: string; via: string } | null {
  const req = parseTraceparent(headerValue(entry.requestHeaders, 'traceparent'));
  if (req) return { traceId: req.traceId, via: 'traceparent request header' };
  const res = parseTraceparent(headerValue(entry.responseHeaders, 'traceresponse'));
  if (res) return { traceId: res.traceId, via: 'traceresponse header' };
  const st = headerValue(entry.responseHeaders, 'server-timing');
  const m = st && /traceparent;desc="?([^",;]+)"?/i.exec(st);
  const fromTiming = m ? parseTraceparent(m[1]) : null;
  if (fromTiming) return { traceId: fromTiming.traceId, via: 'Server-Timing traceparent' };
  return null;
}

export function requestIdsOfEntry(entry: NetworkEntry): { value: string; header: string }[] {
  const out: { value: string; header: string }[] = [];
  for (const name of REQUEST_ID_HEADERS) {
    for (const list of [entry.responseHeaders, entry.requestHeaders]) {
      const v = headerValue(list, name);
      if (v && v.length >= 6 && v !== '[REDACTED]' && !out.some((o) => o.value === v))
        out.push({ value: v, header: name });
    }
  }
  return out;
}

export function pathOfSpan(span: ServerSpan): string | undefined {
  const a = span.attributes;
  const direct = a['url.path'] ?? a['http.target'];
  if (typeof direct === 'string') return direct.split('?')[0];
  if (span.httpUrl) return safeUrl(span.httpUrl)?.pathname;
  const m = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/.exec(span.name);
  return m?.[1]?.split('?')[0];
}

/** Root spans of incoming requests (not outbound calls). */
export function isIncomingRoot(span: ServerSpan, byId: Map<string, ServerSpan>): boolean {
  if (span.outbound || span.kind !== 'server') return false;
  const parent = span.parentSpanId ? byId.get(`${span.traceId}:${span.parentSpanId}`) : undefined;
  return !parent || parent.kind !== 'server';
}

const PROBABLE_WINDOW_MS = 300;

function timeMatch(
  candidates: ServerSpan[],
  method: string | undefined,
  path: string | undefined,
  start: number,
  end: number,
): ServerSpan[] {
  if (!path) return [];
  return candidates.filter((s) => {
    if (method && s.httpMethod && s.httpMethod !== method) return false;
    if (pathOfSpan(s) !== path) return false;
    return s.startTime >= start - PROBABLE_WINDOW_MS && s.startTime <= end + PROBABLE_WINDOW_MS;
  });
}

const shortId = (id: string) => `${id.slice(0, 8)}…`;

/** Links browser requests and document navigations to server traces. */
export function linkBrowserToServer(
  entries: NetworkEntry[],
  timeline: TimelineEvent[],
  spans: ServerSpan[],
): Link[] {
  const links: Link[] = [];
  if (!spans.length) return links;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const traces = new Set(spans.map((s) => s.traceId));
  const roots = spans.filter((s) => isIncomingRoot(s, byId));
  const requestIdIndex = new Map<string, ServerSpan>();
  for (const s of spans) {
    for (const [k, v] of Object.entries(s.attributes)) {
      if (
        /^http\.(request|response)\.header\.(x-request-id|x-correlation-id)$/.test(k) &&
        typeof v === 'string'
      ) {
        requestIdIndex.set(v, s);
      }
    }
  }
  const claimed = new Set<string>();

  for (const nav of timeline) {
    if (nav.kind !== 'navigation') continue;
    const traceId = typeof nav.data?.traceId === 'string' ? nav.data.traceId : undefined;
    if (traceId && traces.has(traceId)) {
      links.push({
        from: { type: 'timeline', id: nav.id },
        to: { type: 'trace', id: traceId },
        strength: 'explicit',
        evidence: `shared trace id ${shortId(traceId)} (<meta name="traceparent"> in the HTML)`,
      });
      claimed.add(traceId);
    }
  }

  for (const entry of entries) {
    const from: EventRef = { type: 'request', id: entry.id };
    const trace = traceIdOfEntry(entry);
    if (trace && traces.has(trace.traceId)) {
      links.push({
        from,
        to: { type: 'trace', id: trace.traceId },
        strength: 'explicit',
        evidence: `shared trace id ${shortId(trace.traceId)} (${trace.via})`,
      });
      claimed.add(trace.traceId);
      continue;
    }
    const rid = requestIdsOfEntry(entry).find((r) => requestIdIndex.has(r.value));
    if (rid) {
      const span = requestIdIndex.get(rid.value)!;
      links.push({
        from,
        to: { type: 'trace', id: span.traceId },
        strength: 'explicit',
        evidence: `shared ${rid.header} "${rid.value}"`,
      });
      claimed.add(span.traceId);
    }
  }

  // Probable links by method + path + time, only for traces without explicit evidence.
  // Any incoming server span with a readable path is a candidate (frameworks nest their own
  // request span under the HTTP server span); each trace counts once.
  const linked = new Set(links.map((l) => `${l.from.type}:${l.from.id}`));
  const perTrace = new Map<string, ServerSpan>();
  for (const s of [...roots, ...spans.filter((x) => x.kind === 'server' && !x.outbound && pathOfSpan(x))]) {
    if (claimed.has(s.traceId) || !pathOfSpan(s)) continue;
    const current = perTrace.get(s.traceId);
    if (!current || s.startTime < current.startTime) perTrace.set(s.traceId, s);
  }
  const free = [...perTrace.values()];
  const tryProbable = (
    from: EventRef,
    method: string | undefined,
    url: string,
    start: number,
    end: number,
  ) => {
    if (linked.has(`${from.type}:${from.id}`)) return;
    const path = safeUrl(url)?.pathname;
    const matches = timeMatch(free, method, path, start, end);
    if (matches.length === 1) {
      const s = matches[0]!;
      links.push({
        from,
        to: { type: 'trace', id: s.traceId },
        strength: 'probable',
        evidence: `same method and path ${path}; server span started ${Math.round(s.startTime - start)} ms after the browser request (time only, no shared id)`,
      });
    } else if (matches.length > 1) {
      links.push({
        from,
        to: { type: 'trace', id: matches[0]!.traceId },
        strength: 'ambiguous',
        evidence: `${matches.length} server requests to ${path} overlap in time; cannot tell which one served this request`,
        candidates: matches.map((m) => ({ type: 'trace', id: m.traceId })),
      });
    }
  };
  for (const entry of entries) {
    tryProbable(
      { type: 'request', id: entry.id },
      entry.method,
      entry.url,
      entry.startedAt,
      entry.endedAt ?? entry.startedAt,
    );
  }
  for (const nav of timeline) {
    if (nav.kind !== 'page-load') continue;
    // The document request started before the recorder: allow the whole page-load window.
    tryProbable({ type: 'timeline', id: nav.id }, 'GET', nav.pageUrl, nav.timestamp - 5000, nav.timestamp);
  }
  return links;
}

const MIN_SHARED_ID = 6;

/** Ids worth searching for in realtime payloads: request-id headers and id-like JSON fields. */
export function correlationIdsOf(
  entry: NetworkEntry,
  responseText?: string,
): { value: string; source: string }[] {
  const ids = requestIdsOfEntry(entry).map((r) => ({ value: r.value, source: `${r.header} header` }));
  if (responseText) {
    try {
      const v = JSON.parse(responseText) as Record<string, unknown>;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v)) {
          if (
            /(^id$|Id$|_id$|requestId|correlationId)/.test(k) &&
            (typeof val === 'string' || typeof val === 'number')
          ) {
            const s = String(val);
            if (s.length >= MIN_SHARED_ID && !ids.some((i) => i.value === s))
              ids.push({ value: s, source: `response field "${k}"` });
          }
        }
      }
    } catch {
      /* not JSON */
    }
  }
  return ids;
}

export const REALTIME_FOLLOW_MS = 5000;
/** Messages carrying a request's id are searched for this long after the request started. */
export const EXPLICIT_WINDOW_MS = 30_000;
const ID_TOKEN = /[A-Za-z0-9_.:-]{6,}/g;
const ID_TOKEN_EXACT = /^[A-Za-z0-9_.:-]{6,}$/;

/** Socket.IO polling, SignalR negotiation and SignalR long-polling/SSE send requests. */
export function isRealtimeTransportRequest(url: string): boolean {
  if (parseSocketIoUrl(url) || isNegotiateUrl(url)) return true;
  const u = safeUrl(url);
  return !!u && u.searchParams.has('id') && /\/hubs?\//i.test(u.pathname);
}

/**
 * Links HTTP requests to incoming realtime messages. Explicit when the message
 * contains an id from the request's response; otherwise incoming app messages
 * shortly after a completed mutation are probable (time only).
 */
export function linkRequestsToRealtime(
  entries: NetworkEntry[],
  messages: RealtimeMessage[],
  responseTexts: Map<string, string> = new Map(),
): Link[] {
  const links: Link[] = [];
  const incoming = messages.filter(
    // Application messages only: heartbeats and protocol control frames never carry business events.
    (m) =>
      m.direction === 'in' &&
      m.opcode === 'text' &&
      (!m.decoded || m.decoded.some((d) => d.category === 'app')),
  );
  // Requests that are themselves a realtime transport (polling, negotiation) are not application operations.
  const appEntries = entries.filter((e) => !isRealtimeTransportRequest(e.url));
  // Messages sorted by time, so each request only scans its own window (no requests x messages scan).
  const sorted = [...incoming].sort((a, b) => a.timestamp - b.timestamp);
  const firstAtOrAfter = (t: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.timestamp < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Index id-like tokens of every message once; each request then looks its ids up directly.
  const tokenIndex = new Map<string, number[]>();
  sorted.forEach((m, i) => {
    const text = m.text?.slice(0, 64 * 1024);
    if (!text) return;
    for (const token of new Set(text.match(ID_TOKEN) ?? [])) {
      const list = tokenIndex.get(token);
      if (list) list.push(i);
      else tokenIndex.set(token, [i]);
    }
  });
  const explicitMessages = new Set<string>();
  for (const entry of appEntries) {
    const ids = correlationIdsOf(entry, responseTexts.get(entry.id));
    if (!ids.length) continue;
    const from: EventRef = { type: 'request', id: entry.id };
    const until = entry.startedAt + EXPLICIT_WINDOW_MS;
    const seen = new Set<number>();
    for (const id of ids) {
      // Ids that are not a single token (spaces, quotes) fall back to a windowed substring scan.
      const indexes = ID_TOKEN_EXACT.test(id.value)
        ? (tokenIndex.get(id.value) ?? [])
        : sorted
            .map((_, i) => i)
            .slice(firstAtOrAfter(entry.startedAt))
            .filter((i) => sorted[i]!.text?.includes(id.value));
      for (const i of indexes) {
        const m = sorted[i]!;
        if (seen.has(i) || m.tabId !== entry.tabId || m.timestamp < entry.startedAt || m.timestamp > until)
          continue;
        seen.add(i);
        links.push({
          from,
          to: { type: 'rt-message', id: m.id },
          strength: 'explicit',
          evidence: `message contains ${id.source} "${id.value}"`,
        });
        explicitMessages.add(m.id);
      }
    }
  }
  // Time-only links: each message to the single most recent completed mutation before it
  // (a moving pointer over mutations sorted by completion time, per tab).
  const mutationsByTab = new Map<number, NetworkEntry[]>();
  for (const e of appEntries) {
    if (!MUTATING_METHODS.has(e.method) || e.state !== 'complete') continue;
    mutationsByTab.set(e.tabId, [...(mutationsByTab.get(e.tabId) ?? []), e]);
  }
  if (!mutationsByTab.size) return links;
  for (const list of mutationsByTab.values())
    list.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  const pointer = new Map<number, number>();
  const explicitByEntry = new Set(links.map((l) => l.from.id));
  for (const m of sorted) {
    if (explicitMessages.has(m.id)) continue;
    const list = mutationsByTab.get(m.tabId);
    if (!list) continue;
    let i = pointer.get(m.tabId) ?? -1;
    while (i + 1 < list.length && (list[i + 1]!.endedAt ?? list[i + 1]!.startedAt) <= m.timestamp + 200) i++;
    pointer.set(m.tabId, i);
    const best = i >= 0 ? list[i] : undefined;
    if (!best) continue;
    const delta = m.timestamp - (best.endedAt ?? best.startedAt);
    // A mutation already explained by a shared id does not get extra guesses.
    if (delta > REALTIME_FOLLOW_MS || explicitByEntry.has(best.id)) continue;
    links.push({
      from: { type: 'request', id: best.id },
      to: { type: 'rt-message', id: m.id },
      strength: 'probable',
      evidence: `received ${Math.round(delta)} ms after ${best.method} completed (time only, no shared id)`,
    });
  }
  return links;
}
