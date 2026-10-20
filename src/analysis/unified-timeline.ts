// One chronological list of everything observed in a session: HTTP requests,
// realtime connections and messages, console/errors, navigation, interactions,
// notifications and server spans. Pure: built from stored records.
import type {
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  ServerSpan,
  TimelineEvent,
  TimelineKind,
} from '../shared/types';
import { safeUrl } from '../shared/util';
import { isFailure } from './filter';
import type { EventRef } from './trace-correlate';

export type TimelineCategory =
  | 'http'
  | 'websocket'
  | 'socket.io'
  | 'signalr'
  | 'sse'
  | 'console'
  | 'notification'
  | 'navigation'
  | 'interaction'
  | 'server'
  | 'capture';

export const TIMELINE_CATEGORIES: { id: TimelineCategory; label: string }[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'socket.io', label: 'Socket.IO' },
  { id: 'signalr', label: 'SignalR' },
  { id: 'sse', label: 'SSE' },
  { id: 'console', label: 'Console / errors' },
  { id: 'notification', label: 'Notifications' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'interaction', label: 'Interactions' },
  { id: 'server', label: 'Server' },
  { id: 'capture', label: 'Capture' },
];

export type Severity = 'error' | 'warning' | 'ok' | 'info';

export interface UnifiedItem {
  /** Stable key: `${ref.type}:${ref.id}`. */
  key: string;
  ref: EventRef;
  time: number;
  endTime?: number;
  category: TimelineCategory;
  severity: Severity;
  title: string;
  detail?: string;
  /** Identifiers worth showing and searching. */
  ids: { requestId?: string; connectionId?: string; traceId?: string; eventName?: string; spanId?: string };
  /** Who observed it, e.g. "main-world", "cdp", "server", "page (adapter)". */
  observedBy: string;
}

const CONSOLE_KINDS: TimelineKind[] = ['console-error', 'console-warn', 'js-error', 'unhandled-rejection'];

function timelineCategory(kind: TimelineKind): TimelineCategory {
  if (CONSOLE_KINDS.includes(kind)) return 'console';
  if (kind === 'ui-notification' || kind === 'app-signal') return 'notification';
  if (kind === 'navigation' || kind === 'page-load' || kind === 'route-change') return 'navigation';
  if (kind === 'click' || kind === 'form-submit' || kind === 'marker') return 'interaction';
  return 'capture';
}

export function protocolCategory(c: Pick<RealtimeConnection, 'protocol' | 'transport'>): TimelineCategory {
  if (c.protocol === 'socket.io') return 'socket.io';
  if (c.protocol === 'signalr') return 'signalr';
  if (c.protocol === 'sse' || c.transport === 'eventsource' || c.transport === 'fetch-stream') return 'sse';
  return 'websocket';
}

const pathOf = (url: string) => {
  const u = safeUrl(url);
  return u ? `${u.pathname}${u.search}` : url;
};

export function messageTitle(m: RealtimeMessage): string {
  if (m.opcode === 'lifecycle') return `${m.lifecycle}${m.note ? `: ${m.note}` : ''}`;
  const arrow = m.direction === 'out' ? '↑' : '↓';
  const packet = m.decoded?.find((d) => d.category === 'app') ?? m.decoded?.[0];
  if (packet?.name)
    return `${arrow} ${packet.kind === 'json' || packet.kind === 'event' ? '' : `${packet.kind} `}${packet.name}`;
  if (packet) return `${arrow} ${packet.kind}`;
  if (m.opcode === 'binary') return `${arrow} binary ${m.size ?? '?'} B`;
  return `${arrow} ${(m.text ?? '').slice(0, 80)}`;
}

export interface BuildOptions {
  /** Include heartbeat and protocol-control messages (off by default: they drown app events). */
  includeProtocolMessages?: boolean;
  /** Include internal server spans (off by default: only incoming requests and outbound calls). */
  includeInternalSpans?: boolean;
}

export function buildUnifiedTimeline(
  input: {
    entries: NetworkEntry[];
    timeline: TimelineEvent[];
    connections: RealtimeConnection[];
    messages: RealtimeMessage[];
    spans: ServerSpan[];
  },
  options: BuildOptions = {},
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  for (const e of input.entries) {
    const failed = isFailure(e);
    items.push({
      key: `request:${e.id}`,
      ref: { type: 'request', id: e.id },
      time: e.startedAt,
      endTime: e.endedAt,
      category: 'http',
      severity: failed ? 'error' : e.state === 'pending' ? 'info' : 'ok',
      title: `${e.method} ${pathOf(e.url)} → ${e.status ?? e.state}`,
      ids: { requestId: e.id },
      observedBy: e.source === 'cdp' ? 'cdp' : 'main-world',
    });
  }
  for (const t of input.timeline) {
    const category = timelineCategory(t.kind);
    items.push({
      key: `timeline:${t.id}`,
      ref: { type: 'timeline', id: t.id },
      time: t.timestamp,
      category,
      severity:
        t.kind === 'console-error' || t.kind === 'js-error' || t.kind === 'unhandled-rejection'
          ? 'error'
          : t.kind === 'console-warn' || t.kind === 'capture'
            ? 'warning'
            : 'info',
      title: t.kind === 'app-signal' ? `page reported: ${t.message}` : t.message,
      detail: t.detail,
      ids: { traceId: typeof t.data?.traceId === 'string' ? t.data.traceId : undefined },
      observedBy: t.source === 'adapter' ? 'page (adapter)' : (t.source ?? 'main-world'),
    });
  }
  const connById = new Map(input.connections.map((c) => [c.id, c]));
  for (const c of input.connections) {
    const failed =
      c.state === 'failed' || (c.closeCode !== undefined && c.closeCode !== 1000 && c.closeCode !== 1005);
    items.push({
      key: `rt-connection:${c.id}`,
      ref: { type: 'rt-connection', id: c.id },
      time: c.createdAt,
      endTime: c.closedAt,
      category: protocolCategory(c),
      severity: failed ? 'error' : c.attempt > 0 ? 'warning' : 'info',
      title: `${c.transport} ${pathOf(c.url)} ${c.state}${c.closeCode !== undefined ? ` (${c.closeCode})` : ''}${c.attempt ? ` · reconnect #${c.attempt}` : ''}`,
      ids: { connectionId: c.id },
      observedBy: c.sources.join('+'),
    });
  }
  for (const m of input.messages) {
    const conn = connById.get(m.connectionId);
    if (!conn) continue;
    if (m.opcode === 'lifecycle' && (m.lifecycle === 'connecting' || m.lifecycle === 'open')) continue; // shown by the connection item
    if (!options.includeProtocolMessages && m.decoded?.length && m.decoded.every((d) => d.category !== 'app'))
      continue;
    const packet = m.decoded?.find((d) => d.category === 'app');
    items.push({
      key: `rt-message:${m.id}`,
      ref: { type: 'rt-message', id: m.id },
      time: m.timestamp,
      category: protocolCategory(conn),
      severity:
        m.parseError || m.lifecycle === 'error' || packet?.error
          ? 'error'
          : m.opcode === 'lifecycle'
            ? 'warning'
            : 'info',
      title: messageTitle(m),
      detail: m.parseError ?? m.decodeNote,
      ids: { connectionId: m.connectionId, eventName: packet?.name },
      observedBy: m.sources.join('+'),
    });
  }
  const spanById = new Map(input.spans.map((s) => [s.id, s]));
  for (const s of input.spans) {
    const parent = s.parentSpanId ? spanById.get(`${s.traceId}:${s.parentSpanId}`) : undefined;
    const incomingRoot = s.kind === 'server' && (!parent || parent.kind !== 'server');
    if (!options.includeInternalSpans && !s.outbound && !incomingRoot) continue;
    const failed =
      s.status === 'error' || (s.httpStatus ?? 0) >= 500 || (s.outbound && (s.httpStatus ?? 0) >= 400);
    items.push({
      key: `span:${s.id}`,
      ref: { type: 'span', id: s.id },
      time: s.startTime,
      endTime: s.endTime,
      category: 'server',
      severity: failed ? 'error' : 'ok',
      title: `${s.outbound ? 'server → ' : 'server ← '}${s.name}${s.httpStatus ? ` → ${s.httpStatus}` : ''}`,
      detail: s.phase,
      ids: { traceId: s.traceId, spanId: s.spanId },
      observedBy: `server (${s.source})`,
    });
  }
  return items.sort((a, b) => a.time - b.time || (a.key < b.key ? -1 : 1));
}

export function filterUnified(
  items: UnifiedItem[],
  filter: { categories?: TimelineCategory[]; text?: string; onlyProblems?: boolean },
): UnifiedItem[] {
  const q = filter.text?.trim().toLowerCase();
  return items.filter((i) => {
    if (filter.categories?.length && !filter.categories.includes(i.category)) return false;
    if (filter.onlyProblems && i.severity !== 'error' && i.severity !== 'warning') return false;
    if (!q) return true;
    const hay = `${i.title} ${i.detail ?? ''} ${Object.values(i.ids).join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
}
