// Patches XMLHttpRequest.prototype. Original methods are always called with the
// original receiver and arguments; capture only adds passive event listeners.
//
// Exception: while the page holds simulation rules (opt-in, allowlisted dev origins
// only), a matching asynchronous request gets a simulated outcome instead (see
// xhr-simulate.ts). Synchronous requests are never simulated.
import type { CapturedBody, NetworkDraft } from '../shared/types';
import { truncateText, utf8Length } from '../shared/util';
import { serializeRequestBody } from './body';
import type { RecorderContext } from './context';
import { captureStack, parseRawHeaders, resolveRequestUrl } from './context';
import { GATE_TIMEOUT_NOTE, RELEASED_NOTE, describeSimulation, simulatorFor } from './simulate';
import type { SimulationDecision } from './simulate';
import { createXhrSimulations, invalidStateError } from './xhr-simulate';

const DONE = 4;

interface XhrMeta {
  method: string;
  url: string;
  /** open() was called with async = true (the default). */
  async: boolean;
  headers: { name: string; value: string }[];
  outcome?: 'abort' | 'timeout' | 'error';
  draft?: NetworkDraft;
  started?: Promise<void>;
}

/** A matching rule, or the startup gate that has to open before one can be chosen. */
type SimulationPlan =
  { decision: SimulationDecision; gate?: undefined } | { gate: Promise<void>; decision?: undefined };

interface XhrHost {
  XMLHttpRequest: typeof XMLHttpRequest;
}

export function installXhrRecorder(host: XhrHost, ctx: RecorderContext): () => void {
  const XHR = host.XMLHttpRequest;
  if (typeof XHR !== 'function') return () => undefined;
  const proto = XHR.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const originalAbort = proto.abort;
  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();
  const listening = new WeakSet<XMLHttpRequest>();
  const simulator = simulatorFor(ctx);
  const simulations = createXhrSimulations();

  const open = function open(this: XMLHttpRequest, ...args: unknown[]) {
    const previous = meta.get(this);
    try {
      // Reused from its own load/error handler: record the finished request now,
      // before open() resets its response.
      if (previous?.draft && this.readyState === DONE) finish(this, previous, previous.draft);
    } catch {
      /* ignore */
    }
    const result = Reflect.apply(originalOpen, this, args) as void;
    try {
      abandon(previous);
      simulations.afterOpen(this);
    } catch {
      /* ignore */
    }
    try {
      const url = resolveRequestUrl(ctx, String(args[1]));
      // open(method, url, async): an explicit (even undefined) third argument is converted to boolean.
      const async = args.length < 3 || !!args[2];
      meta.set(this, { method: String(args[0]).toUpperCase(), url, async, headers: [] });
    } catch {
      /* ignore */
    }
    return result;
  };

  /**
   * open() terminates a pending request without any event. Without this, the
   * request's loadend listener would later record it with the next request's response.
   */
  function abandon(m: XhrMeta | undefined) {
    const draft = m?.draft;
    if (!m || !draft) return;
    m.draft = undefined;
    draft.state = 'aborted';
    draft.errorName = 'AbortError';
    draft.errorMessage = 'open() was called again before this request completed';
    draft.endedAt = ctx.now();
    const done = { ...draft };
    void (m.started ?? Promise.resolve()).then(() => ctx.emit({ type: 'network-end', draft: done }));
  }

  const setRequestHeader = function setRequestHeader(this: XMLHttpRequest, ...args: unknown[]) {
    // A simulated request counts as sent: headers can no longer be set.
    if (simulations.blocksSend(this)) throw invalidStateError('setRequestHeader');
    const result = Reflect.apply(originalSetRequestHeader, this, args) as void;
    try {
      meta.get(this)?.headers.push({ name: String(args[0]).toLowerCase(), value: String(args[1]) });
    } catch {
      /* ignore */
    }
    return result;
  };

  const send = function send(this: XMLHttpRequest, ...args: unknown[]) {
    // A simulated request in flight (or its final state) is not OPENED: send() throws like a native one.
    if (simulations.blocksSend(this)) throw invalidStateError('send');
    const m = meta.get(this);
    if (!m || !ctx.config().enabled) return Reflect.apply(originalSend, this, args) as void;
    const plan = m.async ? planSimulation(m) : undefined;
    let ok = false;
    try {
      begin(this, m, args[0]);
      ok = true;
    } catch {
      /* capture failure must not affect the page */
    }
    if (plan) {
      simulate(this, m, args, plan);
      return undefined;
    }
    try {
      return Reflect.apply(originalSend, this, args) as void;
    } catch (err) {
      if (ok && m.draft) {
        m.draft.state = 'error';
        m.draft.errorName = err instanceof Error ? err.name : 'Error';
        m.draft.errorMessage = err instanceof Error ? err.message : String(err);
        m.draft.endedAt = ctx.now();
        m.draft.warnings.push('send() threw synchronously; the request was not sent');
        const draft = { ...m.draft };
        m.draft = undefined;
        void m.started?.then(() => ctx.emit({ type: 'network-end', draft }));
      }
      throw err;
    }
  };

  const abort = function abort(this: XMLHttpRequest, ...args: unknown[]) {
    let handled: boolean;
    try {
      handled = simulations.abort(this);
    } catch {
      handled = false;
    }
    if (handled) return undefined;
    return Reflect.apply(originalAbort, this, args) as void;
  };

  function planSimulation(m: XhrMeta): SimulationPlan | undefined {
    try {
      const gate = simulator.gate();
      if (gate) return { gate };
      if (!simulator.active()) return undefined;
      const decision = simulator.decide(m.method, m.url);
      return decision ? { decision } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The page gets a simulated outcome; capture records it through the usual listeners. */
  function simulate(xhr: XMLHttpRequest, m: XhrMeta, args: unknown[], plan: SimulationPlan) {
    const draft = m.draft;
    const mark = (decision: SimulationDecision) => {
      if (!draft) return;
      draft.simulated = { ...decision.info };
      draft.warnings.push(describeSimulation(decision));
    };
    if (plan.decision) mark(plan.decision);
    simulations.start(xhr, {
      sim: simulator,
      url: m.url,
      decision: plan.decision,
      gate: plan.gate,
      decideLater: () => {
        try {
          return simulator.decide(m.method, m.url);
        } catch {
          return undefined;
        }
      },
      send: () => Reflect.apply(originalSend, xhr, args) as void,
      onDecision: mark,
      onReleased: (decision) => {
        if (!draft) return;
        draft.simulated = { ...decision.info, sent: true };
        draft.warnings.push(RELEASED_NOTE);
      },
      onGateTimeout: () => draft?.warnings.push(GATE_TIMEOUT_NOTE),
    });
  }

  function begin(xhr: XMLHttpRequest, m: XhrMeta, body: unknown) {
    m.outcome = undefined;
    const cfg = ctx.config();
    const contentType = m.headers.find((h) => h.name === 'content-type')?.value;
    const draft: NetworkDraft = {
      id: ctx.newId(),
      pageId: ctx.pageId,
      pageUrl: ctx.pageUrl(),
      source: 'xhr',
      method: m.method,
      url: m.url,
      state: 'pending',
      requestHeaders: [...m.headers],
      responseHeaders: [],
      startedAt: ctx.now(),
      initiatorStack: captureStack(ctx, 3),
      warnings: [],
    };
    m.draft = draft;
    m.started = serializeRequestBody(body, contentType, cfg.maxBodyBytes)
      .catch((): CapturedBody => ({ kind: 'unreadable', note: 'Request body could not be read' }))
      .then((rb) => {
        draft.requestBody = rb;
        ctx.emit({ type: 'network-start', draft: { ...draft } });
      });

    if (!listening.has(xhr)) {
      listening.add(xhr);
      xhr.addEventListener('abort', () => setOutcome(xhr, 'abort'));
      xhr.addEventListener('timeout', () => setOutcome(xhr, 'timeout'));
      xhr.addEventListener('error', () => setOutcome(xhr, 'error'));
    }
    // Every loadend of this request's own outcome fires at DONE. One at another state
    // belongs to the previous request of a reused object (open() + send() from its
    // load handler, after which the browser still dispatches that request's loadend).
    const onLoadEnd = () => {
      if (xhr.readyState !== DONE) return;
      xhr.removeEventListener('loadend', onLoadEnd);
      try {
        finish(xhr, m, draft);
      } catch {
        /* ignore */
      }
    };
    xhr.addEventListener('loadend', onLoadEnd);
  }

  function setOutcome(xhr: XMLHttpRequest, outcome: XhrMeta['outcome']) {
    const m = meta.get(xhr);
    if (m) m.outcome = outcome;
  }

  function finish(xhr: XMLHttpRequest, m: XhrMeta, draft: NetworkDraft) {
    if (m.draft !== draft) return;
    m.draft = undefined;
    const cfg = ctx.config();
    draft.endedAt = ctx.now();
    if (m.outcome === 'abort') {
      draft.state = 'aborted';
      draft.errorName = 'AbortError';
      draft.errorMessage = 'XMLHttpRequest aborted';
    } else if (m.outcome === 'timeout') {
      draft.state = 'timeout';
      draft.errorName = 'TimeoutError';
      draft.errorMessage = `XMLHttpRequest timed out after ${xhr.timeout} ms`;
    } else if (m.outcome === 'error' || xhr.status === 0) {
      draft.state = 'error';
      draft.errorName = 'NetworkError';
      draft.errorMessage = 'XMLHttpRequest failed before receiving an HTTP response';
      draft.warnings.push(
        'No HTTP response received (network error, CORS, DNS, blocked by client, or offline)',
      );
    } else {
      draft.state = 'complete';
      draft.status = xhr.status;
      draft.statusText = xhr.statusText;
      draft.responseAt = draft.endedAt;
      draft.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
      if (xhr.responseURL && xhr.responseURL !== draft.url) {
        draft.redirected = true;
        draft.finalUrl = xhr.responseURL;
      }
      draft.responseBody = readXhrBody(xhr, cfg.maxBodyBytes, draft);
      if (draft.responseBody.truncated) draft.warnings.push('Response body truncated');
    }
    const done = { ...draft };
    void (m.started ?? Promise.resolve()).then(() => ctx.emit({ type: 'network-end', draft: done }));
  }

  proto.open = open as typeof proto.open;
  proto.setRequestHeader = setRequestHeader as typeof proto.setRequestHeader;
  proto.send = send as typeof proto.send;
  proto.abort = abort as typeof proto.abort;
  return () => {
    if (proto.abort === abort) proto.abort = originalAbort;
    if (proto.open === open) proto.open = originalOpen;
    if (proto.setRequestHeader === setRequestHeader) proto.setRequestHeader = originalSetRequestHeader;
    if (proto.send === send) proto.send = originalSend;
  };
}

function readXhrBody(xhr: XMLHttpRequest, maxBytes: number, draft: NetworkDraft): CapturedBody {
  const contentType = draft.responseHeaders.find((h) => h.name === 'content-type')?.value;
  const type = xhr.responseType;
  const asText = (text: string, kindHint?: CapturedBody['kind']): CapturedBody => {
    const size = utf8Length(text);
    const t = truncateText(text, maxBytes);
    const kind = kindHint ?? (contentType && /json/i.test(contentType) ? 'json' : 'text');
    return { kind, text: t.text, size, truncated: t.truncated || undefined, contentType };
  };
  try {
    if (type === '' || type === 'text') return asText(xhr.responseText ?? '');
    if (type === 'json') {
      if (xhr.response === null)
        return { kind: 'unreadable', contentType, note: 'Response was not valid JSON' };
      return asText(JSON.stringify(xhr.response), 'json');
    }
    if (type === 'arraybuffer') {
      const buf = xhr.response as ArrayBuffer | null;
      return { kind: 'binary', size: buf?.byteLength, contentType, note: 'Binary body not stored' };
    }
    if (type === 'blob') {
      const blob = xhr.response as Blob | null;
      return { kind: 'binary', size: blob?.size, contentType, note: 'Blob body not stored' };
    }
    return { kind: 'unreadable', contentType, note: `responseType "${type}" is not captured` };
  } catch (err) {
    return { kind: 'unreadable', contentType, note: `Could not read response: ${String(err)}` };
  }
}
