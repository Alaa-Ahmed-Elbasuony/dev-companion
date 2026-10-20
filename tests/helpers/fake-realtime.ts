// Minimal WebSocket / EventSource stand-ins that behave like the browser classes
// for everything the recorders touch.

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  protocol = '';
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  readonly sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
  }

  send(data: unknown) {
    if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 2;
    void code;
    void reason;
  }

  // Test drivers (what the network would do).
  serverOpen(protocol = '') {
    this.readyState = 1;
    this.protocol = protocol;
    this.dispatchEvent(new Event('open'));
  }
  serverMessage(data: unknown) {
    const e = new MessageEvent('message', { data });
    this.onmessage?.(e);
    this.dispatchEvent(e);
  }
  serverClose(code: number, reason = '', wasClean = true) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean }));
  }
  serverError() {
    this.dispatchEvent(new Event('error'));
  }
}

export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  readonly withCredentials: boolean;

  constructor(
    readonly url: string,
    init?: { withCredentials?: boolean },
  ) {
    super();
    this.withCredentials = !!init?.withCredentials;
  }

  close() {
    this.readyState = 2;
  }

  serverOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  serverEvent(type: string, data: string, lastEventId = '') {
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId }));
  }
  serverDrop(retrying: boolean) {
    this.readyState = retrying ? 0 : 2;
    this.dispatchEvent(new Event('error'));
  }
}
