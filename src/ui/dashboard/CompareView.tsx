import { useEffect, useMemo, useRef, useState } from 'react';
import { SUPPORTED_SCHEMA_KEYWORDS } from '../../analysis/contracts';
import { compareEntries, VOLATILE_HEADERS } from '../../analysis/request-diff';
import type { BodyDiff, HeaderDiff } from '../../analysis/request-diff';
import type { ContractBaseline, EntryBodies, NetworkEntry } from '../../shared/types';
import { clip, endpointKey, formatDuration, tryParseJson } from '../../shared/util';
import { CopyButton, CopyIcon, MethodTag, Notice, StatusPill } from '../components/common';
import { getStore, notifyDataChanged } from '../lib/extension';

interface Loaded {
  entry: NetworkEntry;
  bodies: EntryBodies | undefined;
}

const show = (v: unknown) => clip(JSON.stringify(v) ?? 'undefined', 120);

function HeaderDiffTable({ diff, title }: { diff: HeaderDiff; title: string }) {
  const [showVolatile, setShowVolatile] = useState(false);
  const keep = (name: string) => showVolatile || !VOLATILE_HEADERS.has(name);
  const rows = [
    ...diff.added
      .filter((h) => keep(h.name))
      .map((h) => ({ name: h.name, kind: 'added', a: '', b: h.value })),
    ...diff.removed
      .filter((h) => keep(h.name))
      .map((h) => ({ name: h.name, kind: 'removed', a: h.value, b: '' })),
    ...diff.changed
      .filter((h) => keep(h.name))
      .map((h) => ({ name: h.name, kind: 'changed', a: h.before, b: h.after })),
  ];
  return (
    <section className="cmp-section">
      <h3 className="section-head">
        {title} {rows.length > 0 && <CopyButton label="Copy" text={() => JSON.stringify(rows, null, 2)} />}
        <label className="check small">
          <input type="checkbox" checked={showVolatile} onChange={(e) => setShowVolatile(e.target.checked)} />{' '}
          include volatile headers (date, etag…)
        </label>
      </h3>
      {rows.length === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        <table className="diff">
          <thead>
            <tr>
              <th>Header</th>
              <th>Change</th>
              <th>A</th>
              <th>B</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.name}`} className={`diff-${r.kind}`}>
                <td>{r.name}</td>
                <td>{r.kind}</td>
                <td className="break">{r.a}</td>
                <td className="break">{r.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function BodyDiffTable({ diff, title }: { diff: BodyDiff; title: string }) {
  return (
    <section className="cmp-section">
      <h3 className="section-head">
        {title}
        {diff.mode === 'json' && diff.changes.length > 0 && (
          <CopyButton label="Copy" text={() => JSON.stringify(diff.changes, null, 2)} />
        )}
      </h3>
      {diff.mode === 'unavailable' && <p className="muted">{diff.reason}</p>}
      {diff.mode === 'text' && (
        <p>
          {diff.identical
            ? 'Bodies are identical (text comparison).'
            : 'Bodies differ (not JSON; text comparison only).'}
        </p>
      )}
      {diff.mode === 'json' &&
        (diff.changes.length === 0 ? (
          <p className="text-success">JSON is structurally identical.</p>
        ) : (
          <table className="diff">
            <thead>
              <tr>
                <th>Path</th>
                <th>Change</th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {diff.changes.map((c) => (
                <tr key={`${c.kind}-${c.path}`} className={`diff-${c.kind} copy-reveal`}>
                  <td>
                    <code>{c.path}</code>
                    <CopyIcon label="Copy path" text={() => c.path} />
                  </td>
                  <td>
                    {c.kind}
                    {c.kind === 'type-changed' && (
                      <span className="muted small">
                        {' '}
                        {c.beforeType} → {c.afterType}
                      </span>
                    )}
                  </td>
                  <td className="break">{c.kind === 'added' ? '' : show(c.before)}</td>
                  <td className="break">{c.kind === 'removed' ? '' : show(c.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

const PICKER_LIMIT = 50;

/**
 * Searchable list of the session's requests for one compare slot. Requests to
 * the same endpoint as the other side are listed first, newest first within.
 */
function RequestPicker({
  entries,
  other,
  exclude,
  onPick,
  onClose,
}: {
  entries: NetworkEntry[];
  other?: NetworkEntry;
  exclude?: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const otherKey = other ? endpointKey(other.method, other.url) : undefined;
  const matches = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const scored = entries
      .filter((e) => e.id !== exclude)
      .filter((e) => {
        const hay = `${e.method} ${e.status ?? e.state} ${e.url}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .map((e) => ({ entry: e, same: otherKey !== undefined && endpointKey(e.method, e.url) === otherKey }));
    scored.sort((x, y) => Number(y.same) - Number(x.same) || y.entry.startedAt - x.entry.startedAt);
    return scored;
  }, [entries, exclude, otherKey, query]);
  const shown = matches.slice(0, PICKER_LIMIT);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  return (
    <div className="cmp-picker">
      <input
        ref={input}
        type="search"
        placeholder="Filter by method, status or URL…"
        aria-label="Filter requests"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (shown[index]) onPick(shown[index].entry.id);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <ul role="listbox" aria-label="Requests" className="cmp-picker-list">
        {shown.length === 0 && (
          <li className="muted pad-s">
            {entries.length === 0 ? 'No requests in this session.' : 'No matching requests.'}
          </li>
        )}
        {shown.map(({ entry: e, same }, i) => (
          <li
            key={e.id}
            role="option"
            aria-selected={i === index}
            className={i === index ? 'cmp-picker-active' : ''}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onPick(e.id);
            }}
          >
            <MethodTag method={e.method} /> <StatusPill entry={e} /> <span className="break">{e.url}</span>
            <span className="muted small cmp-picker-meta">
              {same && <span className="tag">same endpoint</span>}{' '}
              {new Date(e.startedAt).toLocaleTimeString()} · {formatDuration(e.duration)}
            </span>
          </li>
        ))}
      </ul>
      <div className="cmp-picker-foot muted small">
        {matches.length > PICKER_LIMIT
          ? `Showing ${PICKER_LIMIT} of ${matches.length} — type to narrow down.`
          : `${matches.length} request${matches.length === 1 ? '' : 's'}`}
        <button type="button" className="link small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ContractsPanel({
  contracts,
  suggestedKey,
  onChanged,
}: {
  contracts: ContractBaseline[];
  suggestedKey?: string;
  onChanged: () => void;
}) {
  const [key, setKey] = useState(suggestedKey ?? '');
  const [schemaText, setSchemaText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setKey(suggestedKey ?? ''), [suggestedKey]);

  const save = async () => {
    const parsed = tryParseJson(schemaText);
    if (!key.trim()) return setError('Enter an endpoint key such as "GET api.example.com/api/orders/:id".');
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null)
      return setError('Schema must be a JSON object.');
    await (
      await getStore()
    ).putContract({
      endpointKey: key.trim(),
      kind: 'json-schema',
      schema: parsed.value,
      createdAt: Date.now(),
    });
    setSchemaText('');
    setError(null);
    notifyDataChanged();
    onChanged();
  };

  const remove = async (k: string) => {
    await (await getStore()).deleteContract(k);
    notifyDataChanged();
    onChanged();
  };

  return (
    <section className="cmp-section contracts">
      <h3>API contract baselines</h3>
      <p className="muted small">
        A baseline is checked against every 2xx JSON response of the same endpoint (method + host + path, with
        id-like segments replaced by <code>:id</code>). Results appear in request details and the Error
        Detective.
      </p>
      {contracts.length === 0 ? (
        <p className="muted">
          No baselines yet. Use “Save as baseline” on a request, or add a JSON schema below.
        </p>
      ) : (
        <ul className="contract-list">
          {contracts.map((c) => (
            <li key={c.endpointKey}>
              <code>{c.endpointKey}</code>{' '}
              <span className="tag">{c.kind === 'json-schema' ? 'JSON schema' : 'inferred'}</span>{' '}
              <span className="muted small">{new Date(c.createdAt).toLocaleString()}</span>{' '}
              <button type="button" className="link small" onClick={() => void remove(c.endpointKey)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="schema-form">
        <input
          type="text"
          placeholder="Endpoint key, e.g. GET api.example.com/api/orders/:id"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <textarea
          rows={6}
          placeholder='{"type":"object","required":["id","price"],"properties":{"price":{"type":"number"}}}'
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
        />
        <p className="muted small">
          Supported keywords: {SUPPORTED_SCHEMA_KEYWORDS.join(', ')}. Other keywords are ignored.
        </p>
        {error && <Notice kind="error">{error}</Notice>}
        <button type="button" className="btn btn-small" onClick={save} disabled={!schemaText.trim()}>
          Save JSON schema
        </button>
      </div>
    </section>
  );
}

export function CompareView({
  ids,
  entries,
  onPick,
  onSwap,
  onClear,
  contracts,
  onContractsChanged,
  onOpenEntry,
}: {
  ids: { a?: string; b?: string };
  entries: NetworkEntry[];
  onPick: (slot: 'a' | 'b', id: string) => void;
  onSwap: () => void;
  onClear: () => void;
  contracts: ContractBaseline[];
  onContractsChanged: () => void;
  onOpenEntry: (id: string) => void;
}) {
  const [a, setA] = useState<Loaded | null>(null);
  const [b, setB] = useState<Loaded | null>(null);
  const [picking, setPicking] = useState<'a' | 'b' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (id?: string): Promise<Loaded | null> => {
      if (!id) return null;
      const store = await getStore();
      const entry = await store.getEntry(id);
      return entry ? { entry, bodies: await store.getBodies(id) } : null;
    };
    void Promise.all([load(ids.a), load(ids.b)]).then(([la, lb]) => {
      if (cancelled) return;
      setA(la);
      setB(lb);
    });
    return () => {
      cancelled = true;
    };
  }, [ids.a, ids.b]);

  const comparison = a && b ? compareEntries(a.entry, a.bodies, b.entry, b.bodies) : null;
  const suggestedKey = a ? endpointKey(a.entry.method, a.entry.url) : undefined;

  const slot = (key: 'a' | 'b', loaded: Loaded | null, other: Loaded | null) => {
    const name = key.toUpperCase();
    return (
      <div className="cmp-slot">
        <div className="cmp-slot-head">
          <span className="muted small">Request {name}</span>
          {picking !== key && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setPicking(key)}
              aria-label={`${loaded ? 'Change' : 'Choose'} request ${name}`}
            >
              {loaded ? 'Change' : 'Choose…'}
            </button>
          )}
        </div>
        {picking === key ? (
          <RequestPicker
            entries={entries}
            other={other?.entry}
            exclude={other?.entry.id}
            onPick={(id) => {
              onPick(key, id);
              // Move straight on to the empty side, if any.
              setPicking(other ? null : key === 'a' ? 'b' : 'a');
            }}
            onClose={() => setPicking(null)}
          />
        ) : loaded ? (
          <>
            <button type="button" className="link" onClick={() => onOpenEntry(loaded.entry.id)}>
              <MethodTag method={loaded.entry.method} /> <StatusPill entry={loaded.entry} />{' '}
              <span className="break">{loaded.entry.url}</span>
            </button>
            <div className="muted small">
              {new Date(loaded.entry.startedAt).toLocaleString()} · {loaded.entry.source}
            </div>
          </>
        ) : (
          <span className="muted">Not set — choose a request, or use “Compare as {name}” on one.</span>
        )}
      </div>
    );
  };

  return (
    <div className="compare">
      <div className="cmp-head">
        {slot('a', a, b)}
        {slot('b', b, a)}
        <div className="cmp-actions">
          <button type="button" className="btn btn-small" onClick={onSwap} disabled={!a && !b}>
            Swap
          </button>
          <button type="button" className="btn btn-small" onClick={onClear} disabled={!a && !b}>
            Clear
          </button>
        </div>
      </div>
      {comparison && (
        <>
          <section className="cmp-section">
            <h3>Summary</h3>
            <table className="diff">
              <tbody>
                <tr className={comparison.method.same ? '' : 'diff-changed'}>
                  <th>Method</th>
                  <td>{comparison.method.a}</td>
                  <td>{comparison.method.b}</td>
                </tr>
                <tr className={comparison.url.same ? '' : 'diff-changed'}>
                  <th>URL</th>
                  <td className="break">{comparison.url.a}</td>
                  <td className="break">{comparison.url.b}</td>
                </tr>
                <tr className={comparison.status.same && comparison.state.same ? '' : 'diff-changed'}>
                  <th>Status</th>
                  <td>{comparison.status.a ?? comparison.state.a}</td>
                  <td>{comparison.status.b ?? comparison.state.b}</td>
                </tr>
                <tr>
                  <th>Duration</th>
                  <td>{formatDuration(comparison.duration.a)}</td>
                  <td>
                    {formatDuration(comparison.duration.b)}
                    {comparison.duration.deltaMs !== undefined && (
                      <span className="muted small">
                        {' '}
                        ({comparison.duration.deltaMs >= 0 ? '+' : '−'}
                        {formatDuration(Math.abs(comparison.duration.deltaMs))})
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted small">
              A difference is not proof of a bug: verify the intended API contract before concluding which
              response is wrong.
            </p>
          </section>
          <BodyDiffTable title="Response body" diff={comparison.responseBody} />
          <BodyDiffTable title="Request body" diff={comparison.requestBody} />
          <HeaderDiffTable title="Response headers" diff={comparison.responseHeaders} />
          <HeaderDiffTable title="Request headers" diff={comparison.requestHeaders} />
        </>
      )}
      <ContractsPanel contracts={contracts} suggestedKey={suggestedKey} onChanged={onContractsChanged} />
    </div>
  );
}
