// Core data model shared by capture, storage, analysis and UI layers.

export type CaptureSource = 'fetch' | 'xhr' | 'beacon' | 'replay' | 'import' | 'cdp';

/**
 * Lifecycle of a captured request.
 * - pending: request started, no outcome observed yet.
 * - complete: an HTTP response was received (any status, including 4xx/5xx).
 * - error: the request failed before an HTTP response (network error, CORS, DNS...).
 * - aborted / timeout: the request was cancelled by the page or timed out.
 * - incomplete: the page navigated or unloaded before an outcome was observed.
 */
export type EntryState = 'pending' | 'complete' | 'error' | 'aborted' | 'timeout' | 'incomplete';

export const TERMINAL_STATES: readonly EntryState[] = [
  'complete',
  'error',
  'aborted',
  'timeout',
  'incomplete',
];

export type BodyKind = 'none' | 'text' | 'json' | 'form' | 'binary' | 'stream' | 'unreadable';

export interface CapturedBody {
  kind: BodyKind;
  /** Textual representation, possibly truncated. Absent for binary/stream/unreadable bodies. */
  text?: string;
  /** Approximate size of the original body in bytes, when known. */
  size?: number;
  truncated?: boolean;
  contentType?: string;
  /** Explanation when the body was not (fully) captured. */
  note?: string;
}

export interface HeaderPair {
  name: string;
  value: string;
}

/** Fields produced by the in-page recorder. Untrusted until sanitized. */
export interface NetworkDraft {
  id: string;
  pageId: string;
  pageUrl: string;
  source: CaptureSource;
  method: string;
  url: string;
  finalUrl?: string;
  redirected?: boolean;
  state: EntryState;
  status?: number;
  statusText?: string;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  startedAt: number;
  /** Time the response headers arrived. */
  responseAt?: number;
  endedAt?: number;
  errorName?: string;
  errorMessage?: string;
  initiatorStack?: string;
  warnings: string[];
  requestBody?: CapturedBody;
  responseBody?: CapturedBody;
}

/** Persisted request summary. Bodies are stored separately (see EntryBodies). */
export interface NetworkEntry {
  id: string;
  sessionId: string;
  tabId: number;
  pageId: string;
  pageUrl: string;
  /** Origin of the page that issued the request. */
  origin: string;
  source: CaptureSource;
  method: string;
  url: string;
  finalUrl?: string;
  redirected?: boolean;
  state: EntryState;
  status?: number;
  statusText?: string;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  requestContentType?: string;
  responseContentType?: string;
  requestBodySize?: number;
  responseBodySize?: number;
  requestBodyKind?: BodyKind;
  responseBodyKind?: BodyKind;
  startedAt: number;
  responseAt?: number;
  endedAt?: number;
  duration?: number;
  errorName?: string;
  errorMessage?: string;
  initiatorStack?: string;
  warnings: string[];
  /** Number of values removed by redaction before storage. */
  redactions: number;
  replayOf?: string;
  /** Approximate stored size in bytes (summary + bodies). */
  bytes: number;
}

export interface EntryBodies {
  id: string;
  request?: CapturedBody;
  response?: CapturedBody;
}

export type TimelineKind =
  | 'console-error'
  | 'console-warn'
  | 'js-error'
  | 'unhandled-rejection'
  | 'route-change'
  | 'page-load'
  | 'marker'
  | 'form-submit'
  | 'click'
  | 'recording'
  /** Document navigation metadata (Navigation Timing, Server-Timing, trace meta tags). */
  | 'navigation'
  /** Text that appeared in a configured notification region (opt-in DOM adapter). */
  | 'ui-notification'
  /** Stage reported by the application itself through the opt-in page API. */
  | 'app-signal'
  /** Capture-mechanism status (advanced capture attached/detached, frames dropped). */
  | 'capture';

export interface TimelineDraft {
  id: string;
  pageId: string;
  pageUrl: string;
  kind: TimelineKind;
  timestamp: number;
  message: string;
  detail?: string;
  stack?: string;
  /** Structured fields for kinds that carry them (navigation, app-signal). */
  data?: Record<string, string | number | boolean>;
  /** Mechanism that produced the event; absent means the main-world recorder. */
  source?: CaptureMechanism;
}

export interface TimelineEvent extends TimelineDraft {
  sessionId: string;
  tabId: number;
  origin: string;
}

export interface Session {
  id: string;
  tabId: number;
  origin: string;
  startedAt: number;
  endedAt?: number;
  label: string;
  imported?: boolean;
}

export interface RedactionRules {
  /** Header names (case-insensitive, exact) whose values are always removed. */
  headerNames: string[];
  /**
   * Key rules applied to JSON keys, form fields, query parameters and header names.
   * Plain rule = normalized substring match; rule prefixed with "=" = exact normalized match.
   * Normalization lowercases and strips "-", "_" and spaces.
   */
  keyRules: string[];
  /** Redact values that look like JWTs or "Bearer ..." tokens wherever they appear. */
  redactTokenValues: boolean;
  /** Redact Luhn-valid 13–19 digit numbers (payment card numbers). */
  redactCardNumbers: boolean;
}

export interface Settings {
  maxEntries: number;
  maxStorageMB: number;
  maxBodyKB: number;
  maxTimelineEvents: number;
  slowRequestMs: number;
  captureConsole: boolean;
  captureInteractions: boolean;
  captureStacks: boolean;
  redaction: RedactionRules;
  /** Record WebSocket and EventSource connections and messages. */
  captureRealtime: boolean;
  /** Frames larger than this are truncated before storage. */
  maxFrameKB: number;
  maxRealtimeMessages: number;
  maxSpans: number;
  /** Delete records older than this many days (0 = keep until other limits apply). */
  retentionDays: number;
  /** Parse fetch() responses of type text/event-stream incrementally (reads a clone). */
  captureFetchStreams: boolean;
  /** Origins where the opt-in page API (window.__devCompanion) and DOM notification observer run. */
  appAdapterOrigins: string[];
  /** CSS selectors watched by the notification adapter. */
  notificationSelectors: string[];
  serverIntegrations: ServerIntegration[];
  realtimeExpectations: RealtimeExpectation[];
}

/** Configuration sent to the in-page recorder. */
export interface CaptureConfig {
  enabled: boolean;
  maxBodyBytes: number;
  captureConsole: boolean;
  captureInteractions: boolean;
  captureStacks: boolean;
  /** Give up reading a response body after this long and keep what was read. */
  bodyReadTimeoutMs: number;
  captureRealtime: boolean;
  maxFrameBytes: number;
  captureFetchStreams: boolean;
  /** Opt-in page API and DOM notification observer enabled for this origin. */
  appAdapters: boolean;
  notificationSelectors: string[];
}

export interface RecordingState {
  sessionId: string;
  tabId: number;
  origin: string;
  startedAt: number;
  /** Capture temporarily suspended; the session and script registration are kept. */
  paused?: boolean;
  /** Advanced capture (chrome.debugger) is attached to this tab. */
  advanced?: boolean;
}

export interface ContractBaseline {
  /** Endpoint key, e.g. "GET api.example.com/api/orders/:id". */
  endpointKey: string;
  kind: 'inferred' | 'json-schema' | 'openapi';
  /** Inferred shape or JSON schema, as JSON. */
  schema: unknown;
  sourceEntryId?: string;
  createdAt: number;
}

// ---- Realtime communication -------------------------------------------------

export type RealtimeTransport = 'websocket' | 'eventsource' | 'fetch-stream' | 'polling';
/** Application protocol carried by the transport, detected from URLs and frames. */
export type RealtimeProtocol = 'raw' | 'socket.io' | 'signalr' | 'sse';
export type RealtimeState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';
/** Mechanism that observed a record. Several mechanisms may observe the same traffic. */
export type CaptureMechanism = 'main-world' | 'cdp' | 'adapter' | 'derived' | 'import';

/** Connection fields reported by a capture mechanism. Untrusted until sanitized. */
export interface RealtimeConnectionDraft {
  id: string;
  pageId: string;
  pageUrl: string;
  transport: RealtimeTransport;
  url: string;
  /** Sub-protocols requested by the page (WebSocket). */
  requestedProtocols?: string[];
  /** Sub-protocol selected by the server. */
  selectedProtocol?: string;
  state: RealtimeState;
  createdAt: number;
  openedAt?: number;
  closedAt?: number;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  errorMessage?: string;
  warnings: string[];
  source: CaptureMechanism;
}

export interface RealtimeConnection extends RealtimeConnectionDraft {
  sessionId: string;
  tabId: number;
  origin: string;
  protocol: RealtimeProtocol;
  /** Every mechanism that observed this connection. */
  sources: CaptureMechanism[];
  /** Ids under which other mechanisms reported this same connection (e.g. CDP request ids). */
  aliases?: string[];
  /** Why `protocol` was chosen, e.g. "EIO query parameter" or "negotiate request <id>". */
  protocolEvidence?: string;
  /** SignalR: the captured negotiate request that preceded this connection. */
  negotiateEntryId?: string;
  /** Earlier connection (same tab, URL without volatile params) this one replaced. */
  reconnectOf?: string;
  /** Socket.IO: the polling connection this WebSocket upgraded from. */
  upgradedFrom?: string;
  /** 0 for the first connection to an endpoint in a document, then 1, 2, ... */
  attempt: number;
  inCount: number;
  outCount: number;
  bytesIn: number;
  bytesOut: number;
  lastMessageAt?: number;
  redactions: number;
}

export type MessageDirection = 'in' | 'out' | 'none';
export type MessageOpcode = 'text' | 'binary' | 'lifecycle';
export type LifecycleKind = 'connecting' | 'open' | 'error' | 'close' | 'reconnecting';

export interface SseFields {
  /** Event type ("message" when the server sent no "event:" field). */
  type: string;
  lastEventId?: string;
  retry?: number;
}

export interface RealtimeMessageDraft {
  id: string;
  connectionId: string;
  direction: MessageDirection;
  timestamp: number;
  opcode: MessageOpcode;
  /** Payload size in bytes (UTF-8 for text), when known. */
  size?: number;
  /** Textual payload, possibly truncated. Never present for binary frames. */
  text?: string;
  truncated?: boolean;
  /** "arraybuffer" / "blob" / "typedarray" for binary frames. */
  binaryType?: string;
  sse?: SseFields;
  lifecycle?: LifecycleKind;
  /** Human-readable explanation for lifecycle records (close reason, error). */
  note?: string;
  source: CaptureMechanism;
}

/** Message category: app events vs protocol control vs keep-alive. */
export type DecodedCategory = 'app' | 'protocol' | 'heartbeat';

export interface DecodedPacket {
  protocol: RealtimeProtocol;
  category: DecodedCategory;
  /** Protocol packet type, e.g. "EVENT", "ACK", "Invocation", "Completion", "ping". */
  kind: string;
  /** Event name (Socket.IO), hub method target (SignalR), SSE event type, or a guessed JSON field. */
  name?: string;
  /** Where `name` came from when it is a guess, e.g. 'field "type"' for plain JSON frames. */
  nameSource?: string;
  args?: unknown[];
  namespace?: string;
  /** Socket.IO acknowledgement id. */
  ackId?: number;
  /** SignalR invocation id. */
  invocationId?: string;
  /** SignalR completion result or Socket.IO ack payload. */
  result?: unknown;
  error?: string;
  /** Binary attachments announced but not decoded. */
  attachments?: number;
}

export interface RealtimeMessage extends RealtimeMessageDraft {
  sessionId: string;
  tabId: number;
  /** One frame can carry several protocol packets (SignalR batches, polling payloads). */
  decoded?: DecodedPacket[];
  /** Set when the payload looked like a known protocol (or JSON) but was malformed. */
  parseError?: string;
  /** Why a payload was deliberately not decoded (truncated, binary hub protocol). Not an error. */
  decodeNote?: string;
  sources: CaptureMechanism[];
  /** connectionId|direction|size|hash, used to merge observations from several mechanisms. */
  dedupKey: string;
  redactions: number;
}

// ---- Server-side traces -----------------------------------------------------

export type SpanKind = 'server' | 'client' | 'internal' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';

export interface ServerSpan {
  /** `${traceId}:${spanId}` */
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: SpanStatus;
  statusMessage?: string;
  /** Rendering / execution context when reliably reported (e.g. Next.js span type). */
  phase?: string;
  route?: string;
  httpMethod?: string;
  httpUrl?: string;
  httpStatus?: number;
  /** Outbound request (client span) as opposed to the incoming request (server span). */
  outbound: boolean;
  /** Redacted, size-limited attributes. */
  attributes: Record<string, string | number | boolean>;
  events: { name: string; time: number; attributes?: Record<string, string | number | boolean> }[];
  /** Integration that produced it, e.g. "next-adapter". */
  source: string;
  /** Instrumentation library that created the span (e.g. next.js, @opentelemetry/instrumentation-http). */
  instrumentation?: string;
  /** Bounded, redacted bodies of outbound requests when the integration captured them. */
  requestBody?: string;
  responseBody?: string;
  responseBodySize?: number;
  bodyTruncated?: boolean;
  serviceName?: string;
  sessionId: string;
  /** App origin of the integration. */
  origin: string;
  redactions: number;
}

export interface ServerIntegration {
  id: string;
  /** Application origin whose recordings this integration enriches. */
  appOrigin: string;
  /** Local collector base URL, e.g. http://127.0.0.1:4319 */
  collectorUrl: string;
  enabled: boolean;
}

/**
 * Developer-provided expectation for notification debugging: after a matching
 * request completes successfully, the browser should receive `eventName`
 * within `withinMs`, and its payload should contain `requiredFields`.
 */
export interface RealtimeExpectation {
  id: string;
  label: string;
  /** Optional trigger: e.g. "POST" + "/api/orders". Without it, only payload fields are checked. */
  afterMethod?: string;
  afterPath?: string;
  eventName: string;
  withinMs: number;
  /** Dot paths inside the event payload (first argument), e.g. "orderId" or "order.id". */
  requiredFields: string[];
}

// ---- Investigations ---------------------------------------------------------

export interface InvestigationAnchor {
  type: 'request' | 'timeline' | 'rt-message' | 'rt-connection' | 'span';
  id: string;
}

export interface Investigation {
  id: string;
  title: string;
  sessionId: string;
  anchor: InvestigationAnchor;
  createdAt: number;
  updatedAt: number;
  expected?: string;
  notes: string;
  pinned: InvestigationAnchor[];
}
