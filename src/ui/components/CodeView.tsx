// JSON pretty-printing with syntax highlighting. Renders text nodes only (no
// innerHTML), so captured or imported content cannot inject markup.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { CapturedBody } from '../../shared/types';
import { formatBytes, tryParseJson } from '../../shared/util';
import { queryForCopy } from '../lib/copy-format';
import { CopyButton, CopyIcon, Notice } from './common';

const HIGHLIGHT_LIMIT = 200_000;
/** Matches beyond this are counted but not marked, so huge bodies stay responsive. */
const MARK_LIMIT = 5_000;
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

interface Segment {
  text: string;
  className?: string;
}

function jsonSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index) });
    if (m[1]) {
      out.push({ text: m[1], className: m[2] ? 'tok-key' : 'tok-string' });
      if (m[2]) out.push({ text: m[2] });
    } else if (m[3]) {
      out.push({ text: m[3], className: 'tok-literal' });
    } else if (m[4]) {
      out.push({ text: m[4], className: 'tok-number' });
    }
    last = index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function highlightJson(text: string): ReactNode[] {
  return jsonSegments(text).map((s, i) =>
    s.className ? (
      <span key={i} className={s.className}>
        {s.text}
      </span>
    ) : (
      s.text
    ),
  );
}

/** Start offsets of every case-insensitive occurrence of `query` in `text`. */
export function findMatches(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * Renders segments with search matches wrapped in <mark>. A match that spans
 * token boundaries is split into several marks that share its index.
 */
function renderWithMatches(
  segments: Segment[],
  matches: number[],
  length: number,
  active: number,
  activeRef: (el: HTMLElement | null) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  const marked = Math.min(matches.length, MARK_LIMIT);
  let m = 0;
  let pos = 0;
  let key = 0;
  for (const seg of segments) {
    const end = pos + seg.text.length;
    const pieces: ReactNode[] = [];
    let cursor = pos;
    while (cursor < end) {
      while (m < marked && matches[m]! + length <= cursor) m++;
      const start = m < marked ? Math.max(matches[m]!, cursor) : end;
      if (start >= end) {
        pieces.push(seg.text.slice(cursor - pos));
        break;
      }
      if (start > cursor) pieces.push(seg.text.slice(cursor - pos, start - pos));
      const stop = Math.min(matches[m]! + length, end);
      const isActive = m === active;
      pieces.push(
        <mark
          key={key++}
          className={isActive ? 'search-hit search-hit-active' : 'search-hit'}
          ref={isActive && start === matches[m] ? activeRef : undefined}
        >
          {seg.text.slice(start - pos, stop - pos)}
        </mark>,
      );
      cursor = stop;
    }
    if (seg.className) {
      out.push(
        <span key={key++} className={seg.className}>
          {pieces}
        </span>,
      );
    } else {
      out.push(...pieces);
    }
    pos = end;
  }
  return out;
}

function CodeSearch({
  query,
  onQuery,
  count,
  active,
  onStep,
}: {
  query: string;
  onQuery: (q: string) => void;
  count: number;
  active: number;
  onStep: (delta: number) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      onQuery('');
    }
  };
  return (
    <div className="code-search" role="search">
      <input
        type="search"
        placeholder="Search body"
        aria-label="Search body"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="muted small code-search-count" aria-live="polite">
        {query ? (count ? `${active + 1} / ${count}` : 'No matches') : ''}
      </span>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!count}
        onClick={() => onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn btn-small btn-ghost"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!count}
        onClick={() => onStep(1)}
      >
        ↓
      </button>
    </div>
  );
}

export function CodeView({ text, json, searchable }: { text: string; json?: boolean; searchable?: boolean }) {
  const [pretty, setPretty] = useState(true);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const activeEl = useRef<HTMLElement | null>(null);
  const parsed = useMemo(() => (json === false ? { ok: false as const } : tryParseJson(text)), [text, json]);
  const display = parsed.ok && pretty ? JSON.stringify(parsed.value, null, 2) : text;
  const matches = useMemo(
    () => (searchable ? findMatches(display, query) : []),
    [searchable, display, query],
  );
  const current = matches.length ? Math.min(active, matches.length - 1) : 0;
  const content = useMemo(() => {
    const highlight = parsed.ok && display.length <= HIGHLIGHT_LIMIT;
    if (!matches.length) return highlight ? highlightJson(display) : display;
    const segments = highlight ? jsonSegments(display) : [{ text: display }];
    return renderWithMatches(segments, matches, query.length, current, (el) => (activeEl.current = el));
  }, [parsed.ok, display, matches, query.length, current]);

  useEffect(() => {
    activeEl.current?.scrollIntoView?.({ block: 'nearest' });
  }, [content]);

  const step = (delta: number) => {
    if (!matches.length) return;
    setActive((current + delta + matches.length) % matches.length);
  };

  return (
    <div className="code-wrap">
      {searchable && (
        <CodeSearch
          query={query}
          onQuery={(q) => {
            setQuery(q);
            setActive(0);
          }}
          count={matches.length}
          active={current}
          onStep={step}
        />
      )}
      <div className="code-body">
        <div className="code-toolbar">
          {parsed.ok && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setPretty((p) => !p)}>
              {pretty ? 'Raw' : 'Pretty'}
            </button>
          )}
          {/* Copies exactly what is shown: pretty or raw. */}
          <CopyIcon label={pretty ? 'Copy' : 'Copy raw'} text={() => display} raw />
        </div>
        <pre className="code">{content}</pre>
      </div>
    </div>
  );
}

/** Decodes a URL-encoded body into ordered fields; returns null if it does not look like one. */
export function parseFormFields(text: string): { name: string; value: string }[] | null {
  if (!text.includes('=') || /\s/.test(text.trim())) return null;
  try {
    return [...new URLSearchParams(text)].map(([name, value]) => ({ name, value }));
  } catch {
    return null;
  }
}

function FormFieldValue({ value }: { value: string }) {
  const parsed = /^\s*[[{]/.test(value) ? tryParseJson(value) : { ok: false as const };
  if (parsed.ok) {
    return <pre className="code code-inline">{highlightJson(JSON.stringify(parsed.value, null, 2))}</pre>;
  }
  return <span className="break">{value === '' ? <span className="muted">(empty)</span> : value}</span>;
}

/** URL-encoded / multipart form bodies as a decoded field table, with a raw toggle. */
export function FormView({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const fields = useMemo(() => parseFormFields(text), [text]);
  if (!fields) return <CodeView text={text} json={false} />;
  return (
    <div className="code-wrap">
      <div className="form-toolbar">
        <span className="muted small">{fields.length} field(s)</span>
        <span>
          <CopyButton label="Copy as JSON" text={() => queryForCopy(fields.map((f) => [f.name, f.value]))} />{' '}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Fields' : 'Raw'}
          </button>
        </span>
      </div>
      {raw ? (
        <pre className="code">{text}</pre>
      ) : (
        <table className="kv form-fields">
          <tbody>
            {fields.map((f, i) => (
              <tr key={`${f.name}-${i}`} className="kv-copyable">
                <th>{f.name}</th>
                <td>
                  <FormFieldValue value={f.value} />
                  <CopyIcon label={`Copy ${f.name}`} text={() => f.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Body text as it should land on the clipboard: JSON pretty-printed, anything else verbatim. */
export function formatBodyForCopy(body: CapturedBody): string {
  const text = body.text ?? '';
  if (body.kind !== 'json' && body.kind !== 'text') return text;
  const parsed = tryParseJson(text);
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
    ? JSON.stringify(parsed.value, null, 2)
    : text;
}

export function BodyView({ body, label }: { body: CapturedBody | undefined; label: string }) {
  if (!body || body.kind === 'none') return <p className="muted">No {label.toLowerCase()} body.</p>;
  return (
    <div className="body-view">
      <div className="body-meta">
        <span className="tag">{body.kind}</span>
        {body.contentType && <span className="muted">{body.contentType}</span>}
        <span className="muted">{formatBytes(body.size)}</span>
        {body.text !== undefined && (
          <CopyButton label={`Copy ${label.toLowerCase()}`} text={() => formatBodyForCopy(body)} />
        )}
      </div>
      {body.truncated && (
        <Notice kind="warning">Truncated: only part of this body was captured. {body.note}</Notice>
      )}
      {!body.truncated && body.note && <Notice kind="info">{body.note}</Notice>}
      {body.text !== undefined ? (
        body.kind === 'form' ? (
          <FormView text={body.text} />
        ) : (
          <CodeView text={body.text} json={body.kind === 'json' || body.kind === 'text'} searchable />
        )
      ) : (
        <p className="muted">Body content was not captured.</p>
      )}
    </div>
  );
}
