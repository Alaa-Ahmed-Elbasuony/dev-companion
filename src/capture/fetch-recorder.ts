// Wraps window.fetch. The wrapper returns the *original* promise, so the page
// observes exactly the same Response object, resolution timing and rejection.
// All capture work is wrapped in try/catch so it can never break the page.
import type { CapturedBody, EntryState, NetworkDraft } from '../shared/types';
import { readResponseBody, serializeRequestBody } from './body';
import type { RecorderContext } from './context';
import { captureStack, describeError, headersToPairs } from './context';
import { isEventStream, parseFetchEventStream } from './fetch-stream';

type FetchFn = typeof fetch;

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

  const wrapped = function fetch(this: unknown, ...args: Parameters<FetchFn>): ReturnType<FetchFn> {
    let begin: ReturnType<typeof beginCapture> | undefined;
    try {
      if (ctx.config().enabled) begin = beginCapture(args[0], args[1]);
    } catch {
      begin = undefined;
    }
    // Call the original with the exact arguments and receiver.
    const promise = Reflect.apply(originalFetch, this, args) as ReturnType<FetchFn>;
    if (!begin) return promise;
    const capture = begin;
    promise.then(
      (response) => {
        void finishWithResponse(capture, response).catch(() => undefined);
      },
      (err: unknown) => {
        void finishWithError(capture, err).catch(() => undefined);
      },
    );
    return promise;
  };

  function beginCapture(input: RequestInfo | URL, init: RequestInit | undefined) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    let url = rawUrl;
    try {
      url = new URL(rawUrl, ctx.pageUrl()).href;
    } catch {
      /* keep raw */
    }
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
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
      initiatorStack: captureStack(ctx, 3),
      warnings: [],
    };
    const signal = init?.signal ?? (isRequest ? input.signal : undefined);
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
