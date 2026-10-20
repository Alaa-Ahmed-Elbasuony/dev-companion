// Engine.IO (v3/v4) and Socket.IO (v2–v4 wire format) decoding. Works on the
// frames and polling bodies observed on the wire; no client library needed.
import type { DecodedPacket } from '../../shared/types';
import { safeUrl } from '../../shared/util';

const EIO_TYPES = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'] as const;
const SIO_TYPES = [
  'CONNECT',
  'DISCONNECT',
  'EVENT',
  'ACK',
  'CONNECT_ERROR',
  'BINARY_EVENT',
  'BINARY_ACK',
] as const;

export interface SocketIoUrlInfo {
  eio: 3 | 4 | number;
  transport: 'polling' | 'websocket' | string;
  sid?: string;
}

/** Recognizes Engine.IO endpoints by their mandatory EIO query parameter. */
export function parseSocketIoUrl(url: string): SocketIoUrlInfo | null {
  const u = safeUrl(url);
  if (!u) return null;
  const eio = u.searchParams.get('EIO');
  const transport = u.searchParams.get('transport');
  if (!eio || !/^\d$/.test(eio) || !transport) return null;
  return { eio: Number(eio), transport, sid: u.searchParams.get('sid') ?? undefined };
}

export class DecodeError extends Error {}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DecodeError(`${what}: payload is not valid JSON`);
  }
}

/** Decodes one Socket.IO packet (the payload of an Engine.IO "message"). */
export function decodeSocketIoPacket(text: string): DecodedPacket {
  const typeCode = Number(text[0]);
  const kind = SIO_TYPES[typeCode];
  if (!kind) throw new DecodeError(`Unknown Socket.IO packet type "${text[0] ?? ''}"`);
  let i = 1;
  let attachments: number | undefined;
  if (kind === 'BINARY_EVENT' || kind === 'BINARY_ACK') {
    const dash = text.indexOf('-', i);
    if (dash < 0) throw new DecodeError('Binary packet without attachment count');
    attachments = Number(text.slice(i, dash));
    i = dash + 1;
  }
  let namespace = '/';
  if (text[i] === '/') {
    const comma = text.indexOf(',', i);
    // A namespace with no payload ends the packet ("1/admin,").
    const end = comma < 0 ? text.length : comma;
    namespace = text.slice(i, end);
    i = comma < 0 ? end : end + 1;
  }
  let ackId: number | undefined;
  const digits = /^\d+/.exec(text.slice(i));
  if (digits) {
    ackId = Number(digits[0]);
    i += digits[0].length;
  }
  const rest = text.slice(i);
  const payload = rest ? parseJson(rest, `Socket.IO ${kind}`) : undefined;
  const packet: DecodedPacket = { protocol: 'socket.io', category: 'protocol', kind, namespace };
  if (ackId !== undefined) packet.ackId = ackId;
  if (attachments !== undefined) packet.attachments = attachments;

  if (kind === 'EVENT' || kind === 'BINARY_EVENT') {
    if (!Array.isArray(payload) || typeof payload[0] !== 'string') {
      throw new DecodeError('Socket.IO EVENT payload must be an array starting with the event name');
    }
    packet.category = 'app';
    packet.name = payload[0];
    packet.args = payload.slice(1);
  } else if (kind === 'ACK' || kind === 'BINARY_ACK') {
    packet.category = 'app';
    packet.args = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload];
  } else if (kind === 'CONNECT_ERROR') {
    const p = payload as { message?: unknown } | string | undefined;
    packet.error =
      typeof p === 'string' ? p : typeof p?.message === 'string' ? p.message : 'Connection refused';
    packet.result = payload;
  } else if (payload !== undefined) {
    packet.result = payload;
  }
  return packet;
}

/** Decodes one Engine.IO packet (a WebSocket text frame or one polling record). */
export function decodeEngineIoPacket(text: string, eio: number): DecodedPacket {
  if (text.startsWith('b')) {
    return {
      protocol: 'socket.io',
      category: 'app',
      kind: 'binary attachment (base64)',
      attachments: 1,
    };
  }
  const typeCode = Number(text[0]);
  const type = EIO_TYPES[typeCode];
  if (!type) throw new DecodeError(`Unknown Engine.IO packet type "${text[0] ?? ''}"`);
  const data = text.slice(1);
  if (type === 'message') return decodeSocketIoPacket(data);
  if (type === 'ping' || type === 'pong') {
    if (data === 'probe')
      return { protocol: 'socket.io', category: 'protocol', kind: `${type} probe (upgrade)` };
    // v4: server pings, client pongs. v3: client pings, server pongs. Both are keep-alives.
    const initiator =
      eio >= 4 ? (type === 'ping' ? 'server' : 'client') : type === 'ping' ? 'client' : 'server';
    return { protocol: 'socket.io', category: 'heartbeat', kind: type, result: `${initiator}-initiated` };
  }
  const packet: DecodedPacket = { protocol: 'socket.io', category: 'protocol', kind: `engine.io ${type}` };
  if (type === 'open' && data) packet.result = parseJson(data, 'Engine.IO open');
  return packet;
}

/** Splits a polling body into Engine.IO packets (v4: record separator; v3: length-prefixed). */
export function splitPollingPayload(body: string, eio: number): string[] {
  if (!body) return [];
  if (eio >= 4) return body.split('\x1e').filter((p) => p !== '');
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const colon = body.indexOf(':', i);
    if (colon < 0) throw new DecodeError('Engine.IO v3 polling payload: missing length prefix');
    const len = Number(body.slice(i, colon));
    if (!Number.isInteger(len) || len < 0) throw new DecodeError('Engine.IO v3 polling payload: bad length');
    out.push(body.slice(colon + 1, colon + 1 + len));
    i = colon + 1 + len;
  }
  return out;
}

export function sidFromOpenPacket(packets: DecodedPacket[]): string | undefined {
  for (const p of packets) {
    const r = p.result as { sid?: unknown } | undefined;
    if (p.kind === 'engine.io open' && typeof r?.sid === 'string') return r.sid;
  }
  return undefined;
}
