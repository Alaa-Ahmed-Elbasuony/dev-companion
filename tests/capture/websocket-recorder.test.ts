import { afterEach, describe, expect, it } from 'vitest';
import {
  LATE_SOCKET_WARNING,
  RECORDING_STARTED_LATE_WARNING,
  installWebSocketRecorder,
} from '../../src/capture/websocket-recorder';
import type { PageMessage } from '../../src/shared/messages';
import type { RealtimeConnectionDraft, RealtimeMessageDraft } from '../../src/shared/types';
import { FakeWebSocket } from '../helpers/fake-realtime';
import { makeContext } from '../helpers/recorder';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function setup(config = {}) {
  const host = { WebSocket: FakeWebSocket as unknown as typeof WebSocket };
  const rec = makeContext(config);
  const uninstall = installWebSocketRecorder(host, rec.ctx);
  cleanups.push(uninstall);
  const WS = host.WebSocket as unknown as typeof FakeWebSocket;
  const connections = () =>
    rec.messages
      .filter((m): m is Extract<PageMessage, { type: 'rt-connection' }> => m.type === 'rt-connection')
      .map((m) => m.connection as RealtimeConnectionDraft);
  const frames = () =>
    rec.messages
      .filter((m): m is Extract<PageMessage, { type: 'rt-message' }> => m.type === 'rt-message')
      .map((m) => m.message as RealtimeMessageDraft);
  return { host, rec, WS, uninstall, connections, frames };
}

describe('WebSocket recorder', () => {
  it('preserves constructor identity, statics, instanceof and subclassing', () => {
    const { WS } = setup();
    expect(WS).not.toBe(FakeWebSocket);
    expect(WS.OPEN).toBe(1);
    expect(WS.prototype).toBe(FakeWebSocket.prototype);
    const ws = new WS('wss://app.test/ws');
    expect(ws).toBeInstanceOf(FakeWebSocket);
    expect(ws).toBeInstanceOf(WS);
    class AppSocket extends WS {
      hello() {
        return 'hi';
      }
    }
    const sub = new AppSocket('wss://app.test/sub');
    expect(sub.hello()).toBe('hi');
    expect(sub).toBeInstanceOf(FakeWebSocket);
  });

  it('records lifecycle, incoming and outgoing text frames with sizes', () => {
    const { WS, connections, frames } = setup();
    const ws = new WS('wss://app.test/ws', ['v1.json']);
    ws.serverOpen('v1.json');
    ws.send('{"type":"subscribe","topic":"orders"}');
    ws.serverMessage('{"type":"order.created","id":1}');
    ws.serverClose(1000, 'bye');

    const last = connections().at(-1)!;
    expect(last).toMatchObject({
      transport: 'websocket',
      url: 'wss://app.test/ws',
      state: 'closed',
      requestedProtocols: ['v1.json'],
      selectedProtocol: 'v1.json',
      closeCode: 1000,
      closeReason: 'bye',
      wasClean: true,
    });
    const f = frames();
    expect(f.map((m) => m.lifecycle ?? `${m.direction}:${m.opcode}`)).toEqual([
      'connecting',
      'open',
      'out:text',
      'in:text',
      'close',
    ]);
    expect(f[2]).toMatchObject({ text: '{"type":"subscribe","topic":"orders"}', size: 37 });
    expect(f[3]!.connectionId).toBe(last.id);
  });

  it('records binary frames as metadata only', () => {
    const { WS, frames } = setup();
    const ws = new WS('wss://app.test/ws');
    ws.serverOpen();
    ws.send(new Uint8Array([1, 2, 3, 4]));
    ws.serverMessage(new ArrayBuffer(10));
    ws.serverMessage(new Blob(['abcdef']));
    const bin = frames().filter((m) => m.opcode === 'binary');
    expect(bin.map((m) => [m.direction, m.binaryType, m.size])).toEqual([
      ['out', 'typedarray', 4],
      ['in', 'arraybuffer', 10],
      ['in', 'blob', 6],
    ]);
    expect(bin.every((m) => m.text === undefined)).toBe(true);
  });

  it('rethrows send() errors unchanged and records nothing for the failed send', () => {
    const { WS, frames } = setup();
    const ws = new WS('wss://app.test/ws');
    expect(() => ws.send('too early')).toThrow(/CONNECTING/);
    expect(frames().filter((m) => m.direction === 'out')).toHaveLength(0);
  });

  it('truncates large frames but keeps the full size', () => {
    const { WS, frames } = setup({ maxFrameBytes: 16 });
    const ws = new WS('wss://app.test/ws');
    ws.serverOpen();
    ws.serverMessage('x'.repeat(100));
    const f = frames().find((m) => m.direction === 'in')!;
    expect(f.text).toHaveLength(16);
    expect(f.size).toBe(100);
    expect(f.truncated).toBe(true);
  });

  it('marks a connection that closed before opening as failed (abnormal 1006)', () => {
    const { WS, connections, frames } = setup();
    const ws = new WS('wss://app.test/down');
    ws.serverError();
    ws.serverClose(1006, '', false);
    expect(connections().at(-1)).toMatchObject({ state: 'failed', closeCode: 1006, wasClean: false });
    expect(frames().map((m) => m.lifecycle)).toEqual(['connecting', 'error', 'close']);
  });

  it('does not change what the page receives or the order of its handlers', () => {
    const { WS } = setup();
    const ws = new WS('wss://app.test/ws');
    const seen: string[] = [];
    ws.onmessage = (e) => seen.push(`on:${e.data}`);
    ws.addEventListener('message', (e) => seen.push(`l1:${(e as MessageEvent).data}`));
    ws.addEventListener('message', (e) => seen.push(`l2:${(e as MessageEvent).data}`));
    ws.serverOpen();
    ws.serverMessage('a');
    expect(seen).toEqual(['on:a', 'l1:a', 'l2:a']);
    ws.send('b');
    expect(ws.sent).toEqual(['b']);
  });

  it('emits nothing while disabled, and flags connections opened before recording started', () => {
    const { WS, rec, connections, frames } = setup({ enabled: false });
    const ws = new WS('wss://app.test/ws');
    ws.serverOpen();
    ws.serverMessage('ignored');
    expect(rec.messages).toHaveLength(0);
    rec.setConfig({ enabled: true });
    ws.serverMessage('seen');
    expect(frames().map((m) => m.text)).toEqual(['seen']);
    expect(connections()[0]!.warnings).toContain(RECORDING_STARTED_LATE_WARNING);
  });

  it('respects the captureRealtime toggle', () => {
    const { WS, rec } = setup({ captureRealtime: false });
    const ws = new WS('wss://app.test/ws');
    ws.serverOpen();
    ws.serverMessage('x');
    expect(rec.messages).toHaveLength(0);
  });

  it('picks up sockets created before installation on their first send()', () => {
    const early = new FakeWebSocket('wss://app.test/early');
    early.serverOpen();
    const { connections, frames } = setup();
    early.send('ping');
    expect(connections()[0]).toMatchObject({ url: 'wss://app.test/early', state: 'open' });
    expect(connections()[0]!.warnings).toContain(LATE_SOCKET_WARNING);
    early.serverMessage('pong');
    expect(frames().map((m) => `${m.direction}:${m.text}`)).toEqual(['out:ping', 'in:pong']);
  });

  it('records client-initiated close() calls', () => {
    const { WS, frames } = setup();
    const ws = new WS('wss://app.test/ws');
    ws.serverOpen();
    ws.close(4000, 'logout');
    expect(frames().at(-1)).toMatchObject({ lifecycle: 'close', note: expect.stringContaining('4000') });
  });

  it('uninstall restores the original constructor and prototype methods', () => {
    const originalSend = FakeWebSocket.prototype.send;
    const { host, uninstall } = setup();
    expect(FakeWebSocket.prototype.send).not.toBe(originalSend);
    uninstall();
    expect(host.WebSocket).toBe(FakeWebSocket);
    expect(FakeWebSocket.prototype.send).toBe(originalSend);
  });
});
