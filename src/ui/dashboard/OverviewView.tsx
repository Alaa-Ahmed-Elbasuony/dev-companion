// Answers at a glance: is recording on, what is captured, what failed, are
// connections healthy, is server tracing available, and what to look at next.
// Unavailable sources are shown as unavailable, never as zero.
import { useMemo } from 'react';
import { isFailure } from '../../analysis/filter';
import { formatBytes } from '../../shared/util';
import { Badge, EmptyState, LevelBadge, MetricTile } from '../components/ui';
import { integrationFlags } from '../lib/analysis';
import type { ViewProps } from './context';

export function OverviewView(props: ViewProps) {
  const { data, settings, analysis, navigate } = props;
  const flags = integrationFlags(data, settings);
  const stats = useMemo(() => {
    const failed = data.entries.filter(isFailure).length;
    const slow = data.entries.filter((e) => (e.duration ?? 0) >= settings.slowRequestMs).length;
    const pending = data.entries.filter((e) => e.state === 'pending').length;
    const open = data.connections.filter((c) => c.state === 'open').length;
    const reconnecting = data.connections.filter((c) => c.state === 'reconnecting').length;
    const badConns = data.connections.filter(
      (c) => c.state === 'failed' || (c.closeCode !== undefined && ![1000, 1001, 1005].includes(c.closeCode)),
    ).length;
    const errors = data.timeline.filter(
      (t) => t.kind === 'console-error' || t.kind === 'js-error' || t.kind === 'unhandled-rejection',
    ).length;
    const spanErrors = data.spans.filter(
      (s) => s.status === 'error' || (s.outbound && (s.httpStatus ?? 0) >= 400) || (s.httpStatus ?? 0) >= 500,
    ).length;
    const captureGaps = data.timeline.filter((t) => t.kind === 'capture');
    return { failed, slow, pending, open, reconnecting, badConns, errors, spanErrors, captureGaps };
  }, [data, settings.slowRequestMs]);

  const integration = settings.serverIntegrations.find(
    (i) => i.enabled && (!data.session || i.appOrigin === data.session.origin),
  );
  const traceStatus = integration ? data.traceStatus[integration.id] : undefined;
  const top = analysis?.findings.filter((f) => f.severity !== 'info').slice(0, 5) ?? [];
  const rec = data.recording;

  if (!data.entries.length && !data.connections.length && !data.timeline.length) {
    return (
      <div className="pad">
        <EmptyState
          title={rec ? 'Recording: nothing captured yet' : 'No captured data in this view'}
          action={
            <button type="button" className="btn" onClick={() => navigate('settings')}>
              Open settings
            </button>
          }
        >
          {rec
            ? 'Reproduce the issue in the recorded tab. Reload the page to capture requests made during page load.'
            : 'Start recording from the toolbar popup (or the DevTools panel), then reproduce the issue. Recording continues while the popup is closed.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="overview">
      <section className="overview-section">
        <h2>Capture</h2>
        <div className="metrics">
          <MetricTile
            label="Recording"
            value={rec ? (rec.paused ? 'Paused' : 'On') : 'Off'}
            tone={rec ? (rec.paused ? 'warning' : 'ok') : 'muted'}
            hint={
              rec
                ? `since ${new Date(rec.startedAt).toLocaleTimeString()} · ${rec.advanced ? 'main world + advanced (CDP)' : 'main world'}`
                : data.session?.imported
                  ? 'imported session'
                  : 'not recording this session'
            }
          />
          <MetricTile label="Requests" value={data.entries.length} onClick={() => navigate('network')} />
          <MetricTile
            label="Failed requests"
            value={stats.failed}
            tone={stats.failed ? 'error' : 'ok'}
            onClick={() => navigate('network', { preset: 'failed' })}
          />
          <MetricTile
            label={`Slow (≥ ${settings.slowRequestMs} ms)`}
            value={stats.slow}
            tone={stats.slow ? 'warning' : 'ok'}
            onClick={() => navigate('network', { preset: 'slow' })}
          />
          <MetricTile
            label="Pending"
            value={stats.pending}
            tone={stats.pending ? 'info' : 'muted'}
            onClick={() => navigate('network', { preset: 'pending' })}
          />
          <MetricTile
            label="Console errors"
            value={stats.errors}
            tone={stats.errors ? 'error' : 'ok'}
            onClick={() => navigate('console')}
          />
          <MetricTile
            label="Storage"
            value={formatBytes(data.usage.totalBytes)}
            hint={`${data.usage.entryCount} requests · ${data.messageCount} realtime messages stored`}
            onClick={() => navigate('settings')}
          />
        </div>
      </section>

      <section className="overview-section">
        <h2>Realtime</h2>
        <div className="metrics">
          {settings.captureRealtime ? (
            <>
              <MetricTile
                label="Connections"
                value={data.connections.length}
                onClick={() => navigate('realtime')}
              />
              <MetricTile
                label="Open now"
                value={stats.open}
                tone={stats.open ? 'ok' : 'muted'}
                onClick={() => navigate('realtime', { state: 'open' })}
              />
              <MetricTile
                label="Reconnecting"
                value={stats.reconnecting}
                tone={stats.reconnecting ? 'warning' : 'muted'}
                onClick={() => navigate('realtime', { state: 'reconnecting' })}
              />
              <MetricTile
                label="Failed / abnormal close"
                value={stats.badConns}
                tone={stats.badConns ? 'error' : 'ok'}
                onClick={() => navigate('realtime', { state: 'problems' })}
              />
            </>
          ) : (
            <MetricTile
              label="Realtime capture"
              value=""
              unavailable="Disabled in settings"
              onClick={() => navigate('settings')}
            />
          )}
        </div>
      </section>

      <section className="overview-section">
        <h2>Server / SSR tracing</h2>
        <div className="metrics">
          {integration ? (
            <>
              <MetricTile
                label="Collector"
                value={traceStatus ? (traceStatus.ok ? 'Connected' : 'Problem') : 'Not checked yet'}
                tone={traceStatus ? (traceStatus.ok ? 'ok' : 'error') : 'muted'}
                hint={traceStatus?.message}
                onClick={() => navigate('tracing')}
              />
              <MetricTile
                label="Server spans"
                value={data.spans.length}
                onClick={() => navigate('tracing')}
              />
              <MetricTile
                label="Server errors"
                value={stats.spanErrors}
                tone={stats.spanErrors ? 'error' : 'ok'}
                onClick={() => navigate('tracing', { status: 'error' })}
              />
            </>
          ) : (
            <MetricTile
              label="Server tracing"
              value=""
              unavailable="Not configured"
              hint="Server-side requests are not visible without the optional server integration"
              onClick={() => navigate('tracing')}
            />
          )}
        </div>
      </section>

      {stats.captureGaps.length > 0 && (
        <section className="overview-section">
          <h2>Capture notes</h2>
          <ul className="plain capture-notes">
            {stats.captureGaps.slice(-5).map((t) => (
              <li key={t.id}>
                <Badge tone="warning">{new Date(t.timestamp).toLocaleTimeString()}</Badge> {t.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overview-section">
        <h2>Investigate next</h2>
        {!analysis ? (
          <p className="muted small">Analyzing…</p>
        ) : top.length === 0 ? (
          <p className="muted">
            No errors or warnings found by the checks.{' '}
            {flags.serverTracingConfigured
              ? ''
              : 'Server-side issues are not visible without server tracing.'}
          </p>
        ) : (
          <ul className="next-list">
            {top.map((f) => (
              <li key={f.id}>
                <Badge tone={f.severity === 'error' ? 'error' : 'warning'}>{f.severity}</Badge>
                {f.evidenceLevel && <LevelBadge level={f.evidenceLevel} />}
                <span className="next-title">{f.title}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    f.entryIds[0]
                      ? props.investigate({ type: 'request', id: f.entryIds[0] })
                      : f.refs?.[0]
                        ? props.investigate(f.refs[0])
                        : navigate('investigations')
                  }
                >
                  Investigate
                </button>
              </li>
            ))}
          </ul>
        )}
        {data.investigations.length > 0 && (
          <p className="small">
            <button
              type="button"
              className="link"
              onClick={() => navigate('investigations', { tab: 'saved' })}
            >
              {data.investigations.length} saved investigation(s)
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
