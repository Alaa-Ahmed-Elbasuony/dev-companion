// Console errors, warnings, uncaught errors and rejections with stacks and the
// requests they are (time-)correlated with.
import { useMemo, useState } from 'react';
import { correlate } from '../../analysis/correlate';
import type { TimelineKind } from '../../shared/types';
import { Notice } from '../components/common';
import { ActiveFilters, Badge, EmptyState, RelationBadge } from '../components/ui';
import type { Chip } from '../components/ui';
import type { ViewProps } from './context';

const KINDS: { id: TimelineKind; label: string }[] = [
  { id: 'js-error', label: 'Uncaught errors' },
  { id: 'unhandled-rejection', label: 'Rejections' },
  { id: 'console-error', label: 'console.error' },
  { id: 'console-warn', label: 'console.warn' },
];

export function ConsoleView(props: ViewProps) {
  const { data, settings, params, setParams } = props;
  const [query, setQuery] = useState('');
  const kinds = useMemo(
    () => (params.kinds ? (params.kinds.split(',') as TimelineKind[]) : []),
    [params.kinds],
  );
  const events = useMemo(
    () =>
      data.timeline
        .filter((t) => KINDS.some((k) => k.id === t.kind))
        .filter((t) => !kinds.length || kinds.includes(t.kind))
        .filter((t) => !query || `${t.message} ${t.stack ?? ''}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => b.timestamp - a.timestamp),
    [data.timeline, kinds, query],
  );
  const correlation = useMemo(() => correlate(data.entries, data.timeline), [data.entries, data.timeline]);
  const total = data.timeline.filter((t) => KINDS.some((k) => k.id === t.kind)).length;
  const toggle = (k: TimelineKind) =>
    setParams({
      ...params,
      kinds: (kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]).join(','),
    });
  const chips: Chip[] = kinds.map((k) => ({
    id: k,
    label: KINDS.find((x) => x.id === k)!.label,
    onRemove: () => toggle(k),
  }));
  if (query) chips.push({ id: 'q', label: `“${query}”`, onRemove: () => setQuery('') });

  return (
    <div className="console-view">
      <div className="filters">
        <input
          type="search"
          className="search"
          placeholder="Search messages and stacks"
          aria-label="Search console"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chip-group" role="group" aria-label="Kinds">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`chip ${kinds.includes(k.id) ? 'chip-on' : ''}`}
              aria-pressed={kinds.includes(k.id)}
              onClick={() => toggle(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <ActiveFilters
          chips={chips}
          onClearAll={() => {
            setQuery('');
            setParams({});
          }}
          shown={events.length}
          total={total}
          noun="console events"
        />
      </div>
      {!settings.captureConsole && (
        <Notice kind="warning">
          Console capture is turned off in Settings; uncaught errors and rejections are still recorded.
        </Notice>
      )}
      {events.length === 0 ? (
        <EmptyState
          title={total ? 'No console events match the filters.' : 'No console errors or warnings recorded.'}
        >
          Console capture starts at page load: if recording started on an already open page, reload it to
          capture console.error/warn.
        </EmptyState>
      ) : (
        <ul className="console-list">
          {events.map((t) => {
            const related = correlation.get(t.id) ?? [];
            const isError = t.kind !== 'console-warn';
            return (
              <li
                key={t.id}
                className={`console-item ${isError ? 'console-error' : 'console-warn'} ${params.id === t.id ? 'row-selected' : ''}`}
              >
                <div className="console-head">
                  <Badge tone={isError ? 'error' : 'warning'}>
                    {KINDS.find((k) => k.id === t.kind)?.label}
                  </Badge>
                  <span className="muted small">{new Date(t.timestamp).toLocaleTimeString()}</span>
                  {t.data?.hydrationPattern === true && (
                    <span className="tag" title={t.detail}>
                      hydration? (pattern match)
                    </span>
                  )}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => props.investigate({ type: 'timeline', id: t.id })}
                  >
                    Investigate
                  </button>
                </div>
                <div className="console-msg break">{t.message}</div>
                {t.stack && (
                  <details>
                    <summary className="small">Stack trace</summary>
                    <pre className="code">{t.stack}</pre>
                  </details>
                )}
                {related.length > 0 && (
                  <div className="small">
                    <RelationBadge relation="probable" /> near failed request(s):{' '}
                    {related.map((id) => {
                      const e = data.entries.find((x) => x.id === id);
                      return (
                        <button
                          key={id}
                          type="button"
                          className="link small"
                          onClick={() => props.openEntry(id)}
                        >
                          {e ? `${e.method} ${e.status ?? e.state}` : id.slice(0, 8)}{' '}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
