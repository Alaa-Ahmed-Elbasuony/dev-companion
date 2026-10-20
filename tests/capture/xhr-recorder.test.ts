import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installXhrRecorder } from '../../src/capture/xhr-recorder';
import { FakeXHR } from '../helpers/fake-xhr';
import { makeContext, waitFor } from '../helpers/recorder';

let uninstall: () => void;
let t: ReturnType<typeof makeContext>;

beforeEach(() => {
  FakeXHR.instances = [];
  t = makeContext();
  uninstall = installXhrRecorder({ XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest }, t.ctx);
});
afterEach(() => uninstall());

const newXhr = () => new FakeXHR() as unknown as XMLHttpRequest;

describe('XHR recorder', () => {
  it('captures a JSON POST and its response', async () => {
    FakeXHR.handler = () => ({
      status: 201,
      statusText: 'Created',
      body: '{"id":"o-1"}',
      headers: 'Content-Type: application/json\r\nX-Request-Id: abc\r\n',
    });
    const xhr = newXhr();
    let loaded = false;
    xhr.addEventListener('load', () => (loaded = true));
    xhr.open('POST', '/api/orders');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ productId: '123' }));
    await waitFor(() => t.ends().length === 1);
    expect(loaded).toBe(true);
    expect(xhr.responseText).toBe('{"id":"o-1"}');
    expect(t.starts()[0]!.state).toBe('pending');
    expect(t.ends()[0]).toMatchObject({
      source: 'xhr',
      method: 'POST',
      url: 'https://app.test/api/orders',
      state: 'complete',
      status: 201,
      statusText: 'Created',
    });
    expect(t.ends()[0]!.requestBody).toMatchObject({ kind: 'json', text: '{"productId":"123"}' });
    expect(t.ends()[0]!.responseBody).toMatchObject({ kind: 'json', text: '{"id":"o-1"}' });
    expect(t.ends()[0]!.responseHeaders).toContainEqual({ name: 'x-request-id', value: 'abc' });
    expect(t.ends()[0]!.requestHeaders).toContainEqual({ name: 'content-type', value: 'application/json' });
  });

  it('records HTTP errors as complete', async () => {
    FakeXHR.handler = () => ({ status: 500, body: 'boom', headers: 'content-type: text/plain' });
    const xhr = newXhr();
    xhr.open('GET', '/api/fail');
    xhr.send();
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]).toMatchObject({ state: 'complete', status: 500 });
    expect(t.ends()[0]!.responseBody?.text).toBe('boom');
  });

  it('records network errors, timeouts and aborts', async () => {
    FakeXHR.handler = (req) =>
      req.url.includes('err') ? 'error' : req.url.includes('timeout') ? 'timeout' : 'hang';
    const a = newXhr();
    a.open('GET', '/err');
    a.send();
    const b = newXhr();
    b.open('GET', '/timeout');
    b.send();
    const c = newXhr();
    c.open('GET', '/hang');
    c.send();
    c.abort();
    await waitFor(() => t.ends().length === 3);
    const byUrl = Object.fromEntries(t.ends().map((d) => [new URL(d.url).pathname, d.state]));
    expect(byUrl).toEqual({ '/err': 'error', '/timeout': 'timeout', '/hang': 'aborted' });
  });

  it('handles responseType json and arraybuffer', async () => {
    FakeXHR.handler = () => ({ status: 200, body: '{"a":1}', headers: 'content-type: application/json' });
    const a = newXhr();
    a.responseType = 'json';
    a.open('GET', '/json');
    a.send();
    const b = newXhr();
    b.responseType = 'arraybuffer';
    b.open('GET', '/bin');
    b.send();
    await waitFor(() => t.ends().length === 2);
    const [ja, jb] = t.ends();
    expect(ja!.responseBody).toMatchObject({ kind: 'json', text: '{"a":1}' });
    expect(jb!.responseBody).toMatchObject({ kind: 'binary', size: 7 });
  });

  it('rethrows synchronous send() errors and records them', async () => {
    const xhr = newXhr();
    xhr.open('GET', '/x');
    // Make the next send throw by resetting readyState.
    (xhr as unknown as FakeXHR).readyState = 0;
    expect(() => xhr.send()).toThrow(/Not opened/);
    await waitFor(() => t.ends().length === 1);
    expect(t.ends()[0]!.state).toBe('error');
  });

  it('records each send when an XHR object is reused', async () => {
    FakeXHR.handler = () => ({ status: 200, body: 'ok' });
    const xhr = newXhr();
    xhr.open('GET', '/one');
    xhr.send();
    await waitFor(() => t.ends().length === 1);
    xhr.open('GET', '/two');
    xhr.send();
    await waitFor(() => t.ends().length === 2);
    expect(t.ends().map((d) => new URL(d.url).pathname)).toEqual(['/one', '/two']);
    expect(new Set(t.ends().map((d) => d.id)).size).toBe(2);
  });

  it('restores the prototype on uninstall', () => {
    uninstall();
    const xhr = newXhr();
    xhr.open('GET', '/x');
    expect(Object.prototype.hasOwnProperty.call(FakeXHR.prototype, 'open')).toBe(true);
    expect(FakeXHR.prototype.open.name).toBe('open');
    uninstall = () => undefined;
  });
});
