// Development-only server tracing for Dev Companion.
//
// register() sets up an OpenTelemetry tracer provider whose spans stay in this
// process: they are redacted, kept in a bounded in-memory buffer and served by
// a loopback-only, token-protected collector that the extension pulls from.
// Nothing is sent anywhere. It refuses to run in production, during
// `next build`, in the Edge runtime, or unless DEV_COMPANION_TRACING=1.
import { syncBuiltinESMExports } from 'node:module';
import { context, trace } from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resolveToken, startCollector } from './collector.js';
import { DevCompanionPropagator } from './propagator.js';
import { createRedactor } from './redact.js';
import { BufferExporter, SpanBuffer } from './spans.js';

const STATE = Symbol.for('dev-companion.server-tracer');
const IGNORED_PATHS = /^\/(_next\/(static|webpack-hmr|image)|__nextjs|favicon\.ico)/;

/** Why tracing would not start in this process, or null when it may. */
export function disabledReason(env = process.env) {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production';
  if (env.NEXT_PHASE === 'phase-production-build') return 'running inside `next build`';
  if (env.NEXT_RUNTIME === 'edge') return 'the Edge runtime is not supported';
  if (env.DEV_COMPANION_TRACING !== '1') return 'DEV_COMPANION_TRACING is not "1"';
  return null;
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', size: 0, truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (text.length < limit) text += decoder.decode(value, { stream: true });
    if (size > limit * 4) {
      await reader.cancel().catch(() => undefined);
      return { text: text.slice(0, limit), size, truncated: true };
    }
  }
  return { text: text.slice(0, limit), size, truncated: text.length > limit };
}

const textual = (ct) => !ct || /json|text|xml|javascript|x-www-form-urlencoded/i.test(ct);

/**
 * Records request and response bodies of server-side fetch() calls (bounded,
 * redacted). The response is read from a clone; the caller receives the very
 * same Response object.
 */
function instrumentFetchBodies(buffer, r, limit, tracer) {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original[STATE]) return () => undefined;
  const wrapped = function fetch(input, init) {
    const active = trace.getActiveSpan();
    // Next.js creates its own span for every server fetch; outside Next.js we create one.
    const isNextFetch = active?.attributes?.['next.span_type'] === 'AppRender.fetch';
    const run = (span) => {
      const spanId = span?.spanContext().spanId;
      try {
        if (spanId && typeof init?.body === 'string' && init.body.length) {
          buffer.setBody(spanId, {
            request: { text: r.body(init.body.slice(0, limit)), truncated: init.body.length > limit },
          });
        }
      } catch {
        /* never break the request */
      }
      const promise = Reflect.apply(original, this, [input, init]);
      promise.then(
        (response) => {
          try {
            if (span && !isNextFetch) span.setAttribute('http.response.status_code', response.status);
            if (spanId && textual(response.headers.get('content-type'))) {
              readLimited(response.clone(), limit)
                .then((b) =>
                  buffer.setBody(spanId, {
                    response: {
                      ...b,
                      text: r.body(b.text),
                      contentType: response.headers.get('content-type') ?? undefined,
                    },
                  }),
                )
                .catch(() => undefined);
            }
          } catch {
            /* ignore */
          } finally {
            if (span && !isNextFetch) span.end();
          }
        },
        (err) => {
          if (span && !isNextFetch) {
            span.recordException(err);
            span.setStatus({ code: 2, message: String(err?.message ?? err) });
            span.end();
          }
        },
      );
      return promise;
    };
    if (isNextFetch) return run.call(this, active);
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      method = String(
        init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET'),
      ).toUpperCase();
    } catch {
      /* ignore */
    }
    const span = tracer.startSpan(`fetch ${method} ${url}`, {
      kind: 2,
      attributes: { 'http.request.method': method, 'url.full': url },
    });
    return context.with(trace.setSpan(context.active(), span), () => run.call(this, span));
  };
  wrapped[STATE] = true;
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/**
 * @param {import('./index.d.ts').RegisterOptions} [options]
 * @returns {Promise<import('./index.d.ts').RegisterResult>}
 */
export async function register(options = {}) {
  const reason = disabledReason();
  if (reason) {
    if (options.log !== false && process.env.DEV_COMPANION_TRACING === '1') {
      console.warn(`[dev-companion] server tracing disabled: ${reason}`);
    }
    return { enabled: false, reason };
  }
  // Survive Next.js dev-server module reloads: register once per process.
  if (globalThis[STATE]) return globalThis[STATE].result;

  const port = Number(options.port ?? process.env.DEV_COMPANION_COLLECTOR_PORT ?? 4319);
  const service = options.serviceName ?? process.env.npm_package_name ?? 'app';
  const limit = (options.maxBodyKB ?? 16) * 1024;
  const redactor = createRedactor(options.redaction);
  const buffer = new SpanBuffer({ max: options.maxSpans ?? 2000 });
  const { token, file } = resolveToken(options.tokenDir);

  const exporter = new BufferExporter(buffer, redactor, {
    captureDbStatements: options.captureDbStatements === true,
    source: options.source ?? 'next-adapter',
  });
  if (process.env.DEV_COMPANION_TRACING_FAIL === 'export') {
    // Test hook: simulate a broken exporter to verify the application is unaffected.
    exporter.export = (_spans, done) => done({ code: 1, error: new Error('simulated exporter failure') });
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': service }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // W3C trace context: incoming traceparents are honored; outbound headers are only
  // changed when propagateToOutbound is true (see propagator.js).
  provider.register({ propagator: new DevCompanionPropagator(options) });

  let collector;
  try {
    collector = await startCollector({ port, token, buffer, service });
  } catch (err) {
    console.warn(`[dev-companion] collector could not listen on 127.0.0.1:${port}: ${err?.message ?? err}`);
    const result = { enabled: false, reason: `collector port ${port} unavailable` };
    globalThis[STATE] = { result };
    return result;
  }

  const instrumentations = [
    new HttpInstrumentation({
      // Never trace the collector itself or framework asset/HMR traffic.
      ignoreIncomingRequestHook: (req) =>
        req.socket?.localPort === port || IGNORED_PATHS.test(new URL(req.url ?? '/', 'http://x').pathname),
      headersToSpanAttributes: {
        server: { requestHeaders: ['x-request-id', 'x-correlation-id', 'traceparent'] },
        client: { requestHeaders: ['x-request-id'], responseHeaders: ['x-request-id'] },
      },
    }),
  ];
  if (options.instrumentUndici) instrumentations.push(new UndiciInstrumentation());
  registerInstrumentations({ tracerProvider: provider, instrumentations });
  // node:http was already loaded by the framework; refresh ESM named imports
  // (`import { get } from 'node:http'`) so they see the patched functions too.
  syncBuiltinESMExports();

  const tracer = trace.getTracer('@dev-companion/server-tracer');
  if (options.captureBodies !== false) instrumentFetchBodies(buffer, redactor, limit, tracer);

  const url = `http://127.0.0.1:${port}`;
  if (options.log !== false) {
    console.log(
      `[dev-companion] server tracing on. Collector ${url} (loopback only).` +
        (file ? ` Token: ${file}` : ' Token: $DEV_COMPANION_TOKEN'),
    );
  }
  const result = { enabled: true, collectorUrl: url, tokenFile: file };
  globalThis[STATE] = { result, provider, collector, buffer };
  return result;
}

/** Stops tracing and the collector (tests, cleanup). */
export async function shutdown() {
  const state = globalThis[STATE];
  if (!state) return;
  delete globalThis[STATE];
  await new Promise((r) => (state.collector ? state.collector.close(() => r()) : r()));
  await state.provider?.shutdown().catch(() => undefined);
}
