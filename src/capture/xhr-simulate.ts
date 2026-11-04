// XMLHttpRequest simulation: the XHR side of simulate.ts. Rule decisions, holds,
// the startup gate and outcomes come from the shared engine; this module only
// turns an outcome into what an XHR shows the page.
//
// While a simulated request is held, the real send() has not been called, so the
// native object still reads OPENED (as a sent, waiting request does). Once a
// synthetic outcome is shown, own-property accessors on the instance shadow the
// prototype's readyState / status / response... and are removed by the next open().
// Events are dispatched on the instance, so on* handlers and listeners (including
// the recorder's own) see them like native ones. Delays end by calling the real
// send() with the page's arguments.
import { mockParts, resolveSimulation, waitForGate } from './simulate';
import type { MockAction, SimulationDecision, Simulator } from './simulate';

const UNSENT = 0;
const OPENED = 1;
const HEADERS_RECEIVED = 2;
const LOADING = 3;
const DONE = 4;

/** Ends every hold of a request; the caller has already decided what the page sees. */
const CANCELLED = Symbol('cancelled');

/** Response headers scripts can never read from an XHR. */
const FORBIDDEN_RESPONSE_HEADERS = ['set-cookie', 'set-cookie2'];

/** What the page reads from a simulated XHR once a synthetic outcome is shown. */
interface View {
  readyState: number;
  status: number;
  statusText: string;
  headers: Headers | null;
  body: string;
  url: string;
  /** Parsed `response` values, created once per view (native returns the same object). */
  cache: Map<string, unknown>;
}

interface SimRecord {
  /** holding: waiting for the gate or a hold; delivering: dispatching a mock; done: final state shown. */
  state: 'holding' | 'delivering' | 'done';
  controller: AbortController;
  /** Set by abort(), timeout or open(): an in-progress dispatch sequence must stop. */
  interrupted: boolean;
  loadstartFired: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface XhrSimulationOptions {
  sim: Simulator;
  /** The resolved request URL. */
  url: string;
  /** The rule to apply, or undefined while the startup gate decides. */
  decision?: SimulationDecision;
  gate?: Promise<void>;
  /** Decides once the gate opens. */
  decideLater: () => SimulationDecision | undefined;
  /** Calls the real send() with the page's arguments. */
  send: () => void;
  onDecision: (decision: SimulationDecision) => void;
  /** Simulation was switched off while the request was held; it is sent unchanged. */
  onReleased: (decision: SimulationDecision) => void;
  /** The startup gate gave up waiting; the request is sent unchanged. */
  onGateTimeout: () => void;
}

export interface XhrSimulations {
  start: (xhr: XMLHttpRequest, opts: XhrSimulationOptions) => void;
  /** A simulated request or its final state is showing: send() and setRequestHeader() must throw. */
  blocksSend: (xhr: XMLHttpRequest) => boolean;
  /** Handles abort() for simulated requests; false when the native abort() should run. */
  abort: (xhr: XMLHttpRequest) => boolean;
  /**
   * Call after the native open() succeeded: ends a simulated request silently (as
   * open() terminates a native one) and removes the synthetic state.
   */
  afterOpen: (xhr: XMLHttpRequest) => void;
}

export function invalidStateError(method: string): DOMException {
  return new DOMException(
    `Failed to execute '${method}' on 'XMLHttpRequest': The object's state must be OPENED.`,
    'InvalidStateError',
  );
}

function progressEvent(type: string, loaded: number, total: number): Event {
  if (typeof ProgressEvent === 'function') {
    return new ProgressEvent(type, { lengthComputable: total > 0, loaded, total });
  }
  const event = new Event(type);
  Object.defineProperties(event, {
    lengthComputable: { value: total > 0 },
    loaded: { value: loaded },
    total: { value: total },
  });
  return event;
}

function dispatch(xhr: XMLHttpRequest, event: Event) {
  try {
    xhr.dispatchEvent(event);
  } catch {
    /* listener errors are reported by the browser, never thrown here */
  }
}

/** The accessor a property resolves to on the prototype chain (the native one). */
function findAccessor(obj: object, name: string): PropertyDescriptor | undefined {
  for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d.get && d.set ? d : undefined;
  }
  return undefined;
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export function createXhrSimulations(): XhrSimulations {
  const records = new WeakMap<XMLHttpRequest, SimRecord>();
  const views = new WeakMap<XMLHttpRequest, View>();
  /** Undo functions for state left on the instance (accessors, the timeout shadow). */
  const restores = new WeakMap<XMLHttpRequest, (() => void)[]>();

  const addRestore = (xhr: XMLHttpRequest, fn: () => void) => {
    const list = restores.get(xhr) ?? [];
    list.push(fn);
    restores.set(xhr, list);
  };

  function show(xhr: XMLHttpRequest, view: Omit<View, 'cache'>): View {
    const full: View = { ...view, cache: new Map() };
    const installed = views.has(xhr);
    views.set(xhr, full);
    if (!installed) installAccessors(xhr);
    return full;
  }

  function installAccessors(xhr: XMLHttpRequest) {
    const current = () => views.get(xhr)!;
    const responseType = () => String(xhr.responseType ?? '');
    const getters: { [name: string]: () => unknown } = {
      readyState: () => current().readyState,
      status: () => current().status,
      statusText: () => current().statusText,
      responseURL: () => current().url,
      responseXML: () => null,
      responseText: () => {
        const type = responseType();
        if (type !== '' && type !== 'text') {
          throw new DOMException(
            `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${type}').`,
            'InvalidStateError',
          );
        }
        const v = current();
        return v.readyState >= LOADING ? v.body : '';
      },
      response: () => {
        const v = current();
        const type = responseType();
        if (type === '' || type === 'text') return v.readyState >= LOADING ? v.body : '';
        if (v.readyState !== DONE || v.status === 0) return null;
        if (v.cache.has(type)) return v.cache.get(type);
        let value: unknown = null;
        if (type === 'json') {
          try {
            value = v.body === '' ? null : JSON.parse(v.body);
          } catch {
            value = null;
          }
        } else if (type === 'arraybuffer') {
          value = new TextEncoder().encode(v.body).buffer;
        } else if (type === 'blob') {
          value = new Blob([v.body], { type: v.headers?.get('content-type') ?? '' });
        }
        v.cache.set(type, value);
        return value;
      },
    };
    const methods: { [name: string]: (...args: unknown[]) => unknown } = {
      getAllResponseHeaders: () => {
        const v = current();
        if (!v.headers || v.readyState < HEADERS_RECEIVED) return '';
        // Headers iterate lower-cased, sorted and combined, as XHR reports them.
        let out = '';
        v.headers.forEach((value, name) => (out = `${out}${name}: ${value}\r\n`));
        return out;
      },
      getResponseHeader: (name: unknown) => {
        const v = current();
        if (!v.headers || v.readyState < HEADERS_RECEIVED) return null;
        try {
          return v.headers.get(String(name));
        } catch {
          return null;
        }
      },
    };
    for (const [name, get] of Object.entries(getters)) {
      Object.defineProperty(xhr, name, { configurable: true, enumerable: true, get });
    }
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(xhr, name, { configurable: true, writable: true, value });
    }
    addRestore(xhr, () => {
      for (const name of [...Object.keys(getters), ...Object.keys(methods)]) {
        delete (xhr as unknown as { [k: string]: unknown })[name];
      }
      views.delete(xhr);
    });
  }

  function fireLoadstart(xhr: XMLHttpRequest, rec: SimRecord) {
    if (rec.loadstartFired) return;
    rec.loadstartFired = true;
    dispatch(xhr, progressEvent('loadstart', 0, 0));
  }

  function stopHolds(rec: SimRecord) {
    if (rec.timer !== undefined) clearTimeout(rec.timer);
    rec.timer = undefined;
    rec.controller.abort(CANCELLED);
  }

  /** Request error steps: error, timeout or abort, with the native event order. */
  function terminal(xhr: XMLHttpRequest, rec: SimRecord, type: 'error' | 'timeout' | 'abort') {
    if (rec.state === 'done') return;
    rec.state = 'done';
    rec.interrupted = true;
    stopHolds(rec);
    fireLoadstart(xhr, rec);
    const view = show(xhr, { readyState: DONE, status: 0, statusText: '', headers: null, body: '', url: '' });
    dispatch(xhr, new Event('readystatechange'));
    dispatch(xhr, progressEvent(type, 0, 0));
    dispatch(xhr, progressEvent('loadend', 0, 0));
    // abort() leaves the object UNSENT, without another event.
    if (type === 'abort') view.readyState = UNSENT;
  }

  /** Delivers a mocked response: HEADERS_RECEIVED, LOADING, progress, DONE, load, loadend. */
  function deliver(xhr: XMLHttpRequest, rec: SimRecord, action: MockAction, url: string) {
    rec.state = 'delivering';
    stopHolds(rec);
    const parts = mockParts(action);
    for (const name of FORBIDDEN_RESPONSE_HEADERS) parts.headers.delete(name);
    const body = parts.body ?? '';
    const size = new TextEncoder().encode(body).length;
    const steps: (() => void)[] = [
      () => fireLoadstart(xhr, rec),
      () => {
        show(xhr, {
          readyState: HEADERS_RECEIVED,
          status: action.status,
          statusText: action.statusText ?? '',
          headers: parts.headers,
          body,
          url: stripHash(url),
        });
        dispatch(xhr, new Event('readystatechange'));
      },
    ];
    if (body !== '') {
      steps.push(() => {
        views.get(xhr)!.readyState = LOADING;
        dispatch(xhr, new Event('readystatechange'));
      });
    }
    steps.push(
      () => dispatch(xhr, progressEvent('progress', size, size)),
      () => {
        views.get(xhr)!.readyState = DONE;
        rec.state = 'done';
        dispatch(xhr, new Event('readystatechange'));
      },
      () => dispatch(xhr, progressEvent('load', size, size)),
      () => dispatch(xhr, progressEvent('loadend', size, size)),
    );
    for (const step of steps) {
      // A handler may call abort() or open() mid-sequence: stop like the native object.
      if (rec.interrupted) return;
      step();
    }
  }

  /**
   * Sends the real request after a hold. The page's timeout counts from its send()
   * call, so the native timer gets only the time that is left; the page keeps
   * reading (and writing) the value it set.
   */
  function sendNow(xhr: XMLHttpRequest, startedAt: number, send: () => void) {
    const accessor = findAccessor(xhr, 'timeout');
    const elapsed = Date.now() - startedAt;
    let pageTimeout = Number(xhr.timeout) || 0;
    if (accessor && pageTimeout > 0 && elapsed > 0) {
      const apply = (v: number) => accessor.set!.call(xhr, v > 0 ? Math.max(1, v - elapsed) : 0);
      apply(pageTimeout);
      Object.defineProperty(xhr, 'timeout', {
        configurable: true,
        enumerable: true,
        get: () => pageTimeout,
        set: (v: unknown) => {
          pageTimeout = Number(v) || 0;
          apply(pageTimeout);
        },
      });
      addRestore(xhr, () => {
        delete (xhr as unknown as { timeout?: number }).timeout;
        accessor.set!.call(xhr, pageTimeout);
      });
    }
    send();
  }

  return {
    start(xhr, opts) {
      const rec: SimRecord = {
        state: 'holding',
        controller: new AbortController(),
        interrupted: false,
        loadstartFired: false,
      };
      records.set(xhr, rec);
      const startedAt = Date.now();
      // The page's timeout runs from send(), through every hold.
      const timeout = Number(xhr.timeout) || 0;
      if (timeout > 0) rec.timer = setTimeout(() => terminal(xhr, rec, 'timeout'), timeout);

      const passThrough = () => {
        stopHolds(rec);
        records.delete(xhr);
        try {
          sendNow(xhr, startedAt, opts.send);
        } catch {
          // The real send() refused (e.g. the page changed the object meanwhile).
          records.set(xhr, rec);
          rec.state = 'holding';
          terminal(xhr, rec, 'error');
        }
      };

      void (async () => {
        let decision = opts.decision;
        if (!decision) {
          await waitForGate(opts.gate ?? Promise.resolve(), rec.controller.signal);
          decision = opts.decideLater();
          if (!decision) {
            if (opts.sim.gateTimedOut()) opts.onGateTimeout();
            passThrough();
            return;
          }
          opts.onDecision(decision);
        }
        const outcome = await resolveSimulation(opts.sim, decision, rec.controller.signal);
        if (rec.state !== 'holding') return;
        if (outcome.kind === 'send') {
          if (outcome.released) opts.onReleased(decision);
          passThrough();
        } else if (outcome.kind === 'mock') {
          deliver(xhr, rec, outcome.action, opts.url);
        } else {
          terminal(xhr, rec, outcome.kind === 'timeout' ? 'timeout' : 'error');
        }
      })().catch((reason: unknown) => {
        // CANCELLED: abort(), timeout or open() already decided what the page sees.
        if (reason !== CANCELLED && rec.state === 'holding') terminal(xhr, rec, 'error');
      });
    },

    blocksSend: (xhr) => records.has(xhr),

    abort(xhr) {
      const rec = records.get(xhr);
      if (!rec) return false;
      if (rec.state !== 'done') {
        terminal(xhr, rec, 'abort');
        return true;
      }
      // abort() on a DONE object: UNSENT, response dropped, no events.
      const view = views.get(xhr);
      if (view && view.readyState === DONE) {
        Object.assign(view, { readyState: UNSENT, status: 0, statusText: '', headers: null, body: '' });
        view.cache.clear();
      }
      return true;
    },

    afterOpen(xhr) {
      const rec = records.get(xhr);
      const view = views.get(xhr);
      if (rec) {
        rec.interrupted = true;
        rec.state = 'done';
        stopHolds(rec);
        records.delete(xhr);
      }
      for (const restore of restores.get(xhr) ?? []) restore();
      restores.delete(xhr);
      // The native object never left OPENED, so its open() fired nothing; a real one
      // fires readystatechange when it was not OPENED (after a response or abort()).
      if (view && view.readyState !== OPENED) dispatch(xhr, new Event('readystatechange'));
    },
  };
}
