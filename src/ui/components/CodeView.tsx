// JSON pretty-printing with syntax highlighting. Renders text nodes only (no
// innerHTML), so captured or imported content cannot inject markup.
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CapturedBody } from '../../shared/types';
import { formatBytes, tryParseJson } from '../../shared/util';
import { queryForCopy } from '../lib/copy-format';
import { CopyButton, CopyIcon, Notice } from './common';

const HIGHLIGHT_LIMIT = 200_000;
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    if (m[1]) {
      out.push(
        <span key={key++} className={m[2] ? 'tok-key' : 'tok-string'}>
          {m[1]}
        </span>,
      );
      if (m[2]) out.push(m[2]);
    } else if (m[3]) {
      out.push(
        <span key={key++} className="tok-literal">
          {m[3]}
        </span>,
      );
    } else if (m[4]) {
      out.push(
        <span key={key++} className="tok-number">
          {m[4]}
        </span>,
      );
    }
    last = index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function CodeView({ text, json }: { text: string; json?: boolean }) {
  const [pretty, setPretty] = useState(true);
  const parsed = useMemo(() => (json === false ? { ok: false as const } : tryParseJson(text)), [text, json]);
  const display = parsed.ok && pretty ? JSON.stringify(parsed.value, null, 2) : text;
  const content = parsed.ok && display.length <= HIGHLIGHT_LIMIT ? highlightJson(display) : display;
  return (
    <div className="code-wrap">
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
          <CodeView text={body.text} json={body.kind === 'json' || body.kind === 'text'} />
        )
      ) : (
        <p className="muted">Body content was not captured.</p>
      )}
    </div>
  );
}
