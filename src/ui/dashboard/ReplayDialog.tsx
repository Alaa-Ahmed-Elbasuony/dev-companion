import { useEffect, useMemo, useState } from 'react';
import { buildCurl } from '../../analysis/curl';
import { assessReplay, formatHeaderLines, parseHeaderLines } from '../../analysis/replay-safety';
import type { ReplayDraft } from '../../analysis/replay-safety';
import { originToPattern } from '../../background/url-policy';
import type { NetworkEntry, Settings } from '../../shared/types';
import { formatDuration } from '../../shared/util';
import { BodyView } from '../components/CodeView';
import { CopyButton, Modal, Notice, StatusPill } from '../components/common';
import { getStore } from '../lib/extension';
import { executeReplay } from '../lib/replay';

type Step = 'edit' | 'confirm' | 'sending' | 'result';

export function ReplayDialog({
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
  const [step, setStep] = useState<Step>('edit');
  const [method, setMethod] = useState(entry.method);
  const [url, setUrl] = useState(entry.url);
  const [headersText, setHeadersText] = useState(formatHeaderLines(entry.requestHeaders));
  const [body, setBody] = useState('');
  const [bodyNote, setBodyNote] = useState<string | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NetworkEntry | null>(null);

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
  const curl = buildCurl({
    method,
    url,
    headers: assessment.headersToSend,
    body: body === '' ? undefined : body,
  });

  const send = () => {
    if (!assessment.valid || (assessment.requiresAcknowledgement && !acknowledged)) return;
    setError(null);
    // Requested synchronously in the click handler (user gesture required).
    // The extension needs host access to the target to send the request.
    chrome.permissions
      .request({ origins: [originToPattern(assessment.targetOrigin)] })
      .then(async (granted) => {
        if (!granted) {
          setError(
            `Replay needs access to ${assessment.targetOrigin}. Permission was not granted; copy the cURL command instead.`,
          );
          return;
        }
        setStep('sending');
        const replayed = await executeReplay(entry, draft, assessment, settings);
        setResult(replayed);
        setStep('result');
      })
      .catch((err: unknown) => {
        setError(String(err));
        setStep('confirm');
      });
  };

  return (
    <Modal title="Replay request" onClose={onClose}>
      {step === 'edit' && (
        <div className="replay-form">
          <Notice kind="info">
            Replays are never sent automatically. Captured credentials were redacted and are not reused. The
            request is sent from the extension, so cookies, the Origin header and CORS can differ from the
            original.
          </Notice>
          <div className="replay-line">
            <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? null : (
                <option value={method}>{method}</option>
              )}
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
          </div>
          <label>
            Headers (one “Name: value” per line)
            <textarea rows={6} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          </label>
          <label>
            Body
            <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {bodyNote && <Notice kind="warning">{bodyNote}</Notice>}
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
          <div className="modal-actions">
            <CopyButton label="Copy cURL" text={() => curl.command} />
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={errors.length > 0}
              onClick={() => {
                setAcknowledged(false);
                setStep('confirm');
              }}
            >
              Review…
            </button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="replay-confirm">
          <div className="target">
            <div className="muted small">Target origin</div>
            <div className="target-origin">{assessment.targetOrigin}</div>
            <div>
              <strong>{method.toUpperCase()}</strong> <span className="break">{url}</span>
            </div>
          </div>
          {assessment.isMutation && (
            <Notice kind="error">
              <strong>This request may change server data.</strong>
              <ul className="plain">
                {assessment.mutationReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              Replaying an order, payment or deletion can create duplicates or destroy data. Prefer a local or
              staging environment.
            </Notice>
          )}
          <Notice kind="warning">
            <ul className="plain">
              {assessment.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
          <h3>Headers to send</h3>
          {assessment.headersToSend.length ? (
            <ul className="plain mono">
              {assessment.headersToSend.map((h) => (
                <li key={h.name}>
                  {h.name}: {h.value}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None.</p>
          )}
          {assessment.dropped.length > 0 && (
            <>
              <h3>Headers not sent</h3>
              <ul className="plain">
                {assessment.dropped.map((d) => (
                  <li key={d.name}>
                    <code>{d.name}</code> — {d.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {assessment.requiresAcknowledgement && (
            <label className="check ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />{' '}
              I understand this sends a real request to {assessment.targetOrigin} and may change data there.
            </label>
          )}
          {error && <Notice kind="error">{error}</Notice>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setStep('edit')}>
              Back
            </button>
            <span className="spacer" />
            <button
              type="button"
              className={`btn ${assessment.isMutation ? 'btn-danger' : 'btn-primary'}`}
              disabled={!assessment.valid || (assessment.requiresAcknowledgement && !acknowledged)}
              onClick={send}
            >
              Send request
            </button>
          </div>
        </div>
      )}

      {step === 'sending' && <p>Sending…</p>}

      {step === 'result' && result && (
        <div className="replay-result">
          <p>
            <StatusPill entry={result} /> {result.statusText} in {formatDuration(result.duration)}. Saved as a
            replay entry in the same session.
          </p>
          {result.errorMessage && (
            <Notice kind="error">{`${result.errorName}: ${result.errorMessage}`}</Notice>
          )}
          <ReplayResponse id={result.id} />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onCompare(entry.id, result.id)}>
              Compare with original
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function ReplayResponse({ id }: { id: string }) {
  const [body, setBody] = useState<Awaited<ReturnType<Awaited<ReturnType<typeof getStore>>['getBodies']>>>();
  useEffect(() => {
    void getStore()
      .then((s) => s.getBodies(id))
      .then(setBody);
  }, [id]);
  return <BodyView body={body?.response} label="Response" />;
}
