// Minimal XMLHttpRequest stand-in with the parts of the API the recorder uses.

export interface FakeXhrRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeXhrOutcome =
  | { status: number; statusText?: string; body?: string; headers?: string; responseURL?: string }
  | 'error'
  | 'timeout'
  | 'hang';

export class FakeXHR extends EventTarget {
  static handler: (req: FakeXhrRequest) => FakeXhrOutcome = () => ({ status: 200, body: '' });
  static instances: FakeXHR[] = [];

  readyState = 0;
  status = 0;
  statusText = '';
  responseType: XMLHttpRequestResponseType = '';
  response: unknown = null;
  responseText = '';
  responseURL = '';
  timeout = 0;
  request: FakeXhrRequest = { method: '', url: '', headers: {}, body: undefined };
  private responseHeaders = '';
  private done = false;

  constructor() {
    super();
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.request = { method, url, headers: {}, body: undefined };
    this.readyState = 1;
    this.done = false;
  }

  setRequestHeader(name: string, value: string) {
    if (this.readyState !== 1) throw new DOMException('Not opened', 'InvalidStateError');
    this.request.headers[name] = value;
  }

  send(body?: unknown) {
    if (this.readyState !== 1) throw new DOMException('Not opened', 'InvalidStateError');
    this.request.body = body;
    const outcome = FakeXHR.handler(this.request);
    if (outcome === 'hang') return;
    setTimeout(() => this.finish(outcome), 1);
  }

  abort() {
    if (this.done) return;
    this.done = true;
    this.readyState = 4;
    this.status = 0;
    this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }

  getAllResponseHeaders() {
    return this.responseHeaders;
  }

  private finish(outcome: Exclude<FakeXhrOutcome, 'hang'>) {
    if (this.done) return;
    this.done = true;
    this.readyState = 4;
    if (outcome === 'error' || outcome === 'timeout') {
      this.status = 0;
      this.dispatchEvent(new Event(outcome));
      this.dispatchEvent(new Event('loadend'));
      return;
    }
    this.status = outcome.status;
    this.statusText = outcome.statusText ?? '';
    this.responseHeaders = outcome.headers ?? '';
    this.responseURL = outcome.responseURL ?? this.request.url;
    const body = outcome.body ?? '';
    if (this.responseType === '' || this.responseType === 'text') {
      this.responseText = body;
      this.response = body;
    } else if (this.responseType === 'json') {
      try {
        this.response = JSON.parse(body);
      } catch {
        this.response = null;
      }
    } else if (this.responseType === 'arraybuffer') {
      this.response = new TextEncoder().encode(body).buffer;
    }
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
}
