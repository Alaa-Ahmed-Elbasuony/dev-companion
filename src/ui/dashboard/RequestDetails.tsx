import { useEffect, useMemo, useState } from 'react';
import { compareToShape, inferShape, validateJsonSchema } from '../../analysis/contracts';
import type { ContractIssue, Shape } from '../../analysis/contracts';
import { curlForEntry, fetchForEntry } from '../../analysis/curl';
import { validateEntryAgainstOpenApi } from '../../analysis/openapi';
import { redactEntry } from '../../analysis/redaction';
import type { EventRef } from '../../analysis/trace-correlate';
import type { EntryBodies, NetworkEntry } from '../../shared/types';
import {
  MUTATING_METHODS,
  endpointKey,
  formatBytes,
  formatDuration,
  safeUrl,
  tryParseJson,
} from '../../shared/util';
import { BodyView } from '../components/CodeView';
import {
  CodeBlock,
  CopyButton,
  KeyValueTable,
  MethodTag,
  Notice,
  StatusPill,
  Tabs,
} from '../components/common';
import { Badge, RelationBadge } from '../components/ui';
import type { Analysis } from '../lib/analysis';
import { headersForCopy, queryForCopy, rowsForCopy } from '../lib/copy-format';
import { getStore, notifyDataChanged } from '../lib/extension';
import { useDataVersion, useSettings } from '../lib/hooks';
import type { SessionData } from '../lib/session-data';

type DetailTab =
  'overview' | 'headers' | 'query' | 'payload' | 'response' | 'timing' | 'initiator' | 'related';

interface Props {
  entry: NetworkEntry;
  data: SessionData;
  analysis: Analysis | null;
  onClose: () => void;
  onCompare: (slot: 'a' | 'b', id: string) => void;
  onReplay: (entry: NetworkEntry) => void;
  onPlayground: (entry: NetworkEntry) => void;
  onChanged: () => void;
  onInvestigate: () => void;
  onOpenRef: (ref: EventRef) => void;
}

interface RelatedRow {
  ref: EventRef;
  time: number;
  title: string;
  strength: string;
  evidence: string;
}

export function RequestDetails({
  entry,
  data,
  analysis,
  onClose,
  onCompare,
  onReplay,
  onPlayground,
  onChanged,
  onInvestigate,
  onOpenRef,
}: Props) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [bodies, setBodies] = useState<EntryBodies | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const version = useDataVersion();
  const settings = useSettings();

  useEffect(() => {
    let cancelled = false;
    void getStore()
      .then((s) => s.getBodies(entry.id))
      .then((b) => !cancelled && setBodies(b));
    return () => {
      cancelled = true;
    };
  }, [entry.id, entry.state, version]);

  useEffect(() => {
    setMessage(null);
    setConfirmDelete(false);
  }, [entry.id]);

  const url = safeUrl(entry.url);
  const key = endpointKey(entry.method, entry.url);
  const contract = data.contracts.find((c) => c.endpointKey === key && c.kind !== 'openapi');
  const curl = curlForEntry(entry, bodies);
  const fetchCall = fetchForEntry(entry, bodies);
  const responseJson = useMemo(
    () =>
      bodies?.response?.text && !bodies.response.truncated
        ? tryParseJson(bodies.response.text)
        : { ok: false as const },
    [bodies],
  );
  const canBaseline =
    responseJson.ok && entry.status !== undefined && entry.status >= 200 && entry.status < 300;

  const contractIssues: ContractIssue[] | null = useMemo(() => {
    if (!contract || !responseJson.ok || contract.sourceEntryId === entry.id) return null;
    return contract.kind === 'json-schema'
      ? validateJsonSchema(responseJson.value, contract.schema)
      : compareToShape(responseJson.value, contract.schema as Shape);
  }, [contract, responseJson, entry.id]);

  const openApiResults = useMemo(
    () =>
      (analysis?.openApi ?? [])
        .map((doc) => ({ doc, result: validateEntryAgainstOpenApi(entry, bodies, doc) }))
        .filter((r) => r.result.matched),
    [analysis, entry, bodies],
  );

  // Related events: explicit links first, then time-based ones.
  const related: RelatedRow[] = useMemo(() => {
    if (!analysis) return [];
    const rows: RelatedRow[] = [];
    const describe = (ref: EventRef): { time: number; title: string } | null => {
      if (ref.type === 'timeline') {
        const t = data.timeline.find((x) => x.id === ref.id);
        return t ? { time: t.timestamp, title: `${t.kind}: ${t.message}` } : null;
      }
      if (ref.type === 'request') {
        const e = data.entries.find((x) => x.id === ref.id);
        return e
          ? {
              time: e.startedAt,
              title: `${e.method} ${safeUrl(e.url)?.pathname ?? e.url} → ${e.status ?? e.state}`,
            }
          : null;
      }
      if (ref.type === 'rt-message') {
        const m = analysis.data.messages.find((x) => x.id === ref.id);
        const p = m?.decoded?.find((d) => d.category === 'app');
        return m
          ? { time: m.timestamp, title: `realtime ↓ ${p?.name ?? (m.text ?? '').slice(0, 60)}` }
          : null;
      }
      if (ref.type === 'trace') {
        const root = data.spans
          .filter((s) => s.traceId === ref.id)
          .sort((a, b) => a.startTime - b.startTime)[0];
        return root ? { time: root.startTime, title: `server trace: ${root.name}` } : null;
      }
      return null;
    };
    for (const l of analysis.links) {
      const isFrom = l.from.type === 'request' && l.from.id === entry.id;
      const isTo = l.to.type === 'request' && l.to.id === entry.id;
      if (!isFrom && !isTo) continue;
      const other = isFrom ? l.to : l.from;
      const d = describe(other);
      if (d) rows.push({ ref: other, ...d, strength: l.strength, evidence: l.evidence });
    }
    const rank = { explicit: 0, probable: 1, ambiguous: 2 } as Record<string, number>;
    return rows.sort((a, b) => (rank[a.strength] ?? 3) - (rank[b.strength] ?? 3) || a.time - b.time);
  }, [analysis, data, entry.id]);

  const findings = analysis?.findings.filter((f) => f.entryIds.includes(entry.id)) ?? [];

  const saveBaseline = async () => {
    if (!responseJson.ok) return;
    await (
      await getStore()
    ).putContract({
      endpointKey: key,
      kind: 'inferred',
      schema: inferShape(responseJson.value),
      sourceEntryId: entry.id,
      createdAt: Date.now(),
    });
    setMessage(`Saved this response's shape as the baseline for ${key}.`);
    notifyDataChanged();
    onChanged();
  };

  const remove = async () => {
    await (await getStore()).deleteEntries([entry.id]);
    notifyDataChanged();
    onClose();
    onChanged();
  };

  const sanitizedJson = () => {
    if (!settings) return null;
    const r = redactEntry(entry, bodies, settings.redaction);
    return JSON.stringify({ ...r.entry, bodies: r.bodies }, null, 2);
  };

  const overview = [
    { name: 'URL', value: <span className="break">{entry.url}</span>, copy: entry.url },
    ...(entry.finalUrl
      ? [
          {
            name: entry.redirected ? 'Redirected to' : 'Final URL',
            value: <span className="break">{entry.finalUrl}</span>,
            copy: entry.finalUrl,
          },
        ]
      : []),
    {
      name: 'Method',
      value: `${entry.method}${MUTATING_METHODS.has(entry.method) ? ' (mutation: changes server data)' : ''}`,
    },
    {
      name: 'Status',
      value: entry.state === 'complete' ? `${entry.status} ${entry.statusText ?? ''}` : entry.state,
    },
    ...(entry.errorMessage
      ? [{ name: 'Error', value: `${entry.errorName ?? 'Error'}: ${entry.errorMessage}` }]
      : []),
    { name: 'Type', value: entry.source + (entry.replayOf ? ' (replay of an earlier request)' : '') },
    {
      name: 'Started',
      value:
        new Date(entry.startedAt).toLocaleString() + `.${String(entry.startedAt % 1000).padStart(3, '0')}`,
    },
    { name: 'Duration', value: formatDuration(entry.duration) },
    { name: 'Request size', value: formatBytes(entry.requestBodySize) },
    { name: 'Response size', value: formatBytes(entry.responseBodySize) },
    { name: 'Response type', value: entry.responseContentType ?? '—' },
    { name: 'Page', value: <span className="break">{entry.pageUrl}</span>, copy: entry.pageUrl },
    { name: 'Origin / tab', value: `${entry.origin} · tab ${entry.tabId}` },
    { name: 'Request id', value: <code>{entry.id}</code>, copy: entry.id },
  ];

  const overviewText = () =>
    rowsForCopy(
      overview.map((r) => ({ name: r.name, value: r.copy ?? (typeof r.value === 'string' ? r.value : '') })),
    );

  const queryParams = url ? [...url.searchParams] : [];

  const timing = [
    { name: 'Started', value: new Date(entry.startedAt).toLocaleTimeString() },
    ...(entry.responseAt !== undefined
      ? [{ name: 'Waiting for response headers', value: formatDuration(entry.responseAt - entry.startedAt) }]
      : []),
    ...(entry.responseAt !== undefined && entry.endedAt !== undefined
      ? [{ name: 'Body download / read', value: formatDuration(entry.endedAt - entry.responseAt) }]
      : []),
    { name: 'Total', value: formatDuration(entry.duration) },
  ];

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'headers', label: 'Headers' },
    ...(url && [...url.searchParams].length
      ? [{ id: 'query' as const, label: `Query (${[...url.searchParams].length})` }]
      : []),
    ...(entry.requestBodyKind && entry.requestBodyKind !== 'none'
      ? [{ id: 'payload' as const, label: 'Payload' }]
      : []),
    { id: 'response', label: 'Response' },
    { id: 'timing', label: 'Timing' },
    ...(entry.initiatorStack ? [{ id: 'initiator' as const, label: 'Initiator' }] : []),
    { id: 'related', label: `Related${related.length ? ` (${related.length})` : ''}` },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'overview';

  return (
    <aside className="details" aria-label="Request details">
      <div className="details-header">
        <div className="details-title">
          <MethodTag method={entry.method} />
          <StatusPill entry={entry} />
          <span className="break">{url ? `${url.pathname}${url.search}` : entry.url}</span>
        </div>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={onClose}
          aria-label="Close details (Esc)"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="details-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={onInvestigate}
          title="Open the investigation workspace for this request (i)"
        >
          Investigate
        </button>
        <CopyButton label="Copy URL" text={() => entry.url} />
        <CopyButton
          label="Copy cURL"
          text={() => (curl.ok ? curl.command : null)}
          disabledReason={curl.ok ? undefined : curl.reason}
        />
        <CopyButton
          label="Copy as fetch"
          text={() => (fetchCall.ok ? fetchCall.command : null)}
          disabledReason={fetchCall.ok ? undefined : fetchCall.reason}
        />
        <CopyButton label="Copy JSON" text={sanitizedJson} />
        <button type="button" className="btn btn-small" onClick={() => onReplay(entry)}>
          Replay…
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onPlayground(entry)}
          title="Change params, headers, body or method and send variations of this request"
        >
          Try it…
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onCompare('a', entry.id)}
          title="Use as the left side of a comparison"
        >
          Compare as A
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onCompare('b', entry.id)}
          title="Use as the right side of a comparison"
        >
          Compare as B
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={saveBaseline}
          disabled={!canBaseline}
          title={
            canBaseline
              ? `Use this response shape as the baseline for ${key}`
              : 'Needs a complete 2xx JSON response'
          }
        >
          Save as baseline
        </button>
        {confirmDelete ? (
          <span className="inline-confirm">
            Delete this request?
            <button type="button" className="btn btn-small btn-danger" onClick={remove}>
              Delete
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-small btn-danger-ghost"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        )}
      </div>

      {entry.warnings.length > 0 && (
        <Notice kind="warning">
          <ul className="plain">
            {entry.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {entry.redactions > 0 && (
        <Notice kind="info">
          {entry.redactions} sensitive value(s) were removed before this request was stored.
        </Notice>
      )}
      {message && <Notice kind="info">{message}</Notice>}

      <Tabs<DetailTab> active={activeTab} onChange={setTab} tabs={tabs} />
      <div className="details-body">
        {activeTab === 'overview' && (
          <>
            {findings.length > 0 && (
              <div className="finding-mini-list">
                {findings.slice(0, 4).map((f) => (
                  <div key={f.id} className="finding-mini">
                    <Badge
                      tone={f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info'}
                    >
                      {f.severity}
                    </Badge>{' '}
                    {f.title}
                  </div>
                ))}
              </div>
            )}
            <div className="section-actions">
              <CopyButton label="Copy overview" text={overviewText} />
            </div>
            <KeyValueTable rows={overview} empty="" copyable />
            {contract && (
              <div className="contract-box">
                <h3>
                  Contract check · {contract.kind === 'json-schema' ? 'JSON schema' : 'inferred baseline'}
                </h3>
                {contract.sourceEntryId === entry.id ? (
                  <p className="muted">This request is the baseline for {key}.</p>
                ) : contractIssues === null ? (
                  <p className="muted">No complete JSON response to check.</p>
                ) : contractIssues.length === 0 ? (
                  <p className="text-success">
                    ✓ Response matches the {contract.kind === 'json-schema' ? 'schema' : 'baseline shape'}.
                  </p>
                ) : (
                  <ul className="issues">
                    {contractIssues.slice(0, 30).map((i, n) => (
                      <li key={n}>
                        <code>{i.path}</code> <span className={`tag tag-${i.kind}`}>{i.kind}</span>{' '}
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                {contract.kind === 'inferred' && contractIssues?.length ? (
                  <p className="muted small">
                    An inferred baseline is one example response, not a contract. Differences may be
                    legitimate.
                  </p>
                ) : null}
              </div>
            )}
            {openApiResults.map(({ doc, result }) => (
              <div key={doc.title} className="contract-box">
                <h3>
                  OpenAPI · {doc.title} {doc.version} · {result.operation}
                </h3>
                {result.issues.length === 0 ? (
                  <p className="text-success">✓ Request and response match the contract.</p>
                ) : (
                  <ul className="issues">
                    {result.issues.map((i, n) => (
                      <li key={n}>
                        <span className="tag">{i.part}</span> <code>{i.path}</code> {i.message}
                        {i.expected && <span className="muted"> · expected {i.expected}</span>}
                        {i.actual && <span className="muted"> · actual {i.actual}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {result.notes.map((n) => (
                  <p key={n} className="muted small">
                    {n}
                  </p>
                ))}
              </div>
            ))}
          </>
        )}
        {activeTab === 'headers' && (
          <>
            <h3 className="section-head">
              Request headers
              {entry.requestHeaders.length > 0 && (
                <CopyButton label="Copy" text={() => headersForCopy(entry.requestHeaders)} raw />
              )}
            </h3>
            <KeyValueTable
              copyable
              rows={entry.requestHeaders.map((h) => ({
                name: h.name,
                value: <span className="break">{h.value}</span>,
                copy: h.value,
              }))}
              empty="No request headers were set by the page (browser-added headers such as cookies are not visible to page scripts)."
            />
            <h3 className="section-head">
              Response headers
              {entry.responseHeaders.length > 0 && (
                <CopyButton label="Copy" text={() => headersForCopy(entry.responseHeaders)} raw />
              )}
            </h3>
            <KeyValueTable
              copyable
              rows={entry.responseHeaders.map((h) => ({
                name: h.name,
                value: <span className="break">{h.value}</span>,
                copy: h.value,
              }))}
              empty="No response headers (no response, or headers hidden by CORS)."
            />
            {entry.responseHeaders.length > 0 && (
              <p className="muted small">
                Cross-origin responses only expose CORS-safelisted headers and those listed in
                Access-Control-Expose-Headers.
              </p>
            )}
          </>
        )}
        {activeTab === 'query' && (
          <>
            {queryParams.length > 0 && (
              <div className="section-actions">
                <CopyButton label="Copy as JSON" text={() => queryForCopy(queryParams)} />
                <CopyButton label="Copy query string" text={() => url?.search.slice(1) ?? ''} raw />
              </div>
            )}
            <KeyValueTable
              copyable
              rows={queryParams.map(([name, value]) => ({
                name,
                value: <span className="break">{value}</span>,
                copy: value,
              }))}
              empty="No query parameters."
            />
          </>
        )}
        {activeTab === 'payload' && <BodyView body={bodies?.request} label="Request" />}
        {activeTab === 'response' && <BodyView body={bodies?.response} label="Response" />}
        {activeTab === 'timing' && (
          <>
            <div className="section-actions">
              <CopyButton label="Copy timing" text={() => rowsForCopy(timing)} raw />
            </div>
            <KeyValueTable rows={timing} empty="" copyable />
            <p className="muted small">
              Measured in the page with Date.now(); includes queueing and body reading. Network phases (DNS,
              TLS) are not visible to page scripts.
            </p>
          </>
        )}
        {activeTab === 'initiator' && (
          <>
            <p className="muted small">
              Call stack at the moment the request was issued (bundled locations; source maps are not
              applied).
            </p>
            <CodeBlock text={entry.initiatorStack ?? ''} label="Copy stack trace" raw />
          </>
        )}
        {activeTab === 'related' &&
          (!analysis ? (
            <p className="muted">Analyzing…</p>
          ) : related.length ? (
            <ul className="related">
              {related.map((r) => (
                <li key={`${r.ref.type}:${r.ref.id}`}>
                  <RelationBadge relation={r.strength} />
                  <span className="muted small">{new Date(r.time).toLocaleTimeString()}</span>{' '}
                  <button type="button" className="link" onClick={() => onOpenRef(r.ref)}>
                    {r.title}
                  </button>
                  <div className="muted small">{r.evidence}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No related events. Links are made by shared ids (trace/request ids), or by timing for errors
              within 5 s after a failure, clicks just before a request, and realtime messages shortly after a
              mutation.
            </p>
          ))}
      </div>
    </aside>
  );
}
