// Realtime connections and their messages. Messages are paged from IndexedDB
// per connection, so large streams never load into memory at once.
import { useEffect, useMemo, useRef, useState } from 'react';
import { messageTitle, protocolCategory } from '../../analysis/unified-timeline';
import type { RealtimeConnection, RealtimeMessage } from '../../shared/types';
import { formatBytes, formatDuration, safeUrl } from '../../shared/util';
import { CodeBlock, CopyButton, KeyValueTable, Notice, VirtualList } from '../components/common';
import { ActiveFilters, Badge, EmptyState, JsonTree } from '../components/ui';
import type { Chip, Tone } from '../components/ui';
import { getStore } from '../lib/extension';
import { useShortcuts } from '../lib/shortcuts';
import type { ViewProps } from './context';

const ROW = 26;
const PAGE = 1000;

export function connectionTone(c: RealtimeConnection): Tone {
  if (c.state === 'failed') return 'error';
  if (c.state === 'reconnecting') return 'warning';
  if (c.state === 'open') return 'ok';
  if (c.closeCode !== undefined && ![1000, 1001, 1005].includes(c.closeCode)) return 'error';
  return 'muted';
}

const PROTOCOL_LABEL: Record<string, string> = {
  raw: 'WebSocket',
  'socket.io': 'Socket.IO',
  signalr: 'SignalR',
  sse: 'SSE',
};

function connectionLabel(c: RealtimeConnection) {
  const u = safeUrl(c.url);
  return u ? `${u.host}${u.pathname}` : c.url;
}

type Direction = 'all' | 'in' | 'out';

export function RealtimeView(props: ViewProps) {
  const { data, params, setParams, version } = props;
  const stateFilter = params.state ?? '';
  const connections = useMemo(() => {
    const list = [...data.connections].sort((a, b) => b.createdAt - a.createdAt);
    if (stateFilter === 'problems') return list.filter((c) => connectionTone(c) === 'error');
    if (stateFilter) return list.filter((c) => c.state === stateFilter);
    return list;
  }, [data.connections, stateFilter]);
  const [selectedConn, setSelectedConn] = useState<string | null>(params.conn ?? null);
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [hasMore, setHasMore] = useState<[number, string] | undefined>();
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [direction, setDirection] = useState<Direction>((params.dir as Direction) || 'all');
  const [appOnly, setAppOnly] = useState(params.app !== '0');
  const [query, setQuery] = useState(params.q ?? '');
  const [debounced, setDebounced] = useState(query);
  const [eventName, setEventName] = useState(params.event ?? '');
  const [selectedMsg, setSelectedMsg] = useState<string | null>(params.message ?? null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A deep link to a message selects its connection.
  useEffect(() => {
    if (!params.message) return;
    void getStore()
      .then((s) => s.getMessage(params.message!))
      .then((m) => {
        if (m) {
          setSelectedConn(m.connectionId);
          setSelectedMsg(m.id);
        }
      });
  }, [params.message]);

  useEffect(() => {
    if (!selectedConn && connections[0]) setSelectedConn(connections[0].id);
  }, [connections, selectedConn]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setParams({
      ...params,
      conn: selectedConn ?? '',
      dir: direction === 'all' ? '' : direction,
      app: appOnly ? '' : '0',
      q: debounced,
      event: eventName,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConn, direction, appOnly, debounced, eventName]);

  // First page of messages for the selected connection (reloaded as new data arrives).
  useEffect(() => {
    if (!selectedConn) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMsgs(true);
    void getStore()
      .then((s) => s.listMessages(selectedConn, { limit: PAGE }))
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setHasMore(page.next);
        setLoadingMsgs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConn, version]);

  const loadMore = async () => {
    if (!selectedConn || !hasMore) return;
    setLoadingMsgs(true);
    const page = await (await getStore()).listMessages(selectedConn, { after: hasMore, limit: PAGE });
    setMessages((m) => [...m, ...page.messages]);
    setHasMore(page.next);
    setLoadingMsgs(false);
  };

  const conn = data.connections.find((c) => c.id === selectedConn);
  const eventNames = useMemo(
    () =>
      [
        ...new Set(
          messages.flatMap(
            (m) => m.decoded?.filter((d) => d.category === 'app' && d.name).map((d) => d.name!) ?? [],
          ),
        ),
      ].sort(),
    [messages],
  );
  const visible = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return messages.filter((m) => {
      if (direction !== 'all' && m.direction !== direction && m.opcode !== 'lifecycle') return false;
      if (appOnly && m.decoded?.length && m.decoded.every((d) => d.category !== 'app')) return false;
      if (eventName && !m.decoded?.some((d) => d.name === eventName)) return false;
      if (q && !`${m.text ?? ''} ${messageTitle(m)} ${m.note ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [messages, direction, appOnly, debounced, eventName]);
  const msg = messages.find((m) => m.id === selectedMsg) ?? null;

  useShortcuts([
    { keys: '/', description: 'Search messages', handler: () => searchRef.current?.focus() },
    {
      keys: 'j',
      description: 'Next message',
      handler: () => {
        const i = visible.findIndex((m) => m.id === selectedMsg);
        const next = visible[Math.min(visible.length - 1, i + 1)];
        if (next) setSelectedMsg(next.id);
      },
    },
    {
      keys: 'k',
      description: 'Previous message',
      handler: () => {
        const i = visible.findIndex((m) => m.id === selectedMsg);
        const prev = visible[Math.max(0, i - 1)];
        if (prev) setSelectedMsg(prev.id);
      },
    },
    { keys: 'Escape', description: 'Close message', handler: () => setSelectedMsg(null) },
    {
      keys: 'i',
      description: 'Investigate',
      handler: () => selectedMsg && props.investigate({ type: 'rt-message', id: selectedMsg }),
    },
  ]);

  if (!props.settings.captureRealtime) {
    return (
      <div className="pad">
        <EmptyState
          title="Realtime capture is disabled"
          action={
            <button type="button" className="btn" onClick={() => props.navigate('settings')}>
              Open settings
            </button>
          }
        >
          WebSocket and EventSource traffic is not recorded while “Record WebSocket and EventSource traffic”
          is off.
        </EmptyState>
      </div>
    );
  }
  if (!data.connections.length) {
    return (
      <div className="pad">
        <EmptyState title="No realtime connections recorded">
          WebSocket, Socket.IO, SignalR and Server-Sent Events connections appear here once the recorded page
          opens them. Connections opened before recording started become visible when they next send data
          (outgoing) — reload the page to capture them from the start.
        </EmptyState>
      </div>
    );
  }

  const chips: Chip[] = [];
  if (stateFilter)
    chips.push({
      id: 'state',
      label: stateFilter === 'problems' ? 'failed / abnormal' : stateFilter,
      onRemove: () => setParams({ ...params, state: '' }),
    });
  if (direction !== 'all')
    chips.push({
      id: 'dir',
      label: direction === 'in' ? 'incoming' : 'outgoing',
      onRemove: () => setDirection('all'),
    });
  if (appOnly) chips.push({ id: 'app', label: 'app messages only', onRemove: () => setAppOnly(false) });
  if (eventName) chips.push({ id: 'event', label: `event: ${eventName}`, onRemove: () => setEventName('') });
  if (debounced) chips.push({ id: 'q', label: `“${debounced}”`, onRemove: () => setQuery('') });

  return (
    <div className="realtime-layout">
      <nav className="conn-list" aria-label="Connections">
        <div className="conn-list-head">
          <span className="muted small">{connections.length} connection(s)</span>
          <select
            aria-label="Connection state filter"
            value={stateFilter}
            onChange={(e) => setParams({ ...params, state: e.target.value })}
          >
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="reconnecting">Reconnecting</option>
            <option value="closed">Closed</option>
            <option value="failed">Failed</option>
            <option value="problems">Failed / abnormal close</option>
          </select>
        </div>
        <ul>
          {connections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`conn ${c.id === selectedConn ? 'conn-selected' : ''}`}
                aria-current={c.id === selectedConn}
                onClick={() => setSelectedConn(c.id)}
              >
                <span className="conn-top">
                  <Badge tone={connectionTone(c)}>
                    {c.state}
                    {c.closeCode !== undefined ? ` ${c.closeCode}` : ''}
                  </Badge>
                  <span className={`proto proto-${protocolCategory(c)}`}>
                    {PROTOCOL_LABEL[c.protocol] ?? c.protocol}
                  </span>
                  <span className="muted small">{c.transport}</span>
                  {c.attempt > 0 && (
                    <span className="tag" title="Reconnect attempt">
                      #{c.attempt}
                    </span>
                  )}
                </span>
                <span className="conn-url break">{connectionLabel(c)}</span>
                <span className="muted small">
                  {new Date(c.createdAt).toLocaleTimeString()} · ↓{c.inCount} ↑{c.outCount} ·{' '}
                  {c.sources.join('+')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="msg-pane" aria-label="Messages">
        {conn && (
          <div className="conn-summary">
            <div className="conn-summary-title">
              <Badge tone={connectionTone(conn)}>{conn.state}</Badge>
              <strong className="break">{conn.url}</strong>
              <CopyButton label="Copy URL" text={() => conn.url} />
              <button
                type="button"
                className="btn btn-small btn-primary"
                onClick={() => props.investigate({ type: 'rt-connection', id: conn.id })}
              >
                Investigate
              </button>
            </div>
            <div className="muted small">
              {PROTOCOL_LABEL[conn.protocol]} over {conn.transport}
              {conn.protocolEvidence ? ` (detected by ${conn.protocolEvidence})` : ''} · opened{' '}
              {conn.openedAt ? new Date(conn.openedAt).toLocaleTimeString() : 'never'}
              {conn.closedAt
                ? ` · closed ${new Date(conn.closedAt).toLocaleTimeString()} after ${formatDuration(conn.closedAt - (conn.openedAt ?? conn.createdAt))}`
                : ''}
              {conn.closeCode !== undefined
                ? ` · code ${conn.closeCode}${conn.closeReason ? ` “${conn.closeReason}”` : ''}${conn.wasClean === false ? ' (not clean)' : ''}`
                : ''}{' '}
              · ↓{formatBytes(conn.bytesIn)} ↑{formatBytes(conn.bytesOut)}
              {conn.reconnectOf && (
                <>
                  {' '}
                  ·{' '}
                  <button
                    type="button"
                    className="link small"
                    onClick={() => setSelectedConn(conn.reconnectOf!)}
                  >
                    previous connection
                  </button>
                </>
              )}
              {conn.upgradedFrom && (
                <>
                  {' '}
                  ·{' '}
                  <button
                    type="button"
                    className="link small"
                    onClick={() => setSelectedConn(conn.upgradedFrom!)}
                  >
                    upgraded from polling
                  </button>
                </>
              )}
            </div>
            {conn.warnings.map((w) => (
              <Notice key={w} kind="warning">
                {w}
              </Notice>
            ))}
          </div>
        )}
        <div className="filters">
          <input
            ref={searchRef}
            type="search"
            className="search"
            placeholder="Search payloads ( / )"
            aria-label="Search messages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="chip-group" role="group" aria-label="Direction">
            {(['all', 'in', 'out'] as Direction[]).map((d) => (
              <button
                key={d}
                type="button"
                className={`chip ${direction === d ? 'chip-on' : ''}`}
                aria-pressed={direction === d}
                onClick={() => setDirection(d)}
              >
                {d === 'all' ? 'Both' : d === 'in' ? '↓ Incoming' : '↑ Outgoing'}
              </button>
            ))}
          </div>
          <label className="check" title="Hide heartbeats (ping/pong) and protocol control messages">
            <input type="checkbox" checked={appOnly} onChange={(e) => setAppOnly(e.target.checked)} /> app
            messages only
          </label>
          {eventNames.length > 0 && (
            <select aria-label="Event name" value={eventName} onChange={(e) => setEventName(e.target.value)}>
              <option value="">All events</option>
              {eventNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="toolbar">
          <ActiveFilters
            chips={chips}
            onClearAll={() => {
              setDirection('all');
              setAppOnly(false);
              setEventName('');
              setQuery('');
              setParams({ conn: selectedConn ?? '' });
            }}
            shown={visible.length}
            total={messages.length}
            noun={`loaded messages${hasMore ? ' (more available)' : ''}`}
          />
          <span className="spacer" />
          {hasMore && (
            <button type="button" className="btn btn-small" onClick={loadMore} disabled={loadingMsgs}>
              Load {PAGE} more
            </button>
          )}
        </div>
        <div className="msg-split">
          {loadingMsgs && !messages.length ? (
            <p className="muted pad">Loading messages…</p>
          ) : visible.length === 0 ? (
            <EmptyState
              title={messages.length ? 'No messages match the filters.' : 'No messages on this connection.'}
            />
          ) : (
            <VirtualList
              items={visible}
              rowHeight={ROW}
              className="msg-list"
              renderRow={(m) => (
                <div
                  key={m.id}
                  role="row"
                  aria-selected={m.id === selectedMsg}
                  className={`msg-row msg-${m.direction} ${m.id === selectedMsg ? 'row-selected' : ''} ${m.parseError || m.lifecycle === 'error' ? 'row-error' : ''}`}
                  style={{ height: ROW }}
                  onClick={() => setSelectedMsg(m.id)}
                >
                  <span className="msg-time muted">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  <span className="msg-dir" aria-label={m.direction}>
                    {m.opcode === 'lifecycle' ? '◆' : m.direction === 'in' ? '↓' : '↑'}
                  </span>
                  <span className="msg-title">{messageTitle(m).replace(/^[↑↓] /, '')}</span>
                  <span className="msg-size muted">{m.size !== undefined ? formatBytes(m.size) : ''}</span>
                  {m.parseError && <span className="text-error small">malformed</span>}
                  {m.truncated && <span className="tag">truncated</span>}
                  {m.sources.length > 1 && (
                    <span className="tag" title={`Observed by ${m.sources.join(' and ')}`}>
                      ×{m.sources.length}
                    </span>
                  )}
                </div>
              )}
            />
          )}
          {msg && (
            <aside className="msg-detail details" aria-label="Message details">
              <div className="details-header">
                <div className="details-title">
                  <strong>{messageTitle(msg)}</strong>
                </div>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  aria-label="Close message (Esc)"
                  onClick={() => setSelectedMsg(null)}
                >
                  ✕
                </button>
              </div>
              <div className="details-actions">
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  onClick={() => props.investigate({ type: 'rt-message', id: msg.id })}
                >
                  Investigate
                </button>
                {msg.text !== undefined && <CopyButton label="Copy payload" text={() => msg.text ?? ''} />}
              </div>
              <div className="details-body">
                <KeyValueTable
                  rows={[
                    {
                      name: 'Time',
                      value:
                        new Date(msg.timestamp).toLocaleTimeString() +
                        `.${String(Math.floor(msg.timestamp % 1000)).padStart(3, '0')}`,
                    },
                    {
                      name: 'Direction',
                      value:
                        msg.direction === 'in'
                          ? 'incoming (server → browser)'
                          : msg.direction === 'out'
                            ? 'outgoing (browser → server)'
                            : 'lifecycle',
                    },
                    { name: 'Size', value: msg.size !== undefined ? formatBytes(msg.size) : 'unknown' },
                    { name: 'Observed by', value: msg.sources.join(', ') },
                    ...(msg.sse
                      ? [
                          {
                            name: 'SSE event',
                            value: `${msg.sse.type}${msg.sse.lastEventId ? ` · id ${msg.sse.lastEventId}` : ''}`,
                          },
                        ]
                      : []),
                    ...(msg.note ? [{ name: 'Note', value: msg.note }] : []),
                    { name: 'Message id', value: <code>{msg.id}</code>, copy: msg.id },
                  ]}
                  copyable
                  empty=""
                />
                {msg.parseError && <Notice kind="error">Malformed: {msg.parseError}</Notice>}
                {msg.decodeNote && <Notice kind="info">{msg.decodeNote}</Notice>}
                {msg.truncated && (
                  <Notice kind="warning">
                    Payload truncated at the frame size limit ({props.settings.maxFrameKB} KB).
                  </Notice>
                )}
                {msg.redactions > 0 && (
                  <Notice kind="info">
                    {msg.redactions} sensitive value(s) were removed before storage.
                  </Notice>
                )}
                {msg.decoded && (
                  <>
                    <h3>Decoded ({msg.decoded[0]?.protocol})</h3>
                    {msg.decoded.map((p, i) => (
                      <div key={i} className="decoded">
                        <div className="small">
                          <span className={`tag cat-${p.category}`}>{p.category}</span>{' '}
                          <strong>{p.kind}</strong>
                          {p.name && <> · {p.name}</>}
                          {p.nameSource && <span className="muted"> (name guessed from {p.nameSource})</span>}
                          {p.namespace && p.namespace !== '/' && <> · namespace {p.namespace}</>}
                          {p.ackId !== undefined && <> · ack {p.ackId}</>}
                          {p.invocationId && <> · invocation {p.invocationId}</>}
                          {p.attachments ? <> · {p.attachments} binary attachment(s), not decoded</> : null}
                        </div>
                        {p.error && <Notice kind="error">{p.error}</Notice>}
                        {p.args !== undefined && <JsonTree value={p.args} />}
                        {p.result !== undefined && (
                          <>
                            <div className="muted small">result</div>
                            <JsonTree value={p.result} />
                          </>
                        )}
                      </div>
                    ))}
                  </>
                )}
                {msg.text !== undefined && (
                  <>
                    <h3>Raw</h3>
                    <CodeBlock text={msg.text} label="Copy raw payload" raw />
                  </>
                )}
                {msg.opcode === 'binary' && (
                  <p className="muted">
                    Binary frame ({msg.binaryType ?? 'binary'}): contents are never stored.
                  </p>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
