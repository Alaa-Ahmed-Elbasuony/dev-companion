// Unified, chronological timeline of every observed event: HTTP, realtime,
// console, navigation, interactions, notifications and server spans.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventRef } from '../../analysis/trace-correlate';
import { TIMELINE_CATEGORIES, buildUnifiedTimeline, filterUnified } from '../../analysis/unified-timeline';
import type { TimelineCategory, UnifiedItem } from '../../analysis/unified-timeline';
import type { RealtimeMessage } from '../../shared/types';
import { formatDuration } from '../../shared/util';
import { CopyButton, Notice, VirtualList } from '../components/common';
import { ActiveFilters, Badge, EmptyState, RelationBadge } from '../components/ui';
import type { Chip } from '../components/ui';
import { sendToWorker } from '../lib/extension';
import { useShortcuts } from '../lib/shortcuts';
import type { ViewProps } from './context';

const ROW = 32;

export function TimelineView(props: ViewProps & { messages: RealtimeMessage[] | null }) {
  const { data, analysis, params, setParams, messages } = props;
  const categories = useMemo(
    () =>
      params.cat
        ? (params.cat
            .split(',')
            .filter((c) => TIMELINE_CATEGORIES.some((x) => x.id === c)) as TimelineCategory[])
        : [],
    [params.cat],
  );
  const onlyProblems = params.problems === '1';
  const showProtocol = params.protocol === '1';
  const [text, setText] = useState(params.q ?? '');
  const [selected, setSelected] = useState<string | null>(params.focus ?? null);
  const [marker, setMarker] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => text !== (params.q ?? '') && setParams({ ...params, q: text }), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const items = useMemo(
    () =>
      buildUnifiedTimeline(
        {
          entries: data.entries,
          timeline: data.timeline,
          connections: data.connections,
          messages: messages ?? [],
          spans: data.spans,
        },
        { includeProtocolMessages: showProtocol },
      ),
    [data, messages, showProtocol],
  );
  const visible = useMemo(
    () => filterUnified(items, { categories, text: params.q, onlyProblems }),
    [items, categories, params.q, onlyProblems],
  );
  const counts = useMemo(() => {
    const c = new Map<TimelineCategory, number>();
    for (const i of items) c.set(i.category, (c.get(i.category) ?? 0) + 1);
    return c;
  }, [items]);
  const origin = items[0]?.time ?? 0;
  const current = items.find((i) => i.key === selected) ?? null;

  // Links of the selected item, labeled by strength.
  const links = useMemo(() => {
    if (!current || !analysis) return [];
    const ref = current.ref;
    const same = (r: EventRef) => r.type === ref.type && r.id === ref.id;
    const traceId = current.ids.traceId;
    return analysis.links.filter(
      (l) => same(l.from) || same(l.to) || (traceId && l.to.type === 'trace' && l.to.id === traceId),
    );
  }, [current, analysis]);

  const toggle = (c: TimelineCategory) => {
    const next = categories.includes(c) ? categories.filter((x) => x !== c) : [...categories, c];
    setParams({ ...params, cat: next.join(',') });
  };

  useShortcuts([
    { keys: '/', description: 'Search', handler: () => searchRef.current?.focus() },
    {
      keys: 'j',
      description: 'Next event',
      handler: () => {
        const i = visible.findIndex((x) => x.key === selected);
        const n = visible[Math.min(visible.length - 1, i + 1)];
        if (n) setSelected(n.key);
      },
    },
    {
      keys: 'k',
      description: 'Previous event',
      handler: () => {
        const i = visible.findIndex((x) => x.key === selected);
        const n = visible[Math.max(0, i - 1)];
        if (n) setSelected(n.key);
      },
    },
    { keys: 'Escape', description: 'Close', handler: () => setSelected(null) },
    {
      keys: 'i',
      description: 'Investigate',
      handler: () => current && current.ref.type !== 'trace' && props.investigate(current.ref as never),
    },
  ]);

  const open = (item: UnifiedItem) => {
    const r = item.ref;
    if (r.type === 'request') props.openEntry(r.id);
    else if (r.type === 'rt-message') props.navigate('realtime', { message: r.id });
    else if (r.type === 'rt-connection') props.navigate('realtime', { conn: r.id });
    else if (r.type === 'span') props.navigate('tracing', { span: r.id });
    else if (r.type === 'timeline' && item.category === 'console') props.navigate('console', { id: r.id });
  };

  const addMarker = async () => {
    if (!data.recording) return;
    const res = await sendToWorker<{ ok: boolean; message?: string }>({
      type: 'add-marker',
      tabId: data.recording.tabId,
      label: marker.trim() || 'Marker',
    });
    setNote(res.ok ? 'Marker added.' : (res.message ?? 'Could not add marker.'));
    setMarker('');
  };

  const chips: Chip[] = categories.map((c) => ({
    id: c,
    label: TIMELINE_CATEGORIES.find((x) => x.id === c)?.label ?? c,
    onRemove: () => toggle(c),
  }));
  if (onlyProblems)
    chips.push({ id: 'p', label: 'problems only', onRemove: () => setParams({ ...params, problems: '' }) });
  if (params.q)
    chips.push({
      id: 'q',
      label: `“${params.q}”`,
      onRemove: () => {
        setText('');
        setParams({ ...params, q: '' });
      },
    });

  return (
    <div className="timeline-layout">
      <div className="filters">
        <input
          ref={searchRef}
          type="search"
          className="search"
          placeholder="Search events, ids, event names ( / )"
          aria-label="Search timeline"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="chip-group" role="group" aria-label="Event types">
          {TIMELINE_CATEGORIES.filter((c) => counts.get(c.id)).map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip cat-chip-${c.id} ${categories.includes(c.id) ? 'chip-on' : ''}`}
              aria-pressed={categories.includes(c.id)}
              onClick={() => toggle(c.id)}
            >
              {c.label} <span className="chip-count">{counts.get(c.id)}</span>
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setParams({ ...params, problems: e.target.checked ? '1' : '' })}
          />{' '}
          problems only
        </label>
        <label className="check" title="Show heartbeats and protocol control messages">
          <input
            type="checkbox"
            checked={showProtocol}
            onChange={(e) => setParams({ ...params, protocol: e.target.checked ? '1' : '' })}
          />{' '}
          protocol messages
        </label>
        <span className="spacer" />
        {data.recording ? (
          <span className="marker-row">
            <input
              type="text"
              aria-label="Marker label"
              placeholder="Marker (e.g. before clicking Create Order)"
              value={marker}
              maxLength={200}
              onChange={(e) => setMarker(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addMarker()}
            />
            <button type="button" className="btn btn-small" onClick={addMarker}>
              Add marker
            </button>
          </span>
        ) : (
          <span className="muted small">Markers can be added while the session's tab is recording.</span>
        )}
      </div>
      <div className="toolbar">
        <ActiveFilters
          chips={chips}
          onClearAll={() => {
            setText('');
            setParams({});
          }}
          shown={visible.length}
          total={items.length}
          noun="events"
        />
        {messages === null && <span className="muted small">Loading realtime messages…</span>}
      </div>
      {note && <Notice kind="info">{note}</Notice>}
      <div className="timeline-split">
        {visible.length === 0 ? (
          <EmptyState
            title={items.length ? 'No events match the filters.' : 'No events recorded in this session.'}
          />
        ) : (
          <VirtualList
            items={visible}
            rowHeight={ROW}
            className="timeline-list"
            renderRow={(item) => (
              <div
                key={item.key}
                role="row"
                aria-selected={item.key === selected}
                className={`tl-row tl-cat-${item.category} sev-row-${item.severity} ${item.key === selected ? 'row-selected' : ''}`}
                style={{ height: ROW }}
                onClick={() => setSelected(item.key)}
                onDoubleClick={() => open(item)}
              >
                <span className="tl-time">
                  {new Date(item.time).toLocaleTimeString()}
                  <span className="muted small"> +{formatDuration(item.time - origin)}</span>
                </span>
                <span className="tl-kind">
                  <span className={`cat cat-${item.category}`}>
                    {TIMELINE_CATEGORIES.find((c) => c.id === item.category)?.label}
                  </span>
                </span>
                <span className="tl-msg" title={[item.title, item.detail].filter(Boolean).join('\n')}>
                  {item.severity === 'error' && (
                    <span className="sev-icon" aria-label="error">
                      ✕{' '}
                    </span>
                  )}
                  {item.severity === 'warning' && (
                    <span className="sev-icon warn" aria-label="warning">
                      !{' '}
                    </span>
                  )}
                  {item.title}
                  {item.endTime !== undefined && (
                    <span className="muted small"> · {formatDuration(item.endTime - item.time)}</span>
                  )}
                  {item.detail && <span className="muted small"> · {item.detail}</span>}
                </span>
              </div>
            )}
          />
        )}
        {current && (
          <aside className="details tl-detail" aria-label="Event details">
            <div className="details-header">
              <div className="details-title">
                <span className={`cat cat-${current.category}`}>{current.category}</span>{' '}
                <strong className="break">{current.title}</strong>
              </div>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                aria-label="Close (Esc)"
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
            </div>
            <div className="details-actions">
              <button type="button" className="btn btn-small" onClick={() => open(current)}>
                Open
              </button>
              {current.ref.type !== 'trace' && (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  onClick={() => props.investigate(current.ref as never)}
                >
                  Investigate
                </button>
              )}
              <CopyButton
                label="Copy event"
                text={() =>
                  [
                    `${current.category}: ${current.title}`,
                    `time: ${new Date(current.time).toISOString()}`,
                    current.detail,
                    ...Object.entries(current.ids)
                      .filter(([, v]) => v)
                      .map(([k, v]) => `${k}: ${v}`),
                  ]
                    .filter(Boolean)
                    .join('\n')
                }
                raw
              />
            </div>
            <div className="details-body">
              <p className="small">
                {new Date(current.time).toLocaleString()} · observed by {current.observedBy}
              </p>
              {current.detail && <p className="muted small">{current.detail}</p>}
              {Object.entries(current.ids).filter(([, v]) => v).length > 0 && (
                <p className="small mono">
                  {Object.entries(current.ids)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </p>
              )}
              <h3>Links</h3>
              {!analysis ? (
                <p className="muted small">Analyzing…</p>
              ) : links.length === 0 ? (
                <p className="muted small">No events linked to this one (by shared id or timing).</p>
              ) : (
                <ul className="related">
                  {links.map((l, i) => (
                    <li key={i}>
                      <RelationBadge relation={l.strength} /> {l.evidence}
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted small">
                <Badge tone="info">note</Badge> “by time only” links may be coincidental; only shared ids
                prove that two events belong together.
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
