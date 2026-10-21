// Server traces (from the optional server integration) as a waterfall, linked
// to the browser events they belong to, plus browser-observable document
// diagnostics that are available without any server integration.
import { useMemo, useState } from 'react';
import type { ServerSpan, TimelineEvent } from '../../shared/types';
import { formatBytes, formatDuration } from '../../shared/util';
import { CodeBlock, CopyButton, CopyIcon, KeyValueTable, Notice } from '../components/common';
import { Badge, EmptyState, JsonTree, RelationBadge } from '../components/ui';
import { recordForCopy } from '../lib/copy-format';
import { sendToWorker } from '../lib/extension';
import type { ViewProps } from './context';

interface Trace {
  traceId: string;
  spans: ServerSpan[];
  root: ServerSpan;
  start: number;
  end: number;
  errors: number;
}

export const spanFailed = (s: ServerSpan) =>
  s.status === 'error' ||
  (s.outbound && (s.httpStatus ?? 0) >= 400) ||
  (s.httpStatus ?? 0) >= 500 ||
  s.events.some((e) => e.name === 'exception');

function groupTraces(spans: ServerSpan[]): Trace[] {
  const byTrace = new Map<string, ServerSpan[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  return [...byTrace.entries()]
    .map(([traceId, list]) => {
      const sorted = list.sort((a, b) => a.startTime - b.startTime);
      const ids = new Set(sorted.map((s) => s.spanId));
      const root = sorted.find((s) => !s.parentSpanId || !ids.has(s.parentSpanId)) ?? sorted[0]!;
      const start = Math.min(...sorted.map((s) => s.startTime));
      const end = Math.max(...sorted.map((s) => s.endTime ?? s.startTime));
      return { traceId, spans: sorted, root, start, end, errors: sorted.filter(spanFailed).length };
    })
    .sort((a, b) => b.start - a.start);
}

function depthMap(trace: Trace): Map<string, number> {
  const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
  const depth = new Map<string, number>();
  const get = (s: ServerSpan, guard = 0): number => {
    if (depth.has(s.spanId)) return depth.get(s.spanId)!;
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    const d = parent && guard < 50 ? get(parent, guard + 1) + 1 : 0;
    depth.set(s.spanId, d);
    return d;
  };
  trace.spans.forEach((s) => get(s));
  return depth;
}

function DocumentDiagnostics({ events }: { events: TimelineEvent[] }) {
  if (!events.length)
    return <p className="muted small">No document navigation was recorded (reload the recorded page).</p>;
  return (
    <ul className="nav-diag">
      {events
        .slice(-10)
        .reverse()
        .map((e) => (
          <li key={e.id}>
            <div>
              <strong>{new Date(e.timestamp).toLocaleTimeString()}</strong> {e.message}{' '}
              <span className="muted small">{e.pageUrl}</span>{' '}
              {e.source === 'cdp' && <span className="tag">advanced capture</span>}
            </div>
            <div className="muted small">
              {[
                e.data?.status !== undefined && `status ${e.data.status}`,
                e.data?.serverWaitMs !== undefined && `server wait ${e.data.serverWaitMs} ms`,
                e.data?.transferSize !== undefined && `transfer ${formatBytes(Number(e.data.transferSize))}`,
                e.data?.redirectCount ? `${e.data.redirectCount} redirect(s)` : '',
                e.data?.fromCache && 'served from cache',
                e.data?.['next.router'] && `Next.js ${e.data['next.router']} router`,
                e.data?.['next.rendering'] && String(e.data['next.rendering']),
                e.data?.traceId && `trace ${String(e.data.traceId).slice(0, 8)}…`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {Object.entries(e.data ?? {})
              .filter(
                ([k]) =>
                  k.startsWith('server-timing.') || k.startsWith('header.') || k.startsWith('redirect.'),
              )
              .map(([k, v]) => (
                <div key={k} className="mono small">
                  {k}: {String(v)}
                </div>
              ))}
          </li>
        ))}
    </ul>
  );
}

export function TracingView(props: ViewProps) {
  const { data, settings, analysis, params, setParams } = props;
  const origin = data.session?.origin ?? data.recording?.origin;
  const integrations = settings.serverIntegrations.filter(
    (i) => i.enabled && (!origin || i.appOrigin === origin),
  );
  const traces = useMemo(() => groupTraces(data.spans), [data.spans]);
  const errorsOnly = params.status === 'error';
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const selectedSpanParam = params.span;
  const selectedTraceId =
    params.trace ?? (selectedSpanParam ? selectedSpanParam.split(':')[0] : traces[0]?.traceId);
  const trace = traces.find((t) => t.traceId === selectedTraceId);
  const [spanId, setSpanId] = useState<string | null>(selectedSpanParam ?? null);
  const span = trace?.spans.find((s) => s.id === spanId) ?? null;
  const navigations = data.timeline.filter((t) => t.kind === 'navigation');
  const visibleTraces = errorsOnly ? traces.filter((t) => t.errors) : traces;

  const browserLinks = (traceId: string) =>
    analysis?.links.filter(
      (l) => l.to.type === 'trace' && l.to.id === traceId && l.strength !== 'ambiguous',
    ) ?? [];
  const describeBrowser = (ref: { type: string; id: string }) => {
    if (ref.type === 'request') {
      const e = data.entries.find((x) => x.id === ref.id);
      return e ? `${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')} → ${e.status ?? e.state}` : ref.id;
    }
    const t = data.timeline.find((x) => x.id === ref.id);
    return t ? `${t.kind === 'navigation' ? 'document' : t.kind}: ${t.pageUrl}` : ref.id;
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await sendToWorker<{
        ok: boolean;
        status?: Record<string, { ok: boolean; message: string }>;
      }>({ type: 'sync-server-traces' });
      const statuses = Object.values(res.status ?? {});
      setSyncMessage(
        statuses.map((s) => s.message).join(' · ') || 'Nothing to sync (is the application being recorded?)',
      );
      props.reload();
    } catch (err) {
      setSyncMessage(`Sync failed: ${String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  if (!integrations.length) {
    return (
      <div className="tracing pad">
        <EmptyState
          title="Server tracing is not configured"
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => props.navigate('settings', { section: 'integrations' })}
            >
              Set up server tracing
            </button>
          }
        >
          <p>
            Server-side rendering and the server's own outbound requests are invisible to the browser. To see
            them, add the development-only server integration (<code>packages/server-tracer</code>, Next.js
            adapter) to your app and register its local collector in Settings → Integrations.
          </p>
          <p>
            Until then, only the browser-observable information below is available. This is “not
            instrumented”, not “no server activity”.
          </p>
        </EmptyState>
        <section>
          <h2>Document diagnostics (browser-side)</h2>
          <DocumentDiagnostics events={navigations} />
        </section>
      </div>
    );
  }

  return (
    <div className="tracing-layout">
      <div className="filters">
        {integrations.map((i) => {
          const st = data.traceStatus[i.id];
          return (
            <span key={i.id} className="integration-status">
              <Badge tone={st ? (st.ok ? 'ok' : 'error') : 'muted'}>
                {st ? (st.ok ? 'connected' : 'problem') : 'not checked'}
              </Badge>{' '}
              {i.collectorUrl}
              {st && (
                <span className="muted small">
                  {' '}
                  · {st.message} ({new Date(st.at).toLocaleTimeString()})
                </span>
              )}
            </span>
          );
        })}
        <button type="button" className="btn btn-small" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setParams({ ...params, status: e.target.checked ? 'error' : '' })}
          />{' '}
          traces with errors only
        </label>
      </div>
      {syncMessage && <Notice kind="info">{syncMessage}</Notice>}
      {traces.length === 0 ? (
        <div className="pad">
          <EmptyState title="No server spans in this session yet">
            Spans are pulled from the collector shortly after the recorded page navigates or makes requests.
            Check that the dev server runs with <code>DEV_COMPANION_TRACING=1</code> and that the status above
            is “connected”.
          </EmptyState>
          <h2>Document diagnostics (browser-side)</h2>
          <DocumentDiagnostics events={navigations} />
        </div>
      ) : (
        <div className="tracing-split">
          <ul className="trace-list" aria-label="Traces">
            {visibleTraces.map((t) => {
              const links = browserLinks(t.traceId);
              return (
                <li key={t.traceId}>
                  <button
                    type="button"
                    className={`trace ${t.traceId === selectedTraceId ? 'conn-selected' : ''}`}
                    onClick={() => {
                      setParams({ ...params, trace: t.traceId, span: '' });
                      setSpanId(null);
                    }}
                  >
                    <span className="conn-top">
                      {t.errors ? <Badge tone="error">{t.errors} failed</Badge> : <Badge tone="ok">ok</Badge>}
                      <span className="muted small">{formatDuration(t.end - t.start)}</span>
                      <span className="muted small">{t.spans.length} spans</span>
                    </span>
                    <span className="break">{t.root.name}</span>
                    <span className="muted small">
                      {new Date(t.start).toLocaleTimeString()} ·{' '}
                      {links.length ? (
                        <>
                          browser: <RelationBadge relation={links[0]!.strength} />
                        </>
                      ) : (
                        'not linked to a browser event'
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {trace && (
            <section className="waterfall-pane" aria-label="Trace waterfall">
              <h2 className="break">
                {trace.root.name} <span className="muted small mono">trace {trace.traceId}</span>
                <CopyIcon label="Copy trace id" text={() => trace.traceId} />
              </h2>
              <div className="trace-links">
                {browserLinks(trace.traceId).map((l, i) => (
                  <div key={i} className="small">
                    <RelationBadge relation={l.strength} />{' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        l.from.type === 'request'
                          ? props.openEntry(l.from.id)
                          : props.navigate('timeline', { focus: `${l.from.type}:${l.from.id}` })
                      }
                    >
                      {describeBrowser(l.from)}
                    </button>{' '}
                    <span className="muted">— {l.evidence}</span>
                  </div>
                ))}
                {!browserLinks(trace.traceId).length && (
                  <p className="muted small">
                    No browser event carries this trace id and no unambiguous path/time match exists.
                  </p>
                )}
              </div>
              <WaterfallTable trace={trace} selected={spanId} onSelect={setSpanId} />
              {span && (
                <SpanDetails
                  span={span}
                  onInvestigate={() => props.investigate({ type: 'span', id: span.id })}
                />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function WaterfallTable({
  trace,
  selected,
  onSelect,
}: {
  trace: Trace;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const depth = useMemo(() => depthMap(trace), [trace]);
  const total = Math.max(1, trace.end - trace.start);
  return (
    <div className="waterfall" role="table" aria-label="Spans">
      {trace.spans.map((s) => {
        const left = ((s.startTime - trace.start) / total) * 100;
        const width = Math.max(0.6, (((s.endTime ?? s.startTime) - s.startTime) / total) * 100);
        const failed = spanFailed(s);
        return (
          <div
            key={s.id}
            role="row"
            className={`wf-row ${s.id === selected ? 'row-selected' : ''} ${failed ? 'row-error' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="wf-name" style={{ paddingLeft: (depth.get(s.spanId) ?? 0) * 12 }} title={s.name}>
              <span className={`wf-kind wf-${s.outbound ? 'out' : s.kind}`}>
                {s.outbound ? 'server →' : s.kind === 'server' ? 'server ←' : 'internal'}
              </span>{' '}
              {s.name}
              {s.httpStatus !== undefined && (
                <span className={failed ? 'text-error' : 'muted'}> {s.httpStatus}</span>
              )}
              {failed && (
                <span className="sev-icon" aria-label="failed">
                  {' '}
                  ✕
                </span>
              )}
            </span>
            <span className="wf-phase muted small">{s.phase ?? ''}</span>
            <span className="wf-bar-track">
              <span
                className={`wf-bar ${failed ? 'wf-bar-error' : s.outbound ? 'wf-bar-out' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            <span className="wf-dur small">
              {s.duration !== undefined ? formatDuration(s.duration) : 'running'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SpanDetails({ span, onInvestigate }: { span: ServerSpan; onInvestigate: () => void }) {
  return (
    <div className="span-details">
      <div className="details-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={onInvestigate}>
          Investigate
        </button>
        <CopyButton label="Copy span JSON" text={() => JSON.stringify(span, null, 2)} />
      </div>
      <KeyValueTable
        rows={[
          { name: 'Name', value: span.name },
          {
            name: 'Kind',
            value: `${span.kind}${span.outbound ? ' (outbound call made by the server)' : ''}`,
          },
          ...(span.phase ? [{ name: 'Phase', value: span.phase }] : []),
          ...(span.httpUrl
            ? [{ name: 'URL', value: <span className="break">{span.httpUrl}</span>, copy: span.httpUrl }]
            : []),
          ...(span.httpStatus !== undefined ? [{ name: 'Status', value: String(span.httpStatus) }] : []),
          {
            name: 'Span status',
            value: `${span.status}${span.statusMessage ? `: ${span.statusMessage}` : ''}`,
          },
          {
            name: 'Duration',
            value: span.duration !== undefined ? formatDuration(span.duration) : 'not ended',
          },
          {
            name: 'Reported by',
            value: `${span.source}${span.instrumentation ? ` · ${span.instrumentation}` : ''}${span.serviceName ? ` · service ${span.serviceName}` : ''}`,
          },
          { name: 'Span id', value: <code>{span.spanId}</code>, copy: span.spanId },
          { name: 'Trace id', value: <code>{span.traceId}</code>, copy: span.traceId },
        ]}
        copyable
        empty=""
      />
      {span.events.map((e, i) => (
        <Notice key={i} kind={e.name === 'exception' ? 'error' : 'info'}>
          <strong>{e.name}</strong> {String(e.attributes?.['exception.type'] ?? '')}{' '}
          {String(e.attributes?.['exception.message'] ?? '')}
          {e.attributes?.['exception.stacktrace'] && (
            <CodeBlock text={String(e.attributes['exception.stacktrace'])} label="Copy stack trace" raw />
          )}
        </Notice>
      ))}
      {span.requestBody && (
        <>
          <h3>Request body</h3>
          <CodeBlock text={span.requestBody} label="Copy request body" />
        </>
      )}
      {span.responseBody && (
        <>
          <h3>Response body{span.bodyTruncated ? ' (truncated)' : ''}</h3>
          {/^\s*[{[]/.test(span.responseBody) ? (
            <JsonTree text={span.responseBody} />
          ) : (
            <CodeBlock text={span.responseBody} label="Copy response body" />
          )}
        </>
      )}
      <h3 className="section-head">
        Attributes
        {Object.keys(span.attributes).length > 0 && (
          <CopyButton label="Copy as JSON" text={() => recordForCopy(span.attributes)} />
        )}
      </h3>
      <KeyValueTable
        copyable
        rows={Object.entries(span.attributes).map(([name, v]) => ({
          name,
          value: <span className="break">{String(v)}</span>,
          copy: String(v),
        }))}
        empty="No attributes."
      />
      {span.redactions > 0 && (
        <p className="muted small">
          {span.redactions} value(s) were redacted by the server integration or the extension.
        </p>
      )}
    </div>
  );
}
