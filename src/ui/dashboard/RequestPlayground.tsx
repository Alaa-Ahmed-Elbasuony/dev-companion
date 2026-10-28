// Edit a captured request (method, query params, headers, body) and send
// variations of it repeatedly, keeping every response in an attempt history.
// Uses the same safeguards as the Replay dialog: nothing is sent without a
// click, redacted credentials are never reused, and mutations need consent.
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { buildCurl } from '../../analysis/curl';
import { formatJsonBody, splitUrl, withParams } from '../../analysis/request-builder';
import type { ParamRow } from '../../analysis/request-builder';
import { assessReplay, formatHeaderLines, parseHeaderLines } from '../../analysis/replay-safety';
import type { ReplayDraft } from '../../analysis/replay-safety';
import { originToPattern } from '../../background/url-policy';
import type { NetworkEntry, Settings } from '../../shared/types';
import { formatBytes, formatDuration, headerValue, safeUrl } from '../../shared/util';
import { CopyButton, Modal, Notice, StatusPill, Tabs } from '../components/common';
import { getStore } from '../lib/extension';
import { executeReplay } from '../lib/replay';
import { ReplayResponse } from './ReplayDialog';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

type EditorTab = 'params' | 'headers' | 'body';

interface Attempt {
  entry: NetworkEntry;
  draft: ReplayDraft;
  headersText: string;
  params: ParamRow[];
}

export function RequestPlayground({
  entry,
  settings,
  onClose,
  onCompare,
}: {
  entry: NetworkEntry;
  settings: Settings;
  onClose: () => void;
  onCompare: (a: string, b: string) => void;
}) {
  const [tab, setTab] = useState<EditorTab>('params');
  const [method, setMethod] = useState(entry.method);
  const [url, setUrl] = useState(entry.url);
  const [params, setParams] = useState<ParamRow[]>(() => splitUrl(entry.url).params);
  const [headersText, setHeadersText] = useState(formatHeaderLines(entry.requestHeaders));
  const [body, setBody] = useState('');
  const [bodyNote, setBodyNote] = useState<string | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [ackedKey, setAckedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void getStore()
      .then((s) => s.getBodies(entry.id))
      .then((b) => {
        const req = b?.request;
        if (req?.text !== undefined) setBody(req.text);
        if (req && (req.truncated || req.text === undefined) && req.kind !== 'none') {
          setBodyNote(
            `The original request body (${req.kind}) was ${req.truncated ? 'truncated' : 'not captured'}; edit the body before sending.`,
          );
        }
      });
  }, [entry.id]);

  const parsedHeaders = useMemo(() => parseHeaderLines(headersText), [headersText]);
  const draft: ReplayDraft = { method, url, headers: parsedHeaders.headers, body, includeCredentials };
  const assessment = assessReplay(draft, entry.url, settings.redaction);
  const errors = [...parsedHeaders.errors, ...assessment.errors];
  // Consent covers one method + target + cookie choice; changing any of them asks again.
  const ackKey = `${method.toUpperCase()} ${assessment.targetOrigin} ${includeCredentials}`;
  const acknowledged = ackedKey === ackKey;
  const canSend =
    !sending &&
    assessment.valid &&
    errors.length === 0 &&
    (!assessment.requiresAcknowledgement || acknowledged);
  const missingJsonType =
    body.trim() !== '' &&
    formatJsonBody(body) !== null &&
    !headerValue(parsedHeaders.headers, 'content-type');
  const enabledParams = params.filter((p) => p.enabled && p.key !== '').length;
  const selected = attempts.find((a) => a.entry.id === selectedId) ?? attempts[0];

  const editUrl = (next: string) => {
    setUrl(next);
    // Disabled rows are not in the URL, so keep them across URL edits.
    setParams((rows) => [...splitUrl(next).params, ...rows.filter((r) => !r.enabled)]);
  };
  const editParams = (rows: ParamRow[]) => {
    setParams(rows);
    setUrl(withParams(url, rows));
  };
  const updateParam = (i: number, patch: Partial<ParamRow>) =>
    editParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const send = () => {
    if (!canSend) return;
    setError(null);
    const sent = draft;
    const sentAssessment = assessment;
    const snapshot = { headersText, params };
    // Requested synchronously in the click/keydown handler (user gesture required).
    chrome.permissions
      .request({ origins: [originToPattern(assessment.targetOrigin)] })
      .then(async (granted) => {
        if (!granted) {
          setError(
            `Sending needs access to ${sentAssessment.targetOrigin}. Permission was not granted; copy the cURL command instead.`,
          );
          return;
        }
        setSending(true);
        const result = await executeReplay(entry, sent, sentAssessment, settings);
        setAttempts((list) => [{ entry: result, draft: sent, ...snapshot }, ...list]);
        setSelectedId(result.id);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setSending(false));
  };

  const restore = (a: Attempt) => {
    setMethod(a.draft.method);
    setUrl(a.draft.url);
    setParams(a.params);
    setHeadersText(a.headersText);
    setBody(a.draft.body ?? '');
    setIncludeCredentials(a.draft.includeCredentials);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  const curl = () =>
    buildCurl({ method, url, headers: assessment.headersToSend, body: body === '' ? undefined : body })
      .command;

  return (
    <Modal title="Request playground" onClose={onClose} className="modal-wide">
      <div className="playground" onKeyDown={onKeyDown}>
        <div className="replay-line">
          <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
            {METHODS.includes(method) ? null : <option value={method}>{method}</option>}
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input type="text" value={url} onChange={(e) => editUrl(e.target.value)} aria-label="URL" />
          <button
            type="button"
            className={`btn ${assessment.isMutation ? 'btn-danger' : 'btn-primary'}`}
            disabled={!canSend}
            onClick={send}
            title="Send (Ctrl+Enter)"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>

        <Tabs
          tabs={[
            { id: 'params', label: `Params${enabledParams ? ` (${enabledParams})` : ''}` },
            {
              id: 'headers',
              label: `Headers${parsedHeaders.headers.length ? ` (${parsedHeaders.headers.length})` : ''}`,
            },
            { id: 'body', label: body ? 'Body •' : 'Body' },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'params' && (
          <div className="playground-pane">
            {params.length ? (
              <table className="param-table">
                <thead>
                  <tr>
                    <th aria-label="Enabled" />
                    <th>Key</th>
                    <th>Value</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {params.map((p, i) => (
                    <tr key={i} className={p.enabled ? undefined : 'param-off'}>
                      <td>
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) => updateParam(i, { enabled: e.target.checked })}
                          aria-label={`Send ${p.key || 'param'}`}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={p.key}
                          onChange={(e) => updateParam(i, { key: e.target.value })}
                          aria-label={`Param ${i + 1} key`}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={p.value}
                          onChange={(e) => updateParam(i, { value: e.target.value })}
                          aria-label={`Param ${i + 1} value`}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost"
                          onClick={() => editParams(params.filter((_, j) => j !== i))}
                          aria-label={`Remove ${p.key || 'param'}`}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No query params.</p>
            )}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => editParams([...params, { key: '', value: '', enabled: true }])}
            >
              + Add param
            </button>
          </div>
        )}

        {tab === 'headers' && (
          <div className="playground-pane">
            <label>
              Headers (one “Name: value” per line)
              <textarea rows={8} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
            </label>
            {assessment.dropped.length > 0 && (
              <details>
                <summary>
                  {assessment.dropped.length} header{assessment.dropped.length > 1 ? 's' : ''} will not be
                  sent
                </summary>
                <ul className="plain">
                  {assessment.dropped.map((d) => (
                    <li key={d.name}>
                      <code>{d.name}</code> — {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {tab === 'body' && (
          <div className="playground-pane">
            <textarea
              rows={10}
              className="mono"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="Body"
            />
            <div className="playground-actions">
              <button
                type="button"
                className="btn btn-small"
                disabled={formatJsonBody(body) === null}
                onClick={() => setBody(formatJsonBody(body) ?? body)}
              >
                Format JSON
              </button>
              {missingJsonType && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    setHeadersText(
                      (t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}Content-Type: application/json`,
                    )
                  }
                >
                  Add Content-Type: application/json
                </button>
              )}
              {body !== '' && (
                <button type="button" className="btn btn-small" onClick={() => setBody('')}>
                  Clear body
                </button>
              )}
            </div>
            {bodyNote && <Notice kind="warning">{bodyNote}</Notice>}
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={includeCredentials}
            onChange={(e) => setIncludeCredentials(e.target.checked)}
          />{' '}
          Send browser cookies for the target origin (off by default)
        </label>

        {errors.length > 0 && (
          <Notice kind="error">
            <ul className="plain">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        )}
        {assessment.valid && assessment.isMutation && (
          <Notice kind="error">
            <strong>This request may change server data.</strong>
            <ul className="plain">
              {assessment.mutationReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Notice>
        )}
        {assessment.valid && assessment.requiresAcknowledgement && (
          <label className="check ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAckedKey(e.target.checked ? ackKey : null)}
            />{' '}
            I understand this sends real {method.toUpperCase()} requests to {assessment.targetOrigin}
            {assessment.isMutation ? ' and may change data there.' : '.'}
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <details className="muted small">
          <summary>How sending works</summary>
          <ul className="plain">
            {assessment.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>

        <div className="modal-actions">
          <CopyButton label="Copy cURL" text={curl} />
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {attempts.length > 0 && selected && (
          <section className="playground-results" aria-label="Responses">
            <h3>Responses</h3>
            <div className="attempt-list" role="list">
              {attempts.map((a, i) => {
                const u = safeUrl(a.entry.url);
                return (
                  <button
                    key={a.entry.id}
                    type="button"
                    role="listitem"
                    className={`attempt ${a === selected ? 'attempt-active' : ''}`}
                    onClick={() => setSelectedId(a.entry.id)}
                  >
                    <span className="muted">#{attempts.length - i}</span> <StatusPill entry={a.entry} />{' '}
                    <strong>{a.entry.method}</strong>{' '}
                    <span className="break">{u ? `${u.pathname}${u.search}` : a.entry.url}</span>
                  </button>
                );
              })}
            </div>
            <div className="attempt-detail">
              <p>
                <StatusPill entry={selected.entry} /> {selected.entry.statusText} in{' '}
                {formatDuration(selected.entry.duration)} · {formatBytes(selected.entry.responseBodySize)}
              </p>
              {selected.entry.errorMessage && (
                <Notice kind="error">{`${selected.entry.errorName}: ${selected.entry.errorMessage}`}</Notice>
              )}
              <div className="playground-actions">
                <button type="button" className="btn btn-small" onClick={() => restore(selected)}>
                  Load into editor
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onCompare(entry.id, selected.entry.id)}
                >
                  Compare with original
                </button>
              </div>
              {selected.entry.responseHeaders.length > 0 && (
                <details>
                  <summary>Response headers ({selected.entry.responseHeaders.length})</summary>
                  <ul className="plain mono">
                    {selected.entry.responseHeaders.map((h, i) => (
                      <li key={i}>
                        {h.name}: {h.value}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <ReplayResponse key={selected.entry.id} id={selected.entry.id} />
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
