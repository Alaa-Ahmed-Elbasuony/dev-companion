// Microsoft SignalR JSON Hub Protocol decoding. Binary protocols (MessagePack)
// are recognized but never decoded.
import type { DecodedPacket } from '../../shared/types';
import { safeUrl } from '../../shared/util';
import { DecodeError } from './socketio';

export const RECORD_SEPARATOR = '\x1e';

const TYPES: Record<number, { kind: string; category: DecodedPacket['category'] }> = {
  1: { kind: 'Invocation', category: 'app' },
  2: { kind: 'StreamItem', category: 'app' },
  3: { kind: 'Completion', category: 'app' },
  4: { kind: 'StreamInvocation', category: 'app' },
  5: { kind: 'CancelInvocation', category: 'app' },
  6: { kind: 'Ping', category: 'heartbeat' },
  7: { kind: 'Close', category: 'protocol' },
  8: { kind: 'Ack', category: 'protocol' },
  9: { kind: 'Sequence', category: 'protocol' },
};

/**
 * True when text is a sequence of JSON records each terminated by the record
 * separator, which is how every JSON Hub Protocol frame is framed.
 */
export function looksLikeSignalR(text: string | undefined): boolean {
  if (!text || !text.endsWith(RECORD_SEPARATOR)) return false;
  const first = text.slice(0, text.indexOf(RECORD_SEPARATOR)).trim();
  return first.startsWith('{');
}

export function isNegotiateUrl(url: string): boolean {
  return /\/negotiate$/i.test(safeUrl(url)?.pathname ?? '');
}

/** SignalR transports carry the connection token in the "id" query parameter. */
export function signalRConnectionToken(url: string): string | undefined {
  return safeUrl(url)?.searchParams.get('id') ?? undefined;
}

export interface NegotiateInfo {
  connectionId?: string;
  negotiateVersion?: number;
  transports: string[];
  redirectUrl?: string;
  error?: string;
}

export function parseNegotiateResponse(text: string | undefined): NegotiateInfo | null {
  if (!text) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const transports = Array.isArray(v.availableTransports)
    ? v.availableTransports
        .map((t) => (t && typeof t === 'object' ? (t as { transport?: unknown }).transport : undefined))
        .filter((t): t is string => typeof t === 'string')
    : [];
  if (!('connectionId' in v) && !('url' in v) && !('error' in v)) return null;
  return {
    connectionId: typeof v.connectionId === 'string' ? v.connectionId : undefined,
    negotiateVersion: typeof v.negotiateVersion === 'number' ? v.negotiateVersion : undefined,
    transports,
    redirectUrl: typeof v.url === 'string' ? v.url : undefined,
    error: typeof v.error === 'string' ? v.error : undefined,
  };
}

/** Decodes every record in a JSON Hub Protocol frame or long-polling body. */
export function decodeSignalRText(text: string): DecodedPacket[] {
  const records = text.split(RECORD_SEPARATOR).filter((r) => r.trim() !== '');
  if (!records.length) throw new DecodeError('Empty SignalR frame');
  return records.map(decodeRecord);
}

function decodeRecord(record: string): DecodedPacket {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(record) as Record<string, unknown>;
  } catch {
    throw new DecodeError('SignalR record is not valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new DecodeError('SignalR record is not an object');
  if (typeof v.type !== 'number') {
    // Handshake request {"protocol":"json","version":1} or response {} / {"error":...}.
    if (typeof v.protocol === 'string') {
      return {
        protocol: 'signalr',
        category: 'protocol',
        kind: 'Handshake request',
        result: { protocol: v.protocol, version: v.version },
      };
    }
    return {
      protocol: 'signalr',
      category: 'protocol',
      kind: 'Handshake response',
      error: typeof v.error === 'string' ? v.error : undefined,
    };
  }
  const t = TYPES[v.type];
  if (!t) throw new DecodeError(`Unknown SignalR message type ${v.type}`);
  const packet: DecodedPacket = { protocol: 'signalr', category: t.category, kind: t.kind };
  if (typeof v.invocationId === 'string') packet.invocationId = v.invocationId;
  if (typeof v.target === 'string') packet.name = v.target;
  if (Array.isArray(v.arguments)) packet.args = v.arguments;
  if ('item' in v) packet.result = v.item;
  if ('result' in v) packet.result = v.result;
  if (typeof v.error === 'string') packet.error = v.error;
  if (t.kind === 'Close' && typeof v.allowReconnect === 'boolean') {
    packet.result = { allowReconnect: v.allowReconnect };
  }
  if ((t.kind === 'Invocation' || t.kind === 'StreamInvocation') && !packet.name) {
    throw new DecodeError(`SignalR ${t.kind} without target`);
  }
  return packet;
}

export const BINARY_HUB_NOTE = 'Binary hub protocol (e.g. MessagePack): not decoded';
