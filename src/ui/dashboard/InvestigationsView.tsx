// Investigations: rule-based findings, the evidence workspace for one anchor
// event, saved investigations, and request comparison.
import { useEffect, useMemo, useState } from 'react';
import type { Finding } from '../../analysis/error-detector';
import { buildInvestigation } from '../../analysis/investigation';
import type { ChecklistStep, InvestigationResult } from '../../analysis/investigation';
import { buildPlaywrightDraft } from '../../analysis/playwright';
import { buildBugReportJson, buildBugReportMarkdown } from '../../io/bug-report';
import type { ContractBaseline, Investigation, InvestigationAnchor } from '../../shared/types';
import { createId } from '../../shared/util';
import { CopyButton, Notice, Tabs } from '../components/common';
import { Badge, EmptyState, LevelBadge, RelationBadge } from '../components/ui';
import type { Tone } from '../components/ui';
import { downloadText, getStore, notifyDataChanged } from '../lib/extension';
import { CompareView } from './CompareView';
import type { ViewProps } from './context';

type Tab = 'findings' | 'workspace' | 'saved' | 'compare';

const STEP_TONE: Record<ChecklistStep['status'], Tone> = {
  observed: 'ok',
  failed: 'error',
  'not-observed': 'warning',
  'not-instrumented': 'muted',
  unknown: 'muted',
};
const STEP_LABEL: Record<ChecklistStep['status'], string> = {
  observed: 'Observed',
  failed: 'Failed',
  'not-observed': 'Not observed',
  'not-instrumented': 'Not instrumented',
  unknown: 'Unknown',
};

export function parseAnchor(value: string | undefined): InvestigationAnchor | null {
  if (!value) return null;
  const i = value.indexOf(':');
  const type = value.slice(0, i) as InvestigationAnchor['type'];
  const id = value.slice(i + 1);
  return ['request', 'timeline', 'rt-message', 'rt-connection', 'span'].includes(type) && id
    ? { type, id }
    : null;
}

export function InvestigationsView(
  props: ViewProps & {
    compareIds: { a?: string; b?: string };
    setCompareIds: (ids: { a?: string; b?: string }) => void;
    contracts: ContractBaseline[];
  },
) {
  const { params, setParams, analysis } = props;
  const anchor = parseAnchor(params.anchor);
  const tab: Tab = (params.tab as Tab) || (anchor ? 'workspace' : 'findings');
  const setTab = (t: Tab) => setParams({ ...params, tab: t });
  return (
    <div className="investigations">
      <Tabs<Tab>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'findings', label: `Findings${analysis ? ` (${analysis.findings.length})` : ''}` },
          { id: 'workspace', label: 'Workspace' },
          { id: 'saved', label: `Saved (${props.data.investigations.length})` },
          {
            id: 'compare',
            label: `Compare${props.compareIds.a || props.compareIds.b ? ` (${[props.compareIds.a, props.compareIds.b].filter(Boolean).length}/2)` : ''}`,
          },
        ]}
      />
      {tab === 'findings' && <FindingsList {...props} />}
      {tab === 'workspace' &&
        (anchor ? (
          <Workspace {...props} anchor={anchor} />
        ) : (
          <EmptyState title="No event selected">
            Choose “Investigate” on a request, message, console error or span, or pick a finding.
          </EmptyState>
        ))}
      {tab === 'saved' && <SavedList {...props} />}
      {tab === 'compare' && (
        <CompareView
          ids={props.compareIds}
          onSwap={() => props.setCompareIds({ a: props.compareIds.b, b: props.compareIds.a })}
          onClear={() => props.setCompareIds({})}
          contracts={props.contracts}
          onContractsChanged={props.reload}
          onOpenEntry={props.openEntry}
        />
      )}
    </div>
  );
}

function anchorOf(f: Finding): InvestigationAnchor | null {
  if (f.entryIds[0]) return { type: 'request', id: f.entryIds[0] };
  return f.refs?.[0] ?? null;
}

function FindingsList(props: ViewProps & { setCompareIds: (ids: { a?: string; b?: string }) => void }) {
  const { analysis, data, settings } = props;
  const [severity, setSeverity] = useState<'all' | 'error' | 'warning'>('all');
  if (!analysis) return <p className="muted pad">Analyzing…</p>;
  const findings = analysis.findings.filter((f) => severity === 'all' || f.severity === severity);
  return (
    <div className="detective">
      <div className="filters">
        <span className="muted small">
          {analysis.findings.length} finding(s) from {data.entries.length} request(s),{' '}
          {data.connections.length} realtime connection(s) and {data.spans.length} server span(s). Findings
          separate observations from hypotheses.
        </span>
        <span className="spacer" />
        <select
          aria-label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as typeof severity)}
        >
          <option value="all">All severities</option>
          <option value="error">Errors</option>
          <option value="warning">Warnings</option>
        </select>
      </div>
      {findings.length === 0 && (
        <EmptyState title="No issues detected.">
          Checks: HTTP 4xx/5xx, network failures and timeouts, slow requests (≥ {settings.slowRequestMs} ms),
          repeated requests, authentication failures, requests that never finished, contract baselines and
          OpenAPI documents, realtime failures, closes, reconnect storms, duplicate and malformed messages,
          realtime expectations, server span errors, and console errors near failures.
        </EmptyState>
      )}
      <div className="findings">
        {findings.map((f) => {
          const a = anchorOf(f);
          return (
            <article key={f.id} className={`finding finding-${f.severity}`}>
              <header>
                <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                <h3>{f.title}</h3>
                {f.evidenceLevel && <LevelBadge level={f.evidenceLevel} />}
                {a && (
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={() => props.investigate(a)}
                  >
                    Investigate
                  </button>
                )}
              </header>
              <section>
                <h4>Observed</h4>
                <p>{f.observed}</p>
              </section>
              <section>
                <h4>Evidence</h4>
                <ul className="evidence">
                  {f.evidence.map((ev, i) => (
                    <li key={i}>
                      <strong>{ev.label}:</strong> <span className="break">{ev.value}</span>{' '}
                      {ev.entryId && (
                        <button
                          type="button"
                          className="link small"
                          onClick={() => props.openEntry(ev.entryId!)}
                        >
                          open
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>Possible causes</h4>
                <ul className="hypotheses">
                  {(f.hypotheses ?? []).map((h) => (
                    <li key={h.text}>
                      <LevelBadge level={h.level} /> {h.text}{' '}
                      <span className="muted small">— {h.because}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {f.missingEvidence?.length ? (
                <section>
                  <h4>Missing evidence</h4>
                  <ul>
                    {f.missingEvidence.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section>
                <h4>Next steps</h4>
                <ol>
                  {f.nextSteps.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              </section>
              <section className="limitations">
                <h4>Limitations</h4>
                <ul>
                  {f.limitations.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </section>
              {f.kind === 'session-diff' && f.entryIds.length === 2 && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    props.setCompareIds({ a: f.entryIds[0], b: f.entryIds[1] });
                    props.navigate('investigations', { tab: 'compare' });
                  }}
                >
                  Compare these requests
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Workspace(props: ViewProps & { anchor: InvestigationAnchor }) {
  const { analysis, anchor, data, settings } = props;
  const saved = data.investigations.find((i) => i.anchor.type === anchor.type && i.anchor.id === anchor.id);
  const [notes, setNotes] = useState(saved?.notes ?? '');
  const [expected, setExpected] = useState(saved?.expected ?? '');
  const [title, setTitle] = useState(saved?.title ?? '');
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  useEffect(() => {
    setNotes(saved?.notes ?? '');
    setExpected(saved?.expected ?? '');
    setTitle(saved?.title ?? '');
  }, [saved?.id, anchor.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const result: InvestigationResult | null = useMemo(
    () => (analysis ? buildInvestigation(anchor, analysis.data, analysis.links) : null),
    [analysis, anchor],
  );
  if (!analysis) return <p className="muted pad">Analyzing…</p>;
  if (!result) {
    return (
      <EmptyState title="The selected event is not in this session">
        It may have been deleted by retention or belong to another session. Choose “All sessions” in the
        header or pick another event.
      </EmptyState>
    );
  }
  const effectiveTitle = title || result.title;
  const anchorEntry = anchor.type === 'request' ? data.entries.find((e) => e.id === anchor.id) : undefined;
  const navData = [...data.timeline].reverse().find((t) => t.kind === 'navigation');

  const save = async () => {
    const now = Date.now();
    const record: Investigation = {
      id: saved?.id ?? createId(),
      title: effectiveTitle,
      sessionId: data.sessionId === 'all' ? (anchorEntry?.sessionId ?? '') : data.sessionId,
      anchor,
      createdAt: saved?.createdAt ?? now,
      updatedAt: now,
      expected,
      notes,
      pinned: result.related
        .filter((r) => r.relation !== 'probable' && r.ref.type !== 'trace')
        .map((r) => r.ref as InvestigationAnchor),
    };
    try {
      await (await getStore()).putInvestigation(record);
      notifyDataChanged();
      props.reload();
      setMessage({ kind: 'info', text: 'Investigation saved in this browser.' });
    } catch (err) {
      setMessage({ kind: 'error', text: `Could not save: ${String(err)}` });
    }
  };

  const reportInput = async () => {
    const store = await getStore();
    const ids = result.related.filter((r) => r.ref.type === 'request').map((r) => r.ref.id);
    return {
      investigation: result,
      title: effectiveTitle,
      expected,
      notes,
      environment: {
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        origin: data.session?.origin ?? anchorEntry?.origin ?? '',
        pageUrl: anchorEntry?.pageUrl,
        appVersion: navData?.data?.['next.buildId']
          ? `Next.js build ${String(navData.data['next.buildId'])}`
          : undefined,
        serverTracing: analysis.data.serverTracingConfigured ? 'configured' : 'not configured',
        capturedAt: Date.now(),
      },
      entries: data.entries,
      bodies: await store.getBodiesFor(ids),
      timeline: data.timeline,
      redaction: settings.redaction,
    };
  };

  const downloadReport = async (format: 'md' | 'json') => {
    try {
      const input = await reportInput();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'md')
        downloadText(`bug-report-${stamp}.md`, buildBugReportMarkdown(input), 'text/markdown');
      else downloadText(`bug-report-${stamp}.json`, buildBugReportJson(input));
      setMessage({
        kind: 'info',
        text: 'Bug report downloaded. Redaction rules were applied; review it before sharing.',
      });
    } catch (err) {
      setMessage({ kind: 'error', text: `Report failed: ${String(err)}` });
    }
  };

  const playwright = () =>
    buildPlaywrightDraft({
      target: anchorEntry,
      timeline: data.timeline,
      entries: data.entries,
      until: result.related.find((r) => r.relation === 'anchor')?.time ?? Date.now(),
      tabId: anchorEntry?.tabId,
    });

  const openRef = (ref: { type: string; id: string }) => {
    if (ref.type === 'request') props.openEntry(ref.id);
    else if (ref.type === 'span') props.navigate('tracing', { span: ref.id });
    else if (ref.type === 'rt-message') props.navigate('realtime', { message: ref.id });
    else if (ref.type === 'rt-connection') props.navigate('realtime', { conn: ref.id });
    else props.navigate('timeline', { focus: `${ref.type}:${ref.id}` });
  };

  return (
    <div className="workspace">
      <div className="workspace-head">
        <input
          className="ws-title"
          aria-label="Investigation title"
          value={effectiveTitle}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="details-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={save}>
            {saved ? 'Save changes' : 'Save investigation'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => void downloadReport('md')}>
            Create bug report (.md)
          </button>
          <button type="button" className="btn btn-small" onClick={() => void downloadReport('json')}>
            Report as JSON
          </button>
          <CopyButton label="Copy Playwright draft" text={playwright} />
        </div>
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <div className="ws-grid">
        <section className="ws-card">
          <h2>What happened</h2>
          <p>{result.whatHappened}</p>
          {result.divergence ? (
            <div className="divergence">
              <h4>Earliest verified point of divergence</h4>
              <p>
                <LevelBadge level={result.divergence.level} />{' '}
                <button type="button" className="link" onClick={() => openRef(result.divergence!.ref)}>
                  {result.divergence.title}
                </button>{' '}
                <span className="muted small">
                  at {new Date(result.divergence.time).toLocaleTimeString()} — {result.divergence.why}
                </span>
              </p>
            </div>
          ) : (
            <p className="muted small">No failure is linked to this event by evidence.</p>
          )}
          <label className="ws-field">
            Expected behavior
            <textarea
              rows={2}
              placeholder="e.g. The order is created (201) and a confirmation toast appears"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </label>
        </section>

        <section className="ws-card">
          <h2>{result.divergence ? 'Possible causes' : 'Related findings'}</h2>
          {!result.divergence && result.causes.length > 0 && (
            <p className="muted small">
              Nothing linked to this event failed; these findings concern related events.
            </p>
          )}
          {result.causes.length === 0 ? (
            <p className="muted">No rule produced a hypothesis for these events.</p>
          ) : (
            <ol className="hypotheses">
              {result.causes.slice(0, 8).map((c, i) => (
                <li key={`${c.findingId}-${i}`}>
                  <LevelBadge level={c.level} /> {c.text}
                  <div className="muted small">
                    {c.because} · from “{c.findingTitle}”
                  </div>
                </li>
              ))}
            </ol>
          )}
          <h4>Missing evidence</h4>
          {result.missingEvidence.length ? (
            <ul>
              {result.missingEvidence.map((m) => (
                <li key={m}>
                  <Badge tone="muted">missing</Badge> {m}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing identified.</p>
          )}
        </section>

        <section className="ws-card ws-wide">
          <h2>Timeline of related events</h2>
          <ol className="ws-timeline">
            {result.related.map((r) => (
              <li key={`${r.ref.type}:${r.ref.id}`} className={r.failed ? 'ws-failed' : ''}>
                <span className="muted small mono">{new Date(r.time).toLocaleTimeString()}</span>
                <RelationBadge relation={r.relation} />
                {r.failed && <Badge tone="error">failed</Badge>}
                <button type="button" className="link" onClick={() => openRef(r.ref)}>
                  {r.title}
                </button>
                {r.relation !== 'anchor' && <span className="muted small"> — {r.evidence}</span>}
              </li>
            ))}
          </ol>
        </section>

        {result.notificationChecklist && (
          <section className="ws-card ws-wide">
            <h2>Notification checklist</h2>
            <table className="checklist">
              <tbody>
                {result.notificationChecklist.map((s) => (
                  <tr key={s.stage}>
                    <th>{s.stage}</th>
                    <td>
                      <Badge tone={STEP_TONE[s.status]}>{STEP_LABEL[s.status]}</Badge>
                    </td>
                    <td className="small">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              A received message does not prove that the handler ran or that the UI showed anything; those
              stages need the opt-in page adapter.
            </p>
          </section>
        )}

        <section className="ws-card">
          <h2>Next steps</h2>
          {result.nextSteps.length ? (
            <ol>
              {result.nextSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No specific steps.</p>
          )}
          <h4>Regression tests</h4>
          <ul>
            {result.regressionTests.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>

        <section className="ws-card">
          <h2>Reproduction</h2>
          <ol className="plain repro">
            {result.reproduction.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="muted small">
            Steps marked MUTATION create or change server data. Dev Companion never replays them
            automatically.
          </p>
          <label className="ws-field">
            Notes
            <textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What you tried, hypotheses ruled out, links…"
            />
          </label>
        </section>
      </div>
    </div>
  );
}

function SavedList(props: ViewProps) {
  const { data } = props;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!data.investigations.length)
    return (
      <EmptyState title="No saved investigations">
        Open an investigation and choose “Save investigation”. Saved investigations stay in this browser.
      </EmptyState>
    );
  return (
    <ul className="saved-list">
      {data.investigations.map((inv) => (
        <li key={inv.id}>
          <button type="button" className="link" onClick={() => props.investigate(inv.anchor)}>
            {inv.title}
          </button>
          <span className="muted small">
            {' '}
            · updated {new Date(inv.updatedAt).toLocaleString()} · {inv.anchor.type}
          </span>
          {inv.notes && <div className="muted small">{inv.notes.slice(0, 200)}</div>}
          {confirmId === inv.id ? (
            <span className="inline-confirm">
              Delete?
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={async () => {
                  await (await getStore()).deleteInvestigation(inv.id);
                  setConfirmId(null);
                  notifyDataChanged();
                  props.reload();
                }}
              >
                Delete
              </button>
              <button type="button" className="btn btn-small" onClick={() => setConfirmId(null)}>
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-danger-ghost"
              onClick={() => setConfirmId(inv.id)}
            >
              Delete
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
