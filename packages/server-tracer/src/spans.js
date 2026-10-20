// Converts OpenTelemetry ReadableSpans into the small, redacted JSON records the
// extension ingests, and keeps them in a bounded in-memory ring buffer.

const KINDS = ['internal', 'server', 'client', 'producer', 'consumer'];
const STATUS = ['unset', 'ok', 'error'];

/** Friendly names for span types that Next.js reports itself (attribute next.span_type). */
export const NEXT_PHASES = {
  'BaseServer.handleRequest': 'incoming request',
  'AppRender.getBodyResult': 'render (App Router)',
  'AppRender.fetch': 'server fetch',
  'AppRouteRouteHandlers.runHandler': 'route handler',
  'Render.getServerSideProps': 'getServerSideProps',
  'Render.getStaticProps': 'getStaticProps',
  'Render.renderDocument': 'render document (Pages Router)',
  'Middleware.execute': 'middleware',
  'ResolveMetadata.generateMetadata': 'generateMetadata',
  'NextNodeServer.findPageComponents': 'load page components',
  'NextNodeServer.renderToResponse': 'render to response',
  'NextNodeServer.clientComponentLoading': 'client component loading',
};

const DB_TEXT_ATTRIBUTES = ['db.statement', 'db.query.text'];
const MAX_ATTRIBUTES = 60;
const MAX_VALUE = 1000;

const hrToMs = (hr) => (Array.isArray(hr) ? hr[0] * 1000 + hr[1] / 1e6 : undefined);
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/**
 * @param {import('@opentelemetry/sdk-trace-base').ReadableSpan} span
 * @param {ReturnType<import('./redact.js').createRedactor>} r
 * @param {{ captureDbStatements?: boolean; source: string }} options
 */
export function toRecord(span, r, options) {
  r.reset();
  const ctx = span.spanContext();
  const a = span.attributes ?? {};
  const attributes = {};
  let n = 0;
  for (const [key, raw] of Object.entries(a)) {
    if (n >= MAX_ATTRIBUTES) break;
    if (raw === undefined || raw === null) continue;
    if (DB_TEXT_ATTRIBUTES.includes(key) && !options.captureDbStatements) continue;
    let value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const header = /^http\.(request|response)\.header\.(.+)$/.exec(key);
    if ((header && r.isSensitiveHeader(header[2])) || r.isSensitiveKey(key.split('.').pop() ?? key)) {
      value = '[REDACTED]';
      r.string(''); // count it
    } else if (typeof value === 'string') {
      value = /(^|\.)url($|\.full)|^http\.target$|^url\.query$/.test(key) ? r.url(value) : r.text(value);
      value = clip(value, MAX_VALUE);
    }
    attributes[key] = value;
    n++;
  }
  const kind = KINDS[span.kind] ?? 'internal';
  const httpUrl = attributes['url.full'] ?? attributes['http.url'];
  const nextType = attributes['next.span_type'];
  const start = hrToMs(span.startTime);
  const end = span.ended === false ? undefined : hrToMs(span.endTime);
  const parent = span.parentSpanContext?.spanId ?? span.parentSpanId;
  const status = STATUS[span.status?.code ?? 0] ?? 'unset';
  const statusCode = Number(attributes['http.response.status_code'] ?? attributes['http.status_code']);
  const method = attributes['http.request.method'] ?? attributes['http.method'];
  const scope = span.instrumentationScope?.name ?? span.instrumentationLibrary?.name ?? '';
  // HTTP instrumentation names client spans by method only ("GET"); add the URL.
  let name = r.text(span.name);
  if (kind === 'client' && name === method && typeof httpUrl === 'string') name = `${method} ${httpUrl}`;
  if (kind === 'server' && name === method) {
    const target = attributes['url.path'] ?? attributes['http.target'] ?? attributes['http.route'];
    if (typeof target === 'string') name = `${method} ${target.split('?')[0]}`;
  }
  let phase = typeof nextType === 'string' ? (NEXT_PHASES[nextType] ?? nextType) : undefined;
  if (!phase && /instrumentation-http/.test(scope))
    phase = kind === 'client' ? 'server http request (node:http)' : 'incoming http';
  if (!phase && /instrumentation-undici/.test(scope)) phase = 'server http request (undici)';
  if (!phase && scope === '@dev-companion/server-tracer') phase = 'server fetch';
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: parent || undefined,
    name: clip(name, 300),
    kind,
    startTime: start,
    endTime: end,
    duration: start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined,
    status,
    statusMessage: span.status?.message ? clip(r.text(span.status.message), 1000) : undefined,
    phase,
    instrumentation: scope || undefined,
    route: attributes['http.route'] ?? attributes['next.route'] ?? undefined,
    httpMethod: attributes['http.request.method'] ?? attributes['http.method'] ?? undefined,
    httpUrl: typeof httpUrl === 'string' ? httpUrl : undefined,
    httpStatus: Number.isFinite(statusCode) && statusCode > 0 ? statusCode : undefined,
    outbound: kind === 'client',
    attributes,
    events: (span.events ?? []).slice(0, 20).map((e) => ({
      name: e.name,
      time: hrToMs(e.time),
      attributes: Object.fromEntries(
        Object.entries(e.attributes ?? {})
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          .map(([k, v]) => [
            k,
            typeof v === 'string' ? clip(r.text(v), k === 'exception.stacktrace' ? 4000 : 1000) : v,
          ]),
      ),
    })),
    source: options.source,
    serviceName: span.resource?.attributes?.['service.name'],
    redactions: r.count,
  };
}

export class SpanBuffer {
  /** @param {{ max?: number; maxAgeMs?: number }} [opts] */
  constructor(opts = {}) {
    this.max = opts.max ?? 2000;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60_000;
    this.items = [];
    this.seq = 0;
    this.dropped = 0;
    /** Response/request bodies keyed by span id (filled asynchronously after the span may have ended). */
    this.bodies = new Map();
  }

  push(record) {
    this.items.push({ seq: ++this.seq, at: Date.now(), record });
    this.trim();
  }

  setBody(spanId, patch) {
    this.bodies.set(spanId, { ...this.bodies.get(spanId), ...patch });
    if (this.bodies.size > this.max) this.bodies.delete(this.bodies.keys().next().value);
  }

  trim() {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.items.length && (this.items.length > this.max || this.items[0].at < cutoff)) {
      const item = this.items.shift();
      this.bodies.delete(item.record.spanId);
      this.dropped++;
    }
  }

  /** Records after `cursor`, oldest first. */
  since(cursor, limit = 500) {
    this.trim();
    const out = [];
    let next = cursor;
    for (const item of this.items) {
      if (item.seq <= cursor) continue;
      if (out.length >= limit) break;
      const body = this.bodies.get(item.record.spanId);
      out.push(body ? { ...item.record, body } : item.record);
      next = item.seq;
    }
    return { spans: out, cursor: next, more: this.items.at(-1) ? this.items.at(-1).seq > next : false };
  }
}

/** A SpanExporter that redacts and buffers spans in-process (no network). */
export class BufferExporter {
  constructor(buffer, redactor, options) {
    this.buffer = buffer;
    this.redactor = redactor;
    this.options = options;
  }

  export(spans, resultCallback) {
    try {
      for (const span of spans) this.buffer.push(toRecord(span, this.redactor, this.options));
      resultCallback({ code: 0 });
    } catch (error) {
      // Instrumentation failures must never break the application.
      resultCallback({ code: 1, error });
    }
  }

  shutdown() {
    return Promise.resolve();
  }

  forceFlush() {
    return Promise.resolve();
  }
}
