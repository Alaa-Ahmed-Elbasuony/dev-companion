// Request explorer: dense, sortable, filterable list (virtualized) with a
// details panel beside it, so the list keeps its scroll position.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, InputHTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';
import {
  advancedFilterCount,
  filterEntries,
  isFailure,
  parseQuery,
  parseStatusCodes,
  statusClass,
} from '../../analysis/filter';
import type { RequestFilter, StatusFilter } from '../../analysis/filter';
import type { CaptureSource, NetworkEntry } from '../../shared/types';
import { MUTATING_METHODS, formatBytes, formatDuration, safeUrl } from '../../shared/util';
import { MethodTag, Notice, StatusPill, VirtualList } from '../components/common';
import { ActiveFilters, ConfirmDialog, EmptyState } from '../components/ui';
import type { Chip } from '../components/ui';
import { getStore, notifyDataChanged } from '../lib/extension';
import { useShortcuts } from '../lib/shortcuts';
import type { ViewProps } from './context';
import { ExportDialog, importFile } from './io';
import { RequestDetails } from './RequestDetails';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SOURCES: CaptureSource[] = ['fetch', 'xhr', 'beacon', 'replay', 'import', 'cdp'];
const ROW_HEIGHT = 30;
// Details panel width is a per-viewer convenience; storage may be unavailable.
const DETAILS_WIDTH_KEY = 'dc.network.detailsWidth';
const DETAILS_MIN = 320;
const LIST_MIN = 360;

function loadDetailsWidth(): number | undefined {
  try {
    const v = Number(localStorage.getItem(DETAILS_WIDTH_KEY));
    return Number.isFinite(v) && v >= DETAILS_MIN ? v : undefined;
  } catch {
    return undefined;
  }
}

function saveDetailsWidth(width: number | undefined) {
  try {
    if (width === undefined) localStorage.removeItem(DETAILS_WIDTH_KEY);
    else localStorage.setItem(DETAILS_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}
type Sort = 'newest' | 'oldest' | 'slowest' | 'status' | 'method';
const RANGES: { id: string; label: string; ms?: number }[] = [
  { id: '', label: 'All time' },
  { id: '1m', label: 'Last minute', ms: 60_000 },
  { id: '5m', label: 'Last 5 minutes', ms: 300_000 },
  { id: '15m', label: 'Last 15 minutes', ms: 900_000 },
  { id: '1h', label: 'Last hour', ms: 3_600_000 },
];
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All statuses',
  success: '2xx success',
  redirect: '3xx redirect',
  'client-error': '4xx client error',
  'server-error': '5xx server error',
  failed: 'Failed / aborted / incomplete',
  pending: 'Pending',
};

interface NetworkFilter extends RequestFilter {
  problems: boolean;
  mutations: boolean;
  range: string;
}

function numParam(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function kbParam(v: string | undefined): number | undefined {
  const n = numParam(v);
  return n === undefined ? undefined : Math.round(n * 1024);
}

/** Non-negative number from an input, or undefined when empty/invalid. */
function numInput(value: string, scale = 1): number | undefined {
  if (value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * scale) : undefined;
}

const TYPE_PRESETS: { id: string; label: string }[] = [
  { id: '', label: 'All types' },
  { id: 'fetch,xhr', label: 'Fetch/XHR' },
  ...SOURCES.map((s) => ({ id: s, label: `${s} only` })),
];

/** Text input that commits to the URL after a pause, so typing stays responsive. */
function DraftInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return <input {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

function fromParams(p: Record<string, string>, slowMs: number): NetworkFilter {
  const preset = p.preset;
  return {
    text: p.q ?? '',
    methods: p.methods ? p.methods.split(',').filter((m) => METHODS.includes(m)) : [],
    status:
      (p.status as StatusFilter) in STATUS_LABEL
        ? (p.status as StatusFilter)
        : preset === 'pending'
          ? 'pending'
          : 'all',
    sources: p.type
      ? (p.type.split(',').filter((t) => SOURCES.includes(t as CaptureSource)) as CaptureSource[])
      : [],
    minDurationMs: p.min ? Number(p.min) : preset === 'slow' ? slowMs : undefined,
    maxDurationMs: numParam(p.max),
    codes: p.codes ?? '',
    hosts: p.host ?? '',
    contentType: p.ct ?? '',
    minSizeBytes: kbParam(p.minkb),
    maxSizeBytes: kbParam(p.maxkb),
    hasWarnings: p.warn === '1',
    redirected: p.redir === '1',
    problems: p.problems === '1' || preset === 'failed',
    mutations: p.mutations === '1' || preset === 'mutations',
    range: p.range ?? '',
  };
}

function toParams(f: NetworkFilter, extra: Record<string, string>): Record<string, string> {
  return {
    ...extra,
    q: f.text,
    methods: f.methods.join(','),
    status: f.status === 'all' ? '' : f.status,
    type: f.sources.join(','),
    min: f.minDurationMs !== undefined ? String(f.minDurationMs) : '',
    max: f.maxDurationMs !== undefined ? String(f.maxDurationMs) : '',
    codes: f.codes?.trim() ?? '',
    host: f.hosts?.trim() ?? '',
    ct: f.contentType?.trim() ?? '',
    minkb: f.minSizeBytes !== undefined ? String(f.minSizeBytes / 1024) : '',
    maxkb: f.maxSizeBytes !== undefined ? String(f.maxSizeBytes / 1024) : '',
    warn: f.hasWarnings ? '1' : '',
    redir: f.redirected ? '1' : '',
    problems: f.problems ? '1' : '',
    mutations: f.mutations ? '1' : '',
    range: f.range,
  };
}

function sortEntries(list: NetworkEntry[], sort: Sort): NetworkEntry[] {
  const copy = list.slice();
  switch (sort) {
    case 'oldest':
      return copy.sort((a, b) => a.startedAt - b.startedAt);
    case 'slowest':
      return copy.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1));
    case 'status':
      return copy.sort(
        (a, b) => (b.status ?? (isFailure(b) ? 999 : 0)) - (a.status ?? (isFailure(a) ? 999 : 0)),
      );
    case 'method':
      return copy.sort((a, b) => a.method.localeCompare(b.method) || b.startedAt - a.startedAt);
    default:
      return copy.sort((a, b) => b.startedAt - a.startedAt);
  }
}

export function NetworkView(props: ViewProps) {
  const { data, settings, params, setParams } = props;
  const entries = data.entries;
  const filter = useMemo(() => fromParams(params, settings.slowRequestMs), [params, settings.slowRequestMs]);
  const sort = (['newest', 'oldest', 'slowest', 'status', 'method'] as Sort[]).includes(params.sort as Sort)
    ? (params.sort as Sort)
    : 'newest';
  const selectedId = params.id ?? null;
  const [text, setText] = useState(filter.text);
  const [searchBodies, setSearchBodies] = useState(true);
  const advancedCount = advancedFilterCount(filter);
  const [advancedOpen, setAdvancedOpen] = useState(advancedCount > 0);
  const codeErrors = useMemo(() => parseStatusCodes(filter.codes ?? '').invalid, [filter.codes]);
  const knownHosts = useMemo(
    () => [...new Set(entries.map((e) => safeUrl(e.url)?.host).filter((h): h is string => !!h))].sort(),
    [entries],
  );
  const knownContentTypes = useMemo(
    () =>
      [
        ...new Set(
          entries
            .map((e) => e.responseContentType?.split(';')[0]?.trim().toLowerCase())
            .filter((c): c is string => !!c),
        ),
      ].sort(),
    [entries],
  );
  const [bodyMatches, setBodyMatches] = useState<Set<string> | undefined>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'clear' | 'delete'>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'warning'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [detailsWidth, setDetailsWidth] = useState<number | undefined>(loadDetailsWidth);

  const clampWidth = (w: number) => {
    const total = layoutRef.current?.clientWidth ?? window.innerWidth;
    return Math.max(DETAILS_MIN, Math.min(w, total - LIST_MIN));
  };

  const startResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const right = layoutRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    let latest = detailsWidth;
    const onMove = (e: PointerEvent) => {
      latest = clampWidth(right - e.clientX);
      setDetailsWidth(latest);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-resizing');
      saveDetailsWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    document.body.classList.add('is-resizing');
  };

  const resizeBy = (delta: number) => {
    const current = document.querySelector('.details')?.getBoundingClientRect().width ?? DETAILS_MIN;
    const next = clampWidth(current + delta);
    setDetailsWidth(next);
    saveDetailsWidth(next);
  };

  const update = (patch: Partial<NetworkFilter>, extra: Record<string, string> = {}) => {
    const { preset: _preset, ...rest } = params;
    void _preset;
    setParams(toParams({ ...filter, ...patch }, { ...rest, ...extra }));
  };

  // Debounced text filter (and body search) so typing stays responsive on large sessions.
  useEffect(() => setText(filter.text), [filter.text]);
  useEffect(() => {
    if (text === filter.text) return;
    const t = setTimeout(() => update({ text }), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    const query = parseQuery(filter.text).include.join(' ');
    if (!searchBodies || query.length < 2) {
      setBodyMatches(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const store = await getStore();
      const matches = await store.searchBodies(new Set(entries.map((e) => e.id)), query);
      if (!cancelled) setBodyMatches(matches);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter.text, searchBodies, entries]);

  const visible = useMemo(() => {
    const latest = entries.length ? Math.max(...entries.map((e) => e.startedAt)) : 0;
    const range = RANGES.find((r) => r.id === filter.range)?.ms;
    const list = filterEntries(entries, filter, bodyMatches).filter(
      (e) =>
        (!filter.problems || isFailure(e)) &&
        (!filter.mutations || MUTATING_METHODS.has(e.method)) &&
        (!range || e.startedAt >= latest - range),
    );
    return sortEntries(list, sort);
  }, [entries, filter, bodyMatches, sort]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const checkedVisible = visible.filter((e) => checked.has(e.id));
  const select = (id: string | null) => setParams({ ...params, id: id ?? '' });

  useShortcuts([
    {
      keys: 'j',
      description: 'Next request',
      handler: () => {
        const i = visible.findIndex((e) => e.id === selectedId);
        const next = visible[Math.min(visible.length - 1, i + 1)];
        if (next) select(next.id);
      },
    },
    {
      keys: 'k',
      description: 'Previous request',
      handler: () => {
        const i = visible.findIndex((e) => e.id === selectedId);
        const prev = visible[Math.max(0, i - 1)];
        if (prev) select(prev.id);
      },
    },
    { keys: 'Escape', description: 'Close details', handler: () => selectedId && select(null) },
    { keys: '/', description: 'Search', handler: () => searchRef.current?.focus() },
    {
      keys: 'i',
      description: 'Investigate',
      handler: () => selectedId && props.investigate({ type: 'request', id: selectedId }),
    },
  ]);

  // Keep the selected row in view when moving with the keyboard.
  useEffect(() => {
    if (!selectedId) return;
    const index = visible.findIndex((e) => e.id === selectedId);
    const list = document.querySelector('.request-list');
    if (index < 0 || !list) return;
    const top = index * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }, [selectedId, visible]);

  const chips: Chip[] = [];
  if (filter.text)
    chips.push({
      id: 'q',
      label: `“${filter.text}”${searchBodies ? ' (incl. bodies)' : ''}`,
      onRemove: () => update({ text: '' }),
    });
  for (const m of filter.methods)
    chips.push({
      id: `m-${m}`,
      label: m,
      onRemove: () => update({ methods: filter.methods.filter((x) => x !== m) }),
    });
  if (filter.status !== 'all')
    chips.push({
      id: 'status',
      label: STATUS_LABEL[filter.status],
      onRemove: () => update({ status: 'all' }),
    });
  if (filter.sources.length)
    chips.push({
      id: 'type',
      label: `type: ${filter.sources.join(' / ')}`,
      onRemove: () => update({ sources: [] }),
    });
  if (filter.maxDurationMs !== undefined)
    chips.push({
      id: 'max',
      label: `≤ ${filter.maxDurationMs} ms`,
      onRemove: () => update({ maxDurationMs: undefined }),
    });
  if (filter.codes?.trim())
    chips.push({
      id: 'codes',
      label: `status: ${filter.codes.trim()}`,
      onRemove: () => update({ codes: '' }),
    });
  if (filter.hosts?.trim())
    chips.push({ id: 'host', label: `host: ${filter.hosts.trim()}`, onRemove: () => update({ hosts: '' }) });
  if (filter.contentType?.trim())
    chips.push({
      id: 'ct',
      label: `content-type: ${filter.contentType.trim()}`,
      onRemove: () => update({ contentType: '' }),
    });
  if (filter.minSizeBytes !== undefined || filter.maxSizeBytes !== undefined)
    chips.push({
      id: 'size',
      label: [
        'size',
        filter.minSizeBytes !== undefined ? `≥ ${formatBytes(filter.minSizeBytes)}` : '',
        filter.maxSizeBytes !== undefined ? `≤ ${formatBytes(filter.maxSizeBytes)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      onRemove: () => update({ minSizeBytes: undefined, maxSizeBytes: undefined }),
    });
  if (filter.hasWarnings)
    chips.push({ id: 'warn', label: 'has warnings', onRemove: () => update({ hasWarnings: false }) });
  if (filter.redirected)
    chips.push({ id: 'redir', label: 'redirected', onRemove: () => update({ redirected: false }) });
  if (filter.minDurationMs !== undefined)
    chips.push({
      id: 'min',
      label: `≥ ${filter.minDurationMs} ms`,
      onRemove: () => update({ minDurationMs: undefined }),
    });
  if (filter.problems)
    chips.push({ id: 'problems', label: 'failed only', onRemove: () => update({ problems: false }) });
  if (filter.mutations)
    chips.push({ id: 'mutations', label: 'mutations only', onRemove: () => update({ mutations: false }) });
  if (filter.range)
    chips.push({
      id: 'range',
      label: RANGES.find((r) => r.id === filter.range)?.label ?? filter.range,
      onRemove: () => update({ range: '' }),
    });

  const clearAll = () => setParams(selectedId ? { id: selectedId } : {});

  const doDelete = async () => {
    const ids = [...checked];
    setConfirm(null);
    await (await getStore()).deleteEntries(ids);
    setChecked(new Set());
    if (selectedId && checked.has(selectedId)) select(null);
    notifyDataChanged();
    props.reload();
    setNotice({ kind: 'info', text: `Deleted ${ids.length} request(s).` });
  };

  const doClear = async () => {
    setConfirm(null);
    await (await getStore()).clearSession(data.sessionId);
    select(null);
    setChecked(new Set());
    notifyDataChanged();
    props.reload();
  };

  const onImport = async (file: File) => {
    try {
      const result = await importFile(file, settings);
      setNotice({
        kind: 'info',
        text: `Imported ${result.entries} request(s) into a new session${result.skipped ? `; skipped ${result.skipped} invalid record(s)` : ''}. Imported data is treated as untrusted.`,
      });
      props.setSession(result.sessionId);
      props.navigate('network');
    } catch (err) {
      setNotice({
        kind: 'error',
        text: `Import failed: ${err instanceof Error ? err.message : String(err)}. Expected a Dev Companion JSON export or a HAR file.`,
      });
    }
  };

  const presets: { id: string; label: string; active: boolean; apply: () => void }[] = [
    {
      id: 'failed',
      label: 'Failed',
      active: filter.problems,
      apply: () => update({ problems: !filter.problems }),
    },
    {
      id: 'slow',
      label: `Slow ≥ ${settings.slowRequestMs} ms`,
      active: filter.minDurationMs === settings.slowRequestMs,
      apply: () =>
        update({
          minDurationMs: filter.minDurationMs === settings.slowRequestMs ? undefined : settings.slowRequestMs,
        }),
    },
    {
      id: 'mutations',
      label: 'Mutations',
      active: filter.mutations,
      apply: () => update({ mutations: !filter.mutations }),
    },
    {
      id: 'pending',
      label: 'Pending',
      active: filter.status === 'pending',
      apply: () => update({ status: filter.status === 'pending' ? 'all' : 'pending' }),
    },
  ];

  return (
    <div
      ref={layoutRef}
      className="requests-layout"
      style={detailsWidth ? ({ '--details-w': `${detailsWidth}px` } as CSSProperties) : undefined}
    >
      <div className="requests-pane">
        <div className="filters" role="search">
          <input
            ref={searchRef}
            type="search"
            className="search"
            placeholder="Search URL, method, status, request id or body text  ( / )"
            aria-label="Search requests"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label
            className="check"
            title="Also match captured request/response body text (searches IndexedDB)"
          >
            <input
              type="checkbox"
              checked={searchBodies}
              onChange={(e) => setSearchBodies(e.target.checked)}
            />{' '}
            bodies
          </label>
          <div className="chip-group" role="group" aria-label="Saved filters">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip ${p.active ? 'chip-on' : ''}`}
                aria-pressed={p.active}
                onClick={p.apply}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="chip-group" role="group" aria-label="Method filter">
            {METHODS.map((m) => (
              <button
                key={m}
                type="button"
                className={`chip ${filter.methods.includes(m) ? 'chip-on' : ''}`}
                aria-pressed={filter.methods.includes(m)}
                onClick={() =>
                  update({
                    methods: filter.methods.includes(m)
                      ? filter.methods.filter((x) => x !== m)
                      : [...filter.methods, m],
                  })
                }
              >
                {m}
              </button>
            ))}
          </div>
          <select
            aria-label="Status filter"
            value={filter.status}
            onChange={(e) => update({ status: e.target.value as StatusFilter })}
          >
            {Object.entries(STATUS_LABEL).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Type filter"
            value={filter.sources.join(',')}
            onChange={(e) =>
              update({ sources: e.target.value ? (e.target.value.split(',') as CaptureSource[]) : [] })
            }
          >
            {TYPE_PRESETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
            {!TYPE_PRESETS.some((t) => t.id === filter.sources.join(',')) && (
              <option value={filter.sources.join(',')}>{filter.sources.join(' / ')}</option>
            )}
          </select>
          <label className="check">
            ≥
            <input
              type="number"
              min={0}
              step={100}
              className="num"
              placeholder="ms"
              aria-label="Minimum duration in milliseconds"
              value={filter.minDurationMs ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value);
                update({ minDurationMs: v !== undefined && (!Number.isFinite(v) || v < 0) ? undefined : v });
              }}
            />
            ms
          </label>
          <select
            aria-label="Time range"
            value={filter.range}
            onChange={(e) => update({ range: e.target.value })}
          >
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setParams({ ...params, sort: e.target.value })}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="slowest">Slowest first</option>
            <option value="status">Status (errors first)</option>
            <option value="method">Method</option>
          </select>
          <button
            type="button"
            className={`btn btn-small ${advancedCount ? 'btn-primary' : ''}`}
            aria-expanded={advancedOpen}
            aria-controls="advanced-filters"
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            Advanced{advancedCount ? ` (${advancedCount})` : ''} {advancedOpen ? '▴' : '▾'}
          </button>
        </div>

        {advancedOpen && (
          <div id="advanced-filters" className="advanced-filters" role="group" aria-label="Advanced filters">
            <div className="adv-field adv-wide">
              <span className="adv-label">Types</span>
              <div className="chip-group">
                {SOURCES.map((s) => {
                  const on = filter.sources.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`chip ${on ? 'chip-on' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        update({
                          sources: on ? filter.sources.filter((x) => x !== s) : [...filter.sources, s],
                        })
                      }
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="adv-field">
              <span className="adv-label">Status codes</span>
              <DraftInput
                type="text"
                placeholder="200, 4xx, 500-599, !404"
                aria-invalid={codeErrors.length > 0}
                value={filter.codes ?? ''}
                onCommit={(codes) => update({ codes })}
              />
              {codeErrors.length > 0 && <span className="adv-error">Ignored: {codeErrors.join(', ')}</span>}
            </label>
            <label className="adv-field">
              <span className="adv-label">Host contains</span>
              <DraftInput
                type="text"
                list="adv-hosts"
                placeholder="api.example.com, cdn"
                value={filter.hosts ?? ''}
                onCommit={(hosts) => update({ hosts })}
              />
              <datalist id="adv-hosts">
                {knownHosts.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            </label>
            <label className="adv-field">
              <span className="adv-label">Response content type</span>
              <DraftInput
                type="text"
                list="adv-content-types"
                placeholder="json"
                value={filter.contentType ?? ''}
                onCommit={(contentType) => update({ contentType })}
              />
              <datalist id="adv-content-types">
                {knownContentTypes.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <div className="adv-field">
              <span className="adv-label">Duration (ms)</span>
              <div className="adv-range">
                <input
                  type="number"
                  min={0}
                  step={100}
                  placeholder="min"
                  aria-label="Minimum duration in milliseconds"
                  value={filter.minDurationMs ?? ''}
                  onChange={(e) => update({ minDurationMs: numInput(e.target.value) })}
                />
                <span className="muted">–</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  placeholder="max"
                  aria-label="Maximum duration in milliseconds"
                  value={filter.maxDurationMs ?? ''}
                  onChange={(e) => update({ maxDurationMs: numInput(e.target.value) })}
                />
              </div>
            </div>
            <div className="adv-field">
              <span className="adv-label">Response size (KB)</span>
              <div className="adv-range">
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="min"
                  aria-label="Minimum response size in kilobytes"
                  value={filter.minSizeBytes !== undefined ? filter.minSizeBytes / 1024 : ''}
                  onChange={(e) => update({ minSizeBytes: numInput(e.target.value, 1024) })}
                />
                <span className="muted">–</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="max"
                  aria-label="Maximum response size in kilobytes"
                  value={filter.maxSizeBytes !== undefined ? filter.maxSizeBytes / 1024 : ''}
                  onChange={(e) => update({ maxSizeBytes: numInput(e.target.value, 1024) })}
                />
              </div>
            </div>
            <div className="adv-field">
              <span className="adv-label">Only</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!filter.hasWarnings}
                  onChange={(e) => update({ hasWarnings: e.target.checked })}
                />{' '}
                with warnings
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!filter.redirected}
                  onChange={(e) => update({ redirected: e.target.checked })}
                />{' '}
                redirected
              </label>
            </div>
            <div className="adv-footer">
              <span className="muted small">
                Tip: prefix a search word with <code>-</code> to exclude it, e.g. <code>-analytics</code>.
              </span>
              <button
                type="button"
                className="link small"
                disabled={!advancedCount}
                onClick={() =>
                  update({
                    sources: [],
                    maxDurationMs: undefined,
                    codes: '',
                    hosts: '',
                    contentType: '',
                    minSizeBytes: undefined,
                    maxSizeBytes: undefined,
                    hasWarnings: false,
                    redirected: false,
                  })
                }
              >
                Reset advanced
              </button>
            </div>
          </div>
        )}

        <div className="toolbar">
          <ActiveFilters
            chips={chips}
            onClearAll={clearAll}
            shown={visible.length}
            total={entries.length}
            noun="requests"
          />
          {checked.size > 0 && <span className="muted small">· {checked.size} selected</span>}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setExportOpen(true)}
            disabled={!entries.length}
          >
            Export…
          </button>
          <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()}>
            Import…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.har,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void onImport(file);
            }}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setConfirm('delete')}
            disabled={!checked.size}
          >
            Delete selected
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setConfirm('clear')}
            disabled={data.sessionId === 'all' || !entries.length}
            title={
              data.sessionId === 'all'
                ? 'Select a session to clear it (or use Settings → Delete all data)'
                : 'Delete everything recorded in this session'
            }
          >
            Clear session
          </button>
        </div>

        {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

        <div className="list-scroll">
          <div className="list-header" role="row">
            <span className="col-check">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={visible.length > 0 && checkedVisible.length === visible.length}
                onChange={(e) => setChecked(e.target.checked ? new Set(visible.map((v) => v.id)) : new Set())}
              />
            </span>
            <span className="col-method">Method</span>
            <span className="col-status">Status</span>
            <span className="col-url">Endpoint</span>
            <span className="col-type">Type</span>
            <span className="col-dur">Time</span>
            <span className="col-start">Started</span>
          </div>
          {visible.length === 0 ? (
            entries.length === 0 ? (
              <EmptyState title="No requests captured in this view yet.">
                Start recording from the toolbar popup, then reproduce the issue. Reload the page to capture
                requests made during page load.
              </EmptyState>
            ) : (
              <EmptyState
                title="No requests match the current filters."
                action={
                  <button type="button" className="btn btn-small" onClick={clearAll}>
                    Clear all filters
                  </button>
                }
              />
            )
          ) : (
            <VirtualList
              items={visible}
              rowHeight={ROW_HEIGHT}
              className="request-list"
              renderRow={(e) => {
                const u = safeUrl(e.url);
                const mutation = MUTATING_METHODS.has(e.method);
                const cls = statusClass(e);
                return (
                  <div
                    key={e.id}
                    role="row"
                    aria-selected={e.id === selectedId}
                    className={`row ${e.id === selectedId ? 'row-selected' : ''} ${cls === 'failed' || cls === 'server-error' ? 'row-error' : cls === 'client-error' ? 'row-warn-status' : ''}`}
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => select(e.id)}
                  >
                    <span className="col-check" onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Select request"
                        checked={checked.has(e.id)}
                        onChange={(ev) =>
                          setChecked((c) => {
                            const next = new Set(c);
                            if (ev.target.checked) next.add(e.id);
                            else next.delete(e.id);
                            return next;
                          })
                        }
                      />
                    </span>
                    <span className="col-method">
                      <MethodTag method={e.method} />
                      {mutation && (
                        <span
                          className="mutation-dot"
                          title="Mutation: changes server data"
                          aria-label="mutation"
                        >
                          ●
                        </span>
                      )}
                    </span>
                    <span className="col-status">
                      <StatusPill entry={e} />
                    </span>
                    <span className="col-url" title={e.url}>
                      {u ? (
                        <>
                          <span className="url-path">
                            {u.pathname}
                            {u.search}
                          </span>{' '}
                          <span className="muted">{u.host}</span>
                        </>
                      ) : (
                        e.url
                      )}
                      {e.warnings.length > 0 && (
                        <span className="warn-icon" title={e.warnings.join('\n')} aria-label="has warnings">
                          ⚠
                        </span>
                      )}
                    </span>
                    <span className="col-type muted">{e.source}</span>
                    <span
                      className={`col-dur ${(e.duration ?? 0) >= settings.slowRequestMs ? 'text-warn' : ''}`}
                    >
                      {formatDuration(e.duration)}
                    </span>
                    <span className="col-start muted">{new Date(e.startedAt).toLocaleTimeString()}</span>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>

      {selected && (
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize details panel (double-click to reset)"
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setDetailsWidth(undefined);
            saveDetailsWidth(undefined);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
              ev.preventDefault();
              resizeBy((ev.key === 'ArrowLeft' ? 1 : -1) * (ev.shiftKey ? 80 : 20));
            }
          }}
        />
      )}
      {selected && (
        <RequestDetails
          entry={selected}
          data={data}
          analysis={props.analysis}
          onClose={() => select(null)}
          onCompare={props.onCompare}
          onReplay={props.onReplay}
          onPlayground={props.onPlayground}
          onChanged={props.reload}
          onInvestigate={() => props.investigate({ type: 'request', id: selected.id })}
          onOpenRef={(ref) =>
            ref.type === 'request'
              ? select(ref.id)
              : ref.type === 'span'
                ? props.navigate('tracing', { span: ref.id })
                : ref.type === 'rt-message'
                  ? props.navigate('realtime', { message: ref.id })
                  : props.navigate('timeline', { focus: `${ref.type}:${ref.id}` })
          }
        />
      )}

      {exportOpen && (
        <ExportDialog
          entries={checkedVisible.length ? checkedVisible : visible}
          scopeLabel={
            checkedVisible.length
              ? `${checkedVisible.length} selected request(s)`
              : `${visible.length} request(s) currently shown`
          }
          sessions={data.sessions}
          timeline={data.timeline}
          connections={data.connections}
          spans={data.spans}
          settings={settings}
          onClose={() => setExportOpen(false)}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title="Delete selected requests?"
          confirmLabel={`Delete ${checked.size}`}
          danger
          onConfirm={doDelete}
          onCancel={() => setConfirm(null)}
        >
          <p>
            {checked.size} request(s) and their bodies will be removed from this browser. This cannot be
            undone. Recording (if active) continues.
          </p>
        </ConfirmDialog>
      )}
      {confirm === 'clear' && (
        <ConfirmDialog
          title="Clear this session?"
          confirmLabel="Delete session data"
          danger
          onConfirm={doClear}
          onCancel={() => setConfirm(null)}
        >
          <p>
            All requests, timeline events, realtime messages and server spans of this session will be deleted.
            This cannot be undone.
          </p>
          <p className="muted small">
            To keep the data but stop collecting, use Pause or Stop in the header instead.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
