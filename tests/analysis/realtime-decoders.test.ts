import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  dedupKey,
  detectProtocol,
  endpointOf,
  refineProtocol,
} from '../../src/analysis/realtime/decode';
import {
  decodeSignalRText,
  looksLikeSignalR,
  parseNegotiateResponse,
} from '../../src/analysis/realtime/signalr';
import {
  decodeEngineIoPacket,
  parseSocketIoUrl,
  sidFromOpenPacket,
  splitPollingPayload,
} from '../../src/analysis/realtime/socketio';
import { SseParser } from '../../src/analysis/realtime/sse';
import type { RealtimeMessageDraft } from '../../src/shared/types';

const text = (t: string, extra: Partial<RealtimeMessageDraft> = {}): RealtimeMessageDraft => ({
  id: 'm',
  connectionId: 'c',
  direction: 'in',
  timestamp: 1,
  opcode: 'text',
  text: t,
  source: 'main-world',
  ...extra,
});

describe('Engine.IO / Socket.IO', () => {
  it('recognizes Engine.IO URLs (any path) by the EIO parameter', () => {
    expect(parseSocketIoUrl('ws://h/socket.io/?EIO=4&transport=websocket&sid=abc')).toEqual({
      eio: 4,
      transport: 'websocket',
      sid: 'abc',
    });
    expect(parseSocketIoUrl('http://h/custom/?EIO=3&transport=polling&t=x')).toMatchObject({ eio: 3 });
    expect(parseSocketIoUrl('ws://h/ws')).toBeNull();
  });

  it('decodes events, namespaces, acks and errors', () => {
    expect(decodeEngineIoPacket('42["order.created",{"id":7}]', 4)).toMatchObject({
      category: 'app',
      kind: 'EVENT',
      name: 'order.created',
      args: [{ id: 7 }],
      namespace: '/',
    });
    expect(decodeEngineIoPacket('42/admin,13["ping",1]', 4)).toMatchObject({
      name: 'ping',
      namespace: '/admin',
      ackId: 13,
    });
    expect(decodeEngineIoPacket('4313[{"ok":true}]', 4)).toMatchObject({
      kind: 'ACK',
      ackId: 13,
      args: [{ ok: true }],
    });
    expect(decodeEngineIoPacket('44/admin,{"message":"not authorized"}', 4)).toMatchObject({
      kind: 'CONNECT_ERROR',
      error: 'not authorized',
      category: 'protocol',
    });
    expect(decodeEngineIoPacket('40/admin,{"sid":"x"}', 4)).toMatchObject({
      kind: 'CONNECT',
      namespace: '/admin',
    });
    expect(decodeEngineIoPacket('41/admin,', 4)).toMatchObject({ kind: 'DISCONNECT', namespace: '/admin' });
    expect(decodeEngineIoPacket('451-["upload",{"_placeholder":true,"num":0}]', 4)).toMatchObject({
      kind: 'BINARY_EVENT',
      attachments: 1,
      name: 'upload',
    });
  });

  it('classifies heartbeats and upgrade probes separately from app events', () => {
    expect(decodeEngineIoPacket('2', 4)).toMatchObject({
      category: 'heartbeat',
      kind: 'ping',
      result: 'server-initiated',
    });
    expect(decodeEngineIoPacket('3', 4)).toMatchObject({ category: 'heartbeat', kind: 'pong' });
    expect(decodeEngineIoPacket('2', 3)).toMatchObject({ result: 'client-initiated' });
    expect(decodeEngineIoPacket('2probe', 4)).toMatchObject({
      category: 'protocol',
      kind: 'ping probe (upgrade)',
    });
    expect(decodeEngineIoPacket('5', 4)).toMatchObject({ kind: 'engine.io upgrade' });
    const open = decodeEngineIoPacket('0{"sid":"s1","upgrades":["websocket"],"pingInterval":25000}', 4);
    expect(sidFromOpenPacket([open])).toBe('s1');
  });

  it('splits polling payloads for v4 (record separator) and v3 (length prefix)', () => {
    expect(splitPollingPayload('40\x1e42["a"]\x1e2', 4)).toEqual(['40', '42["a"]', '2']);
    expect(splitPollingPayload('2:4011:42["hi",1]', 3)).toEqual(['40', '42["hi",1]']);
    expect(() => splitPollingPayload('xx', 3)).toThrow();
  });

  it('reports malformed packets as parse errors instead of throwing', () => {
    const r1 = decodeMessage(
      'socket.io',
      text('42["unterminated'),
      'ws://h/socket.io/?EIO=4&transport=websocket',
    );
    expect(r1.parseError).toMatch(/not valid JSON/);
    const r2 = decodeMessage('socket.io', text('9'), 'ws://h/socket.io/?EIO=4&transport=websocket');
    expect(r2.parseError).toMatch(/Unknown Engine.IO packet type/);
    const r3 = decodeMessage(
      'socket.io',
      text('42{"no":"array"}'),
      'ws://h/socket.io/?EIO=4&transport=websocket',
    );
    expect(r3.parseError).toMatch(/array/);
  });
});

describe('SignalR JSON Hub Protocol', () => {
  it('decodes handshake, invocations, completions and pings', () => {
    expect(looksLikeSignalR('{"protocol":"json","version":1}\x1e')).toBe(true);
    expect(looksLikeSignalR('{"type":1}')).toBe(false);
    const packets = decodeSignalRText(
      '{"type":1,"invocationId":"0","target":"PlaceOrder","arguments":[{"sku":"A"}]}\x1e{"type":6}\x1e',
    );
    expect(packets).toMatchObject([
      { kind: 'Invocation', category: 'app', name: 'PlaceOrder', invocationId: '0', args: [{ sku: 'A' }] },
      { kind: 'Ping', category: 'heartbeat' },
    ]);
    expect(decodeSignalRText('{"type":3,"invocationId":"0","result":{"orderId":9}}\x1e')[0]).toMatchObject({
      kind: 'Completion',
      result: { orderId: 9 },
    });
    expect(
      decodeSignalRText('{"type":3,"invocationId":"1","error":"Hub method failed"}\x1e')[0],
    ).toMatchObject({
      error: 'Hub method failed',
    });
    expect(decodeSignalRText('{}\x1e')[0]).toMatchObject({ kind: 'Handshake response' });
    expect(
      decodeSignalRText('{"type":7,"error":"Server shutdown","allowReconnect":true}\x1e')[0],
    ).toMatchObject({
      kind: 'Close',
      result: { allowReconnect: true },
    });
  });

  it('refuses to decode binary hub protocol frames', () => {
    const r = decodeMessage(
      'signalr',
      { ...text(''), opcode: 'binary', text: undefined, size: 20 },
      'wss://h/hub?id=x',
    );
    expect(r.decoded).toBeUndefined();
    expect(r.parseError).toBeUndefined();
    expect(r.decodeNote).toMatch(/not decoded/);
  });

  it('flags unknown message types and invocations without a target', () => {
    expect(decodeMessage('signalr', text('{"type":42}\x1e'), '').parseError).toMatch(/Unknown SignalR/);
    expect(decodeMessage('signalr', text('{"type":1,"arguments":[]}\x1e'), '').parseError).toMatch(
      /without target/,
    );
  });

  it('parses negotiate responses', () => {
    expect(
      parseNegotiateResponse(
        '{"connectionId":"abc","negotiateVersion":1,"availableTransports":[{"transport":"WebSockets"},{"transport":"LongPolling"}]}',
      ),
    ).toEqual({
      connectionId: 'abc',
      negotiateVersion: 1,
      transports: ['WebSockets', 'LongPolling'],
      redirectUrl: undefined,
      error: undefined,
    });
    expect(parseNegotiateResponse('{"products":[]}')).toBeNull();
  });

  it('upgrades a raw connection to SignalR once a hub-framed frame appears', () => {
    expect(refineProtocol('raw', text('{"protocol":"json","version":1}\x1e'))).toBe('signalr');
    expect(refineProtocol('sse', text('{"type":1,"target":"x","arguments":[]}\x1e'))).toBe('signalr');
    expect(refineProtocol('raw', text('{"type":"hello"}'))).toBe('raw');
  });
});

describe('plain JSON and SSE', () => {
  it('guesses an event name from conventional fields and labels it as a guess', () => {
    const r = decodeMessage('raw', text('{"type":"order.created","orderId":1}'), 'wss://h/ws');
    expect(r.decoded?.[0]).toMatchObject({
      name: 'order.created',
      nameSource: 'field "type"',
      category: 'app',
    });
    expect(decodeMessage('raw', text('hello world'), '').decoded).toBeUndefined();
    expect(decodeMessage('raw', text('{"broken":'), '').parseError).toMatch(/not valid JSON/);
  });

  it('uses the SSE event type as an authoritative name', () => {
    const r = decodeMessage('sse', text('{"id":1}', { sse: { type: 'order.created' } }), 'https://h/s');
    expect(r.decoded?.[0]).toMatchObject({ name: 'order.created', kind: 'event' });
    expect(r.decoded?.[0]?.nameSource).toBeUndefined();
  });

  it('does not decode truncated protocol frames', () => {
    const r = decodeMessage(
      'socket.io',
      text('42["x"', { truncated: true }),
      'ws://h/?EIO=4&transport=websocket',
    );
    expect(r.decodeNote).toMatch(/truncated/);
    expect(r.parseError).toBeUndefined();
    expect(decodeMessage('raw', text('{"a":', { truncated: true }), '').parseError).toBeUndefined();
  });

  it('parses event streams incrementally across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.push('retry: 1500\nid: 1\nevent: order.created\nda')).toEqual([]);
    expect(p.push('ta: {"a":1}\n\n: comment\ndata: line1\r\ndata: line2\r\n\r\n')).toEqual([
      { type: 'order.created', data: '{"a":1}', lastEventId: '1', retry: 1500 },
      { type: 'message', data: 'line1\nline2', lastEventId: '1', retry: undefined },
    ]);
  });
});

describe('protocol detection and dedup identity', () => {
  it('detects protocols from connections', () => {
    expect(
      detectProtocol({ url: 'wss://h/socket.io/?EIO=4&transport=websocket', transport: 'websocket' }),
    ).toBe('socket.io');
    expect(detectProtocol({ url: 'https://h/stream', transport: 'eventsource' })).toBe('sse');
    expect(detectProtocol({ url: 'wss://h/ws', transport: 'websocket' })).toBe('raw');
  });

  it('builds the same key for the same frame regardless of truncation beyond the hashed prefix', () => {
    const long = 'a'.repeat(5000);
    expect(dedupKey('c', 'in', 'text', 5000, long)).toBe(
      dedupKey('c', 'in', 'text', 5000, long.slice(0, 1024)),
    );
    expect(dedupKey('c', 'in', 'text', 5, 'hello')).not.toBe(dedupKey('c', 'out', 'text', 5, 'hello'));
    expect(dedupKey('c', 'in', 'binary', 8, undefined)).toBe(dedupKey('c', 'in', 'binary', 8, undefined));
  });

  it('strips per-connection parameters from endpoints', () => {
    expect(endpointOf('wss://h/socket.io/?EIO=4&transport=websocket&sid=abc')).toBe(
      'wss://h/socket.io/?EIO=4&transport=websocket',
    );
    expect(endpointOf('wss://h/hub?id=tok')).toBe('wss://h/hub');
  });
});
