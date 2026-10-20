// Protocol detection and frame decoding entry points, plus the identity used to
// deduplicate observations of the same traffic from several capture mechanisms.
import type {
  DecodedPacket,
  MessageDirection,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RealtimeProtocol,
} from '../../shared/types';
import { BINARY_HUB_NOTE, decodeSignalRText, looksLikeSignalR } from './signalr';
import { DecodeError, decodeEngineIoPacket, parseSocketIoUrl } from './socketio';

/** Protocol suggested by the connection itself (URL, transport). Frames may refine it later. */
export function detectProtocol(conn: Pick<RealtimeConnectionDraft, 'url' | 'transport'>): RealtimeProtocol {
  if (parseSocketIoUrl(conn.url)) return 'socket.io';
  if (conn.transport === 'eventsource' || conn.transport === 'fetch-stream') return 'sse';
  return 'raw';
}

/** Refines a raw/SSE connection to SignalR once a frame shows the JSON Hub Protocol framing. */
export function refineProtocol(current: RealtimeProtocol, message: RealtimeMessageDraft): RealtimeProtocol {
  if (current === 'socket.io' || current === 'signalr') return current;
  if (message.opcode === 'text' && looksLikeSignalR(message.text)) return 'signalr';
  return current;
}

export interface DecodeResult {
  decoded?: DecodedPacket[];
  /** The payload looked like a known protocol but was malformed. */
  parseError?: string;
  /** The payload was intentionally not decoded (truncated, binary protocol). Not an error. */
  decodeNote?: string;
}

export const TRUNCATED_NOTE = 'Frame truncated at the size limit; not decoded';

const NAME_FIELDS = ['type', 'event', 'name', 'action', 'topic', 'kind', 'op'] as const;

/** Plain JSON frames: the event name is only a guess from a conventional field. */
function decodePlainJson(text: string, protocol: RealtimeProtocol, sseType?: string): DecodeResult {
  const trimmed = text.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson) {
    return sseType ? { decoded: [{ protocol, category: 'app', kind: 'event', name: sseType }] } : {};
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { parseError: 'Payload looks like JSON but is not valid JSON' };
  }
  const packet: DecodedPacket = {
    protocol,
    category: 'app',
    kind: sseType ? 'event' : 'json',
    args: [value],
  };
  if (sseType) packet.name = sseType;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of NAME_FIELDS) {
      const v = (value as Record<string, unknown>)[field];
      if (typeof v === 'string' && v.length <= 200) {
        packet.name = v;
        packet.nameSource = `field "${field}"`;
        break;
      }
    }
  }
  return { decoded: [packet] };
}

export function decodeMessage(
  protocol: RealtimeProtocol,
  message: RealtimeMessageDraft,
  connectionUrl: string,
): DecodeResult {
  if (message.opcode === 'lifecycle') return {};
  if (message.opcode === 'binary') {
    if (protocol === 'signalr') return { decodeNote: BINARY_HUB_NOTE };
    if (protocol === 'socket.io') {
      return {
        decoded: [{ protocol, category: 'app', kind: 'binary attachment', attachments: 1 }],
      };
    }
    return {};
  }
  const text = message.text ?? '';
  if (message.truncated && protocol !== 'raw' && protocol !== 'sse') {
    return { decodeNote: TRUNCATED_NOTE };
  }
  try {
    if (protocol === 'socket.io') {
      const eio = parseSocketIoUrl(connectionUrl)?.eio ?? 4;
      return { decoded: [decodeEngineIoPacket(text, eio)] };
    }
    if (protocol === 'signalr') return { decoded: decodeSignalRText(text) };
  } catch (err) {
    if (err instanceof DecodeError) return { parseError: err.message };
    return { parseError: 'Decoder failed' };
  }
  if (message.truncated) return { decodeNote: TRUNCATED_NOTE };
  return decodePlainJson(text, protocol, message.sse?.type);
}

/** 32-bit FNV-1a over a string. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Characters hashed for dedup: fits inside the smallest frame limit (1 KB) for any encoding. */
export const DEDUP_PREFIX_CHARS = 256;

/**
 * Identity of one frame independent of the mechanism that saw it. Mechanisms
 * agree on direction, byte size and the payload prefix; timestamps differ
 * slightly and are compared separately with a window.
 */
export function dedupKey(
  connectionId: string,
  direction: MessageDirection,
  opcode: RealtimeMessageDraft['opcode'],
  size: number | undefined,
  text: string | undefined,
  extra = '',
): string {
  const payload = opcode === 'text' ? (text ?? '').slice(0, DEDUP_PREFIX_CHARS) : opcode;
  return `${connectionId}|${direction}|${opcode}|${size ?? -1}|${fnv1a(payload + extra)}`;
}

/** Window within which two observations of the same frame are considered one. */
export const DEDUP_WINDOW_MS = 1500;
/** Window for matching a CDP connection to a main-world one with the same URL. */
export const CONNECTION_MATCH_WINDOW_MS = 2000;

/** Strips query parameters that change on every reconnect (Socket.IO sid/t, SignalR id). */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ['sid', 't', 'id', 'j', 'b64', 'access_token']) u.searchParams.delete(p);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}
