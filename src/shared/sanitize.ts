// Validation for untrusted data: events posted by page scripts (any script on
// the page can forge them) and imported session files.
import type {
  BodyKind,
  CaptureMechanism,
  CaptureSource,
  CapturedBody,
  EntryState,
  HeaderPair,
  LifecycleKind,
  MessageDirection,
  MessageOpcode,
  NetworkDraft,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RealtimeState,
  RealtimeTransport,
  ServerSpan,
  SpanKind,
  SpanStatus,
  TimelineDraft,
  TimelineKind,
} from './types';
import { clip, truncateText } from './util';

const BODY_KINDS: readonly BodyKind[] = ['none', 'text', 'json', 'form', 'binary', 'stream', 'unreadable'];
const STATES: readonly EntryState[] = ['pending', 'complete', 'error', 'aborted', 'timeout', 'incomplete'];
const SOURCES: readonly CaptureSource[] = ['fetch', 'xhr', 'beacon', 'replay', 'import', 'cdp'];
const TIMELINE_KINDS: readonly TimelineKind[] = [
  'console-error',
  'console-warn',
  'js-error',
  'unhandled-rejection',
  'route-change',
  'page-load',
  'marker',
  'form-submit',
  'click',
  'recording',
  'navigation',
  'ui-notification',
  'app-signal',
  'capture',
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? clip(v, max) : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

export function sanitizeHeaders(v: unknown): HeaderPair[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 200)
    .filter(isObj)
    .map((h) => ({ name: str(h.name, 256) ?? '', value: str(h.value, 8192) ?? '' }))
    .filter((h) => h.name !== '');
}

export function sanitizeBody(v: unknown, maxBytes: number): CapturedBody | undefined {
  if (!isObj(v)) return undefined;
  const kind = oneOf(v.kind, BODY_KINDS);
  if (!kind) return undefined;
  const body: CapturedBody = { kind };
  if (typeof v.text === 'string') {
    const t = truncateText(v.text, maxBytes);
    body.text = t.text;
    if (t.truncated) body.truncated = true;
  }
  const size = num(v.size);
  if (size !== undefined && size >= 0) body.size = size;
  if (v.truncated === true) body.truncated = true;
  body.contentType = str(v.contentType, 256);
  body.note = str(v.note, 500);
  if (body.truncated && !body.note) body.note = `Body truncated at ${maxBytes} bytes`;
  return body;
}

export function sanitizeDraft(v: unknown, maxBodyBytes: number): NetworkDraft | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 100);
  const url = str(v.url, 8192);
  const method =
    typeof v.method === 'string' && /^[A-Za-z]{1,16}$/.test(v.method) ? v.method.toUpperCase() : undefined;
  const state = oneOf(v.state, STATES);
  const startedAt = num(v.startedAt);
  if (!id || !url || !method || !state || startedAt === undefined) return null;
  const status = num(v.status);
  return {
    id,
    pageId: str(v.pageId, 100) ?? '',
    pageUrl: str(v.pageUrl, 8192) ?? '',
    source: oneOf(v.source, SOURCES) ?? 'fetch',
    method,
    url,
    finalUrl: str(v.finalUrl, 8192),
    redirected: v.redirected === true ? true : undefined,
    state,
    status: status !== undefined && status >= 0 && status < 1000 ? Math.round(status) : undefined,
    statusText: str(v.statusText, 200),
    requestHeaders: sanitizeHeaders(v.requestHeaders),
    responseHeaders: sanitizeHeaders(v.responseHeaders),
    startedAt,
    responseAt: num(v.responseAt),
    endedAt: num(v.endedAt),
    errorName: str(v.errorName, 100),
    errorMessage: str(v.errorMessage, 2000),
    initiatorStack: str(v.initiatorStack, 4000),
    warnings: Array.isArray(v.warnings)
      ? v.warnings
          .filter((w): w is string => typeof w === 'string')
          .slice(0, 20)
          .map((w) => clip(w, 300))
      : [],
    requestBody: sanitizeBody(v.requestBody, maxBodyBytes),
    responseBody: sanitizeBody(v.responseBody, maxBodyBytes),
  };
}

export function sanitizeTimelineDraft(v: unknown): TimelineDraft | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 100);
  const kind = oneOf(v.kind, TIMELINE_KINDS);
  const timestamp = num(v.timestamp);
  if (!id || !kind || timestamp === undefined) return null;
  const draft: TimelineDraft = {
    id,
    pageId: str(v.pageId, 100) ?? '',
    pageUrl: str(v.pageUrl, 8192) ?? '',
    kind,
    timestamp,
    message: str(v.message, 2000) ?? '',
    detail: str(v.detail, 4000),
    stack: str(v.stack, 4000),
  };
  const data = sanitizeFlatRecord(v.data, 40, 2000);
  if (data) draft.data = data;
  const source = oneOf(v.source, MECHANISMS);
  if (source) draft.source = source;
  return draft;
}

/** Flat string/number/boolean map with bounded keys and values. */
export function sanitizeFlatRecord(
  v: unknown,
  maxKeys: number,
  maxValue: number,
): Record<string, string | number | boolean> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [key, value] of Object.entries(v)) {
    if (n >= maxKeys) break;
    if (!/^[\w.:/-]{1,100}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = clip(value, maxValue);
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

// ---- server spans ----------------------------------------------------------------

const SPAN_KINDS: readonly SpanKind[] = ['server', 'client', 'internal', 'producer', 'consumer'];
const SPAN_STATUSES: readonly SpanStatus[] = ['ok', 'error', 'unset'];

/** Validates one span record from a local collector (untrusted input). */
export function sanitizeSpan(
  v: unknown,
  owner: { sessionId: string; origin: string },
  maxBodyBytes: number,
): ServerSpan | null {
  if (!isObj(v)) return null;
  const traceId =
    typeof v.traceId === 'string' && /^[\da-f]{32}$/i.test(v.traceId) ? v.traceId.toLowerCase() : undefined;
  const spanId =
    typeof v.spanId === 'string' && /^[\da-f]{16}$/i.test(v.spanId) ? v.spanId.toLowerCase() : undefined;
  const startTime = num(v.startTime);
  const name = str(v.name, 300);
  if (!traceId || !spanId || startTime === undefined || !name) return null;
  const parent =
    typeof v.parentSpanId === 'string' && /^[\da-f]{16}$/i.test(v.parentSpanId)
      ? v.parentSpanId.toLowerCase()
      : undefined;
  const endTime = num(v.endTime);
  const status = num(v.httpStatus);
  const span: ServerSpan = {
    id: `${traceId}:${spanId}`,
    traceId,
    spanId,
    parentSpanId: parent,
    name,
    kind: oneOf(v.kind, SPAN_KINDS) ?? 'internal',
    startTime,
    endTime,
    duration: endTime !== undefined ? Math.max(0, endTime - startTime) : undefined,
    status: oneOf(v.status, SPAN_STATUSES) ?? 'unset',
    statusMessage: str(v.statusMessage, 1000),
    phase: str(v.phase, 100),
    route: str(v.route, 500),
    httpMethod:
      typeof v.httpMethod === 'string' && /^[A-Za-z]{1,16}$/.test(v.httpMethod)
        ? v.httpMethod.toUpperCase()
        : undefined,
    httpUrl: str(v.httpUrl, 8192),
    httpStatus: status !== undefined && status > 0 && status < 1000 ? Math.round(status) : undefined,
    outbound: v.outbound === true,
    attributes: sanitizeFlatRecord(v.attributes, 60, 1000) ?? {},
    events: Array.isArray(v.events)
      ? v.events
          .filter(isObj)
          .slice(0, 20)
          .map((e) => ({
            name: str(e.name, 200) ?? 'event',
            time: num(e.time) ?? startTime,
            attributes: sanitizeFlatRecord(e.attributes, 20, 4000),
          }))
      : [],
    source: str(v.source, 100) ?? 'server',
    instrumentation: str(v.instrumentation, 200),
    serviceName: str(v.serviceName, 200),
    sessionId: owner.sessionId,
    origin: owner.origin,
    redactions: Math.max(0, Math.round(num(v.redactions) ?? 0)),
  };
  if (isObj(v.body)) {
    const req = isObj(v.body.request) ? v.body.request : undefined;
    const res = isObj(v.body.response) ? v.body.response : undefined;
    if (typeof req?.text === 'string') span.requestBody = truncateText(req.text, maxBodyBytes).text;
    if (typeof res?.text === 'string') {
      const t = truncateText(res.text, maxBodyBytes);
      span.responseBody = t.text;
      if (t.truncated || res.truncated === true) span.bodyTruncated = true;
    }
    const size = num(res?.size);
    if (size !== undefined && size >= 0) span.responseBodySize = Math.round(size);
    if (req?.truncated === true) span.bodyTruncated = true;
  }
  return span;
}

// ---- realtime ------------------------------------------------------------------

const MECHANISMS: readonly CaptureMechanism[] = ['main-world', 'cdp', 'adapter', 'derived', 'import'];
const TRANSPORTS: readonly RealtimeTransport[] = ['websocket', 'eventsource', 'fetch-stream', 'polling'];
const RT_STATES: readonly RealtimeState[] = ['connecting', 'open', 'reconnecting', 'closed', 'failed'];
const DIRECTIONS: readonly MessageDirection[] = ['in', 'out', 'none'];
const OPCODES: readonly MessageOpcode[] = ['text', 'binary', 'lifecycle'];
const LIFECYCLES: readonly LifecycleKind[] = ['connecting', 'open', 'error', 'close', 'reconnecting'];

const wsOrHttpUrl = (v: unknown): string | undefined => {
  const s = str(v, 8192);
  return s && /^(wss?|https?):\/\//i.test(s) ? s : undefined;
};

export function sanitizeConnectionDraft(v: unknown): RealtimeConnectionDraft | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 100);
  const url = wsOrHttpUrl(v.url);
  const transport = oneOf(v.transport, TRANSPORTS);
  const state = oneOf(v.state, RT_STATES);
  const createdAt = num(v.createdAt);
  if (!id || !url || !transport || !state || createdAt === undefined) return null;
  const closeCode = num(v.closeCode);
  return {
    id,
    pageId: str(v.pageId, 100) ?? '',
    pageUrl: str(v.pageUrl, 8192) ?? '',
    transport,
    url,
    requestedProtocols: Array.isArray(v.requestedProtocols)
      ? v.requestedProtocols
          .filter((p): p is string => typeof p === 'string')
          .slice(0, 20)
          .map((p) => clip(p, 200))
      : undefined,
    selectedProtocol: str(v.selectedProtocol, 200),
    state,
    createdAt,
    openedAt: num(v.openedAt),
    closedAt: num(v.closedAt),
    closeCode:
      closeCode !== undefined && closeCode >= 0 && closeCode < 10_000 ? Math.round(closeCode) : undefined,
    closeReason: str(v.closeReason, 500),
    wasClean: typeof v.wasClean === 'boolean' ? v.wasClean : undefined,
    errorMessage: str(v.errorMessage, 2000),
    warnings: Array.isArray(v.warnings)
      ? v.warnings
          .filter((w): w is string => typeof w === 'string')
          .slice(0, 20)
          .map((w) => clip(w, 300))
      : [],
    source: oneOf(v.source, MECHANISMS) ?? 'main-world',
  };
}

export function sanitizeMessageDraft(v: unknown, maxFrameBytes: number): RealtimeMessageDraft | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 100);
  const connectionId = str(v.connectionId, 100);
  const direction = oneOf(v.direction, DIRECTIONS);
  const opcode = oneOf(v.opcode, OPCODES);
  const timestamp = num(v.timestamp);
  if (!id || !connectionId || !direction || !opcode || timestamp === undefined) return null;
  const msg: RealtimeMessageDraft = {
    id,
    connectionId,
    direction,
    timestamp,
    opcode,
    source: oneOf(v.source, MECHANISMS) ?? 'main-world',
  };
  const size = num(v.size);
  if (size !== undefined && size >= 0) msg.size = Math.round(size);
  // Binary payloads are never stored, whatever the sender claims.
  if (opcode === 'text' && typeof v.text === 'string') {
    const t = truncateText(v.text, maxFrameBytes);
    msg.text = t.text;
    if (t.truncated || v.truncated === true) msg.truncated = true;
  } else if (v.truncated === true) msg.truncated = true;
  if (opcode === 'binary') msg.binaryType = str(v.binaryType, 40);
  if (opcode === 'lifecycle') {
    msg.lifecycle = oneOf(v.lifecycle, LIFECYCLES);
    if (!msg.lifecycle) return null;
  }
  if (isObj(v.sse)) {
    const retry = num(v.sse.retry);
    msg.sse = {
      type: str(v.sse.type, 200) || 'message',
      lastEventId: str(v.sse.lastEventId, 500),
      retry: retry !== undefined && retry >= 0 ? Math.round(retry) : undefined,
    };
  }
  msg.note = str(v.note, 1000);
  return msg;
}
