import { useCallback, useEffect, useMemo, useState } from 'react';
import { isFailure } from '../../analysis/filter';
import type { AdvancedCaptureResult } from '../../shared/messages';
import type { InvestigationAnchor, NetworkEntry } from '../../shared/types';
import { formatBytes, formatDuration } from '../../shared/util';
import { Notice, Tabs } from '../components/common';
import { CommandPalette, ShortcutHelp } from '../components/ui';
import type { Command } from '../components/ui';
import { useAnalysis } from '../lib/analysis';
import { canRequestPermissions, requestPermissionAndStart, sendToWorker } from '../lib/extension';
import { useDataVersion, useSettings } from '../lib/hooks';
import { VIEWS, useRoute } from '../lib/router';
import type { View } from '../lib/router';
import { useSessionData, useSessionMessages } from '../lib/session-data';
import { SHORTCUT_HELP, useShortcuts } from '../lib/shortcuts';
import { useTheme } from '../lib/theme';
import { ConsoleView } from './ConsoleView';
import type { ViewProps } from './context';
import { InvestigationsView } from './InvestigationsView';
import { NetworkView } from './NetworkView';
import { OverviewView } from './OverviewView';
import { RealtimeView } from './RealtimeView';
import { ReplayDialog } from './ReplayDialog';
import { SettingsView } from './SettingsView';
import { TimelineView } from './TimelineView';
import { TracingView } from './TracingView';

const params = new URLSearchParams(location.search);
const embeddedTabId = params.has('tabId') ? Number(params.get('tabId')) : undefined;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function App() {
  const settings = useSettings();
  const version = useDataVersion();
  const [theme, setTheme] = useTheme();
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionId, setSessionId] = useState<string>(params.get('session') ?? '');
  const { route, navigate, setParams } = useRoute(embeddedTabId !== undefined ? 'network' : 'overview');
  const data = useSessionData(sessionId, embeddedTabId, version, reloadKey);
  const messages = useSessionMessages(data.sessionId, !data.loading && route.view !== 'settings', version);
  const analysis = useAnalysis(
    data,
    settings,
    messages,
    route.view !== 'settings' && route.view !== 'realtime',
  );
  const [compareIds, setCompareIds] = useState<{ a?: string; b?: string }>({});
  const [replayEntry, setReplayEntry] = useState<NetworkEntry | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [panelMessage, setPanelMessage] = useState<{
    kind: 'info' | 'error' | 'warning';
    text: string;
  } | null>(null);
  const [panelTabUrl, setPanelTabUrl] = useState<string | undefined>();
  const rec = data.recording;
  const now = useNow(!!rec);

  useEffect(() => {
    if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);
  }, [data.sessionId, sessionId]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const investigate = useCallback(
    (anchor: InvestigationAnchor) =>
      navigate('investigations', { tab: 'workspace', anchor: `${anchor.type}:${anchor.id}` }),
    [navigate],
  );
  const openEntry = useCallback(
    (id: string) => {
      if (!data.entries.some((e) => e.id === id)) setSessionId('all');
      navigate('network', { id });
    },
    [data.entries, navigate],
  );

  // The inspected tab URL must be known before the click: permission prompts need a user gesture.
  useEffect(() => {
    if (embeddedTabId === undefined || typeof chrome.tabs?.get !== 'function') return;
    chrome.tabs.get(embeddedTabId).then(
      (t) => setPanelTabUrl(t.url),
      () => setPanelTabUrl(undefined),
    );
  }, [version, reloadKey]);

  const startFromPanel = () => {
    if (embeddedTabId === undefined) return;
    if (!panelTabUrl) {
      setPanelMessage({
        kind: 'warning',
        text: 'The inspected page URL is not accessible. Start recording from the toolbar popup instead.',
      });
      return;
    }
    requestPermissionAndStart(embeddedTabId, panelTabUrl)
      .then((result) => {
        if (!result.ok) setPanelMessage({ kind: 'error', text: result.message });
        else {
          setPanelMessage({
            kind: 'info',
            text: 'Recording started. Reload the page to capture requests made during page load.',
          });
          setSessionId(result.session.id);
        }
        reload();
      })
      .catch((err: unknown) =>
        setPanelMessage({ kind: 'error', text: String(err instanceof Error ? err.message : err) }),
      );
  };

  const togglePause = async () => {
    if (!rec) return;
    await sendToWorker({ type: rec.paused ? 'resume-recording' : 'pause-recording', tabId: rec.tabId });
    reload();
  };
  const stopRecording = async () => {
    if (!rec) return;
    await sendToWorker({ type: 'stop-recording', tabId: rec.tabId });
    setPanelMessage({
      kind: 'info',
      text: 'Recording stopped. The page and its connections keep running; stored data is kept.',
    });
    reload();
  };
  const toggleAdvanced = () => {
    if (!rec) return;
    const enable = !rec.advanced;
    // Request the optional permission synchronously from the click.
    const ask =
      enable && canRequestPermissions()
        ? chrome.permissions.request({ permissions: ['debugger'] })
        : Promise.resolve(true);
    void ask.then(async (granted) => {
      if (!granted) {
        setPanelMessage({
          kind: 'warning',
          text: 'The “debugger” permission was not granted; advanced capture stays off.',
        });
        return;
      }
      const result = await sendToWorker<AdvancedCaptureResult>({
        type: 'set-advanced-capture',
        tabId: rec.tabId,
        enabled: enable,
      });
      if (!result.ok) setPanelMessage({ kind: 'error', text: result.message });
      else
        setPanelMessage({
          kind: 'info',
          text: enable
            ? 'Advanced capture attached. Chrome shows a debugging banner while it is on; dismissing it turns advanced capture off.'
            : 'Advanced capture turned off.',
        });
      reload();
    });
  };

  const viewProps: ViewProps | null = settings
    ? {
        data,
        settings,
        analysis,
        params: route.params,
        setParams,
        navigate: (view: View, p: Record<string, string> = {}) => navigate(view, p),
        investigate,
        openEntry,
        reload,
        onCompare: (slot, id) => setCompareIds((c) => ({ ...c, [slot]: id })),
        onReplay: setReplayEntry,
        version,
        setSession: setSessionId,
      }
    : null;

  const commands: Command[] = useMemo(
    () => [
      ...VIEWS.map((v) => ({
        id: `go-${v.id}`,
        label: `Go to ${v.label}`,
        hint: `Alt+${v.key}`,
        run: () => navigate(v.id),
      })),
      {
        id: 'search',
        label: 'Search requests',
        hint: '/',
        run: () => {
          navigate('network');
          setTimeout(() => document.querySelector<HTMLInputElement>('input.search')?.focus(), 50);
        },
      },
      { id: 'failed', label: 'Show failed requests', run: () => navigate('network', { problems: '1' }) },
      { id: 'mutations', label: 'Show recent mutations', run: () => navigate('network', { mutations: '1' }) },
      {
        id: 'rt-errors',
        label: 'Show realtime problems',
        run: () => navigate('realtime', { state: 'problems' }),
      },
      {
        id: 'pause',
        label: rec?.paused ? 'Resume recording' : 'Pause recording',
        run: () => void togglePause(),
        disabled: !rec,
      },
      { id: 'stop', label: 'Stop recording', run: () => void stopRecording(), disabled: !rec },
      {
        id: 'advanced',
        label: rec?.advanced ? 'Turn advanced capture off' : 'Turn advanced capture on',
        run: toggleAdvanced,
        disabled: !rec,
      },
      {
        id: 'sync',
        label: 'Sync server traces now',
        run: () => void sendToWorker({ type: 'sync-server-traces' }).then(reload),
      },
      {
        id: 'theme',
        label: `Theme: switch to ${theme === 'dark' ? 'light' : 'dark'}`,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelp(true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec, theme, navigate],
  );

  useShortcuts([
    { keys: 'ctrl+k', description: 'Command palette', global: true, handler: () => setPalette((p) => !p) },
    { keys: '?', description: 'Shortcuts', handler: () => setHelp(true) },
    ...VIEWS.map((v) => ({
      keys: `alt+${v.key}`,
      description: `Go to ${v.label}`,
      global: true,
      handler: () => navigate(v.id),
    })),
  ]);

  if (!settings || !viewProps) return <div className="app-loading">Loading…</div>;

  const failed = data.entries.filter(isFailure).length;
  const stateLabel = rec ? (rec.paused ? 'PAUSED' : 'REC') : null;

  return (
    <div className={`app ${embeddedTabId !== undefined ? 'app-embedded' : ''}`}>
      <header className="app-header">
        <div className="brand">Dev Companion</div>
        <label className="session-picker">
          <span className="muted small">Session</span>
          <select value={data.sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="Session">
            <option value="all">All sessions</option>
            {data.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.endedAt ? '' : ' (active)'}
              </option>
            ))}
          </select>
        </label>
        <div className="recording-bar" role="status" aria-live="polite">
          {data.session && (
            <span className="origin-indicator" title={`Tab ${data.session.tabId}`}>
              {data.session.origin}
              {data.session.imported ? ' · imported' : ''}
            </span>
          )}
          {rec ? (
            <>
              <span
                className={rec.paused ? 'rec-dot rec-paused' : 'rec-dot'}
                title={
                  rec.paused
                    ? 'Capture paused: nothing is recorded until resumed'
                    : 'Recording: continues while this page and the popup are closed'
                }
              >
                {stateLabel}
              </span>
              <span className="muted small" title="Recording duration">
                {formatDuration(now - rec.startedAt).replace(/\.\d+ s$/, ' s')}
              </span>
              <span className="muted small" title="Active capture mechanisms">
                {rec.advanced ? 'page + advanced (CDP)' : 'page recorder'}
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={togglePause}
                title={rec.paused ? 'Resume capture' : 'Pause capture (keeps the session and stored data)'}
              >
                {rec.paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={toggleAdvanced}
                aria-pressed={!!rec.advanced}
                title="chrome.debugger capture: all SSE events, document headers. Shows a Chrome banner."
              >
                Advanced {rec.advanced ? 'on' : 'off'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={stopRecording}
                title="Stop recording this tab (the page and its connections keep running)"
              >
                Stop
              </button>
            </>
          ) : embeddedTabId !== undefined ? (
            canRequestPermissions() && typeof chrome.tabs?.get === 'function' ? (
              <button type="button" className="btn btn-small btn-primary" onClick={startFromPanel}>
                Record this tab
              </button>
            ) : (
              <span className="muted small">Start recording from the toolbar popup</span>
            )
          ) : (
            <span className="muted small">
              {data.session && !data.session.endedAt ? '' : 'Not recording'}
            </span>
          )}
          <span className="counts">
            <strong>{data.entries.length}</strong> requests ·{' '}
            <strong className={failed ? 'text-error' : ''}>{failed}</strong> failed
            {data.connections.length > 0 && (
              <>
                {' '}
                · <strong>{data.connections.length}</strong> connections
              </>
            )}
          </span>
          <span className="muted small" title="Approximate size of all stored requests">
            {data.usage.entryCount} stored · {formatBytes(data.usage.totalBytes)}
          </span>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setPalette(true)}
            title="Command palette (Ctrl+K)"
            aria-label="Command palette"
          >
            ⌘K
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setHelp(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
        </div>
      </header>

      {data.error && (
        <Notice kind="error">
          {data.error}. Try reloading this page; if it persists, storage may be full or disabled for this
          profile.
        </Notice>
      )}
      {data.storageStatus && <Notice kind="warning">Storage: {data.storageStatus.message}</Notice>}
      {panelMessage && <Notice kind={panelMessage.kind}>{panelMessage.text}</Notice>}

      <nav aria-label="Views">
        <Tabs<View>
          active={route.view}
          onChange={(v) => navigate(v)}
          tabs={VIEWS.map((v) => ({
            id: v.id,
            label:
              v.id === 'network' && failed
                ? `${v.label} (${failed} failed)`
                : v.id === 'realtime' && data.connections.length
                  ? `${v.label} (${data.connections.length})`
                  : v.label,
          }))}
        />
      </nav>

      <main className="app-main">
        {data.loading ? (
          <p className="muted pad">Loading…</p>
        ) : route.view === 'overview' ? (
          <OverviewView {...viewProps} />
        ) : route.view === 'network' ? (
          <NetworkView {...viewProps} />
        ) : route.view === 'realtime' ? (
          <RealtimeView {...viewProps} />
        ) : route.view === 'timeline' ? (
          <TimelineView {...viewProps} messages={messages} />
        ) : route.view === 'tracing' ? (
          <TracingView {...viewProps} />
        ) : route.view === 'console' ? (
          <ConsoleView {...viewProps} />
        ) : route.view === 'investigations' ? (
          <InvestigationsView
            {...viewProps}
            compareIds={compareIds}
            setCompareIds={setCompareIds}
            contracts={data.contracts}
          />
        ) : (
          <SettingsView
            settings={settings}
            usage={data.usage}
            contracts={data.contracts}
            theme={theme}
            onTheme={setTheme}
            onChanged={reload}
            section={route.params.section}
          />
        )}
      </main>

      <footer className="app-footer copyright">© 2026 Alaa El-Basuony. All rights reserved.</footer>

      {replayEntry && (
        <ReplayDialog
          entry={replayEntry}
          settings={settings}
          onClose={() => setReplayEntry(null)}
          onCompare={(a, b) => {
            setCompareIds({ a, b });
            setReplayEntry(null);
            navigate('investigations', { tab: 'compare' });
          }}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {help && <ShortcutHelp items={SHORTCUT_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
