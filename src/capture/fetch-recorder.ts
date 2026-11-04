// Wraps window.fetch. The wrapper returns the *original* promise, so the page
// observes exactly the same Response object, resolution timing and rejection.
// All capture work is wrapped in try/catch so it can never break the page.
//
// Exception: while the page holds simulation rules (opt-in, allowlisted dev origins
// only), a matching request gets a simulated outcome instead (see simulate.ts).
// Requests no rule applies to still get the original promise.
import type { CapturedBody, EntryState, NetworkDraft } from '../shared/types';
import { readResponseBody, serializeRequestBody } from './body';
import type { RecorderContext } from './context';
import { captureStack, describeError, headersToPairs, resolveRequestUrl } from './context';
import { isEventStream, parseFetchEventStream } from './fetch-stream';
import {
  GATE_TIMEOUT_NOTE,
  RELEASED_NOTE,
  describeSimulation,
  simulateFetch,
  simulatorFor,
  waitForGate,
} from './simulate';
import type { SimulationDecision } from './simulate';

type FetchFn = typeof fetch;

/** One page call: its receiver, arguments and call-site stack. */
interface Call {
  receiver: unknown;
  args: Parameters<FetchFn>;
  stack: string | undefined;
}

interface FetchTarget {
  fetch: FetchFn;
}

function stateForError(name: string): EntryState {
  if (name === 'AbortError') return 'aborted';
  if (name === 'TimeoutError') return 'timeout';
  return 'error';
}

export function installFetchRecorder(target: FetchTarget, ctx: RecorderContext): () => void {
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') return () => undefined;

  const simulator = simulatorFor(ctx);

  const wrapped = function fetch(this: unknown, ...args: Parameters<FetchFn>): ReturnType<FetchFn> {
    let stack: string | undefined;
    try {
      // Taken here, at the page's call site, so no recorder frame leads the stack
      // (and a request held at startup still records its real caller).
      if (ctx.config().enabled) stack = captureStack(ctx, 2);
    } catch {
      stack = undefined;
    }
    const call: Call = { receiver: this, args, stack };
    // The armed recorder holds requests issued before the simulation rules arrived.
    const gate = simulator.gate();
    return gate ? afterGate(gate, call) : intercept(call);
  };

  function afterGate(gate: Promise<void>, call: Call): ReturnType<FetchFn> {
    let signal: AbortSignal | undefined;
    try {
      signal = signalOf(call.args[0], call.args[1]);
    } catch {
      signal = undefined;
    }
    return waitForGate(gate, signal).then(() =>
      intercept(call, simulator.gateTimedOut() ? GATE_TIMEOUT_NOTE : undefined),
    );
  }

  function intercept(call: Call, note?: string): ReturnType<FetchFn> {
    let decision: SimulationDecision | undefined;
    if (simulator.active()) {
      try {
        const { method, url } = requestTarget(call.args[0], call.args[1]);
        decision = simulator.decide(method, url);
      } catch {
        decision = undefined;
      }
    }
    return decision ? simulated(call, decision) : passThrough(call, note);
  }

  function passThrough(call: Call, note?: string): ReturnType<FetchFn> {
    const { receiver, args } = call;
    let begin: ReturnType<typeof beginCapture> | undefined;
    try {
      if (ctx.config().enabled) begin = beginCapture(args[0], args[1], call.stack);
      if (begin && note) begin.draft.warnings.push(note);
    } catch {
      begin = undefined;
    }
    // Call the original with the exact arguments and receiver.
    const promise = Reflect.apply(originalFetch, receiver, args) as ReturnType<FetchFn>;
    if (!begin) return promise;
    observe(begin, promise);
    return promise;
  }

  /** A rule applies: the page gets the simulated outcome; capture records it like any request. */
  function simulated(call: Call, decision: SimulationDecision): ReturnType<FetchFn> {
    const { receiver, args } = call;
    let begin: ReturnType<typeof beginCapture> | undefined;
    try {
      if (ctx.config().enabled) begin = beginCapture(args[0], args[1], call.stack);
      if (begin) {
        // Set synchronously: network-start is emitted later, once the request body is read.
        begin.draft.simulated = { ...decision.info };
        begin.draft.warnings.push(describeSimulation(decision));
      }
    } catch {
      begin = undefined;
    }
    const promise = simulateFetch(simulator, decision, {
      url: requestTarget(args[0], args[1]).url,
      signal: signalOf(args[0], args[1]),
      send: () => Reflect.apply(originalFetch, receiver, args) as ReturnType<FetchFn>,
      onReleased: () => {
        if (!begin) return;
        begin.draft.simulated = { ...decision.info, sent: true };
        begin.draft.warnings.push(RELEASED_NOTE);
      },
    });
    if (begin) observe(begin, promise);
    return promise;
  }

  function observe(capture: ReturnType<typeof beginCapture>, promise: ReturnType<FetchFn>) {
    promise.then(
      (response) => {
        void finishWithResponse(capture, response).catch(() => undefined);
      },
      (err: unknown) => {
        void finishWithError(capture, err).catch(() => undefined);
      },
    );
  }

  function requestTarget(input: RequestInfo | URL, init: RequestInit | undefined) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = resolveRequestUrl(ctx, isRequest ? input.url : String(input));
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    return { url, method };
  }

  function signalOf(input: RequestInfo | URL, init: RequestInit | undefined): AbortSignal | undefined {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    return init?.signal ?? (isRequest ? input.signal : undefined);
  }

  function beginCapture(input: RequestInfo | URL, init: RequestInit | undefined, stack: string | undefined) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const { url, method } = requestTarget(input, init);
    let headers: Headers | undefined;
    try {
      headers = new Headers(
        init?.headers !== undefined ? init.headers : isRequest ? input.headers : undefined,
      );
    } catch {
      headers = undefined;
    }
    const contentType = headers?.get('content-type') ?? undefined;
    const cfg = ctx.config();

    // Request bodies: init.body is read directly; a Request body is cloned
    // synchronously *before* fetch disturbs it.
    let requestBody: Promise<CapturedBody | undefined>;
    if (init && 'body' in init && init.body !== undefined) {
      requestBody = serializeRequestBody(init.body, contentType, cfg.maxBodyBytes);
    } else if (isRequest && input.body !== null && !input.bodyUsed) {
      let clone: Request | undefined;
      try {
        clone = input.clone();
      } catch {
        clone = undefined;
      }
      requestBody = clone
        ? clone.text().then((text) => serializeRequestBody(text, contentType, cfg.maxBodyBytes))
        : Promise.resolve({ kind: 'unreadable', note: 'Request body could not be cloned' } as CapturedBody);
    } else {
      requestBody = Promise.resolve(undefined);
    }

    const draft: NetworkDraft = {
      id: ctx.newId(),
      pageId: ctx.pageId,
      pageUrl: ctx.pageUrl(),
      source: 'fetch',
      method,
      url,
      state: 'pending',
      requestHeaders: headersToPairs(headers),
      responseHeaders: [],
      startedAt: ctx.now(),
      initiatorStack: stack,
      warnings: [],
    };
    const signal = signalOf(input, init);
    const started = requestBody
      .catch((): CapturedBody => ({ kind: 'unreadable', note: 'Request body could not be read' }))
      .then((body) => {
        draft.requestBody = body;
        ctx.emit({ type: 'network-start', draft: { ...draft } });
      });
    return { draft, started, cfg, signal };
  }

  async function finishWithResponse(capture: ReturnType<typeof beginCapture>, response: Response) {
    const { draft, cfg } = capture;
    draft.responseAt = ctx.now();
    draft.status = response.status;
    draft.statusText = response.statusText;
    draft.responseHeaders = headersToPairs(response.headers);
    if (response.redirected || (response.url && stripHash(response.url) !== stripHash(draft.url))) {
      draft.redirected = response.redirected;
      draft.finalUrl = response.url || undefined;
    }
    if (response.type === 'opaque')
      draft.warnings.push('Opaque (no-cors) response: status and body are hidden by the browser');
    if (
      cfg.captureFetchStreams &&
      cfg.captureRealtime &&
      isEventStream(response.headers.get('content-type'))
    ) {
      try {
        parseFetchEventStream(response, draft.finalUrl ?? draft.url, ctx);
      } catch {
        /* never break the page */
      }
    }
    let body: CapturedBody;
    try {
      body = await readResponseBody(response, {
        maxBytes: cfg.maxBodyBytes,
        timeoutMs: cfg.bodyReadTimeoutMs,
        method: draft.method,
      });
    } catch (err) {
      body = { kind: 'unreadable', note: `Body capture failed: ${String(err)}` };
    }
    draft.responseBody = body;
    if (body.truncated) draft.warnings.push(body.note ?? 'Response body truncated');
    draft.state = 'complete';
    draft.endedAt = ctx.now();
    await capture.started;
    ctx.emit({ type: 'network-end', draft: { ...draft } });
  }

  async function finishWithError(capture: ReturnType<typeof beginCapture>, err: unknown) {
    const { draft, signal } = capture;
    const { name, message } = describeError(err);
    draft.state = stateForError(name);
    draft.errorName = name;
    draft.errorMessage = message;
    if (draft.state === 'aborted' && signal?.reason !== undefined) {
      const reason = describeError(signal.reason);
      if (reason.name === 'TimeoutError') draft.state = 'timeout';
    }
    if (draft.state === 'error') {
      draft.warnings.push(
        'No HTTP response received (network error, CORS, DNS, blocked by client, or offline)',
      );
    }
    draft.endedAt = ctx.now();
    await capture.started;
    ctx.emit({ type: 'network-end', draft: { ...draft } });
  }

  target.fetch = wrapped as FetchFn;
  return () => {
    if (target.fetch === wrapped) target.fetch = originalFetch;
  };
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
