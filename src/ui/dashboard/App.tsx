import { useCallback, useEffect, useMemo, useState } from 'react';
import { isFailure } from '../../analysis/filter';
import type { AdvancedCaptureResult } from '../../shared/messages';
import type { InvestigationAnchor, NetworkEntry, Session } from '../../shared/types';
import { formatBytes, formatDuration } from '../../shared/util';
import { Notice, Tabs } from '../components/common';
import { SessionPicker } from '../components/SessionPicker';
import { CommandPalette, ShortcutHelp } from '../components/ui';
import { UpdateBanner } from '../components/UpdateBanner';
import type { Command } from '../components/ui';
import { useAnalysis } from '../lib/analysis';
import { canRequestPermissions, requestPermissionAndStart, sendToWorker } from '../lib/extension';
import { useDataVersion, useSettings } from '../lib/hooks';
import { VIEWS, useRoute } from '../lib/router';
import type { View } from '../lib/router';
import { useSessionData, useSessionMessages } from '../lib/session-data';
import { ALL_SITE_DATA_KINDS, SITE_DATA_KINDS, clearSiteData } from '../lib/site-data';
import type { SiteDataKind } from '../lib/site-data';
import { SHORTCUT_HELP, useShortcuts } from '../lib/shortcuts';
import { useTheme } from '../lib/theme';
import { useUpdateStatus } from '../lib/updates';
import { ConsoleView } from './ConsoleView';
import type { ViewProps } from './context';
import { InvestigationsView } from './InvestigationsView';
import { NetworkView } from './NetworkView';
import { OverviewView } from './OverviewView';
import { RealtimeView } from './RealtimeView';
import { ReplayDialog } from './ReplayDialog';
import { RequestPlayground } from './RequestPlayground';
import { SettingsView } from './SettingsView';
import { StorageView } from './StorageView';
import { TimelineView } from './TimelineView';
import { TracingView } from './TracingView';

const params = new URLSearchParams(location.search);
const embeddedTabId = params.has('tabId') ? Number(params.get('tabId')) : undefined;

const CLEAR_KINDS_KEY = 'devcompanion:clearKinds';

/** The header's "clear selected" choice, remembered per browser. */
function loadClearKinds(): SiteDataKind[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CLEAR_KINDS_KEY) ?? 'null') as unknown;
    if (Array.isArray(saved)) return ALL_SITE_DATA_KINDS.filter((k) => saved.includes(k));
  } catch {
    // Storage unavailable or corrupt: fall back to the default.
  }
  return ['cookies', 'localStorage', 'sessionStorage'];
}

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
  const [playgroundEntry, setPlaygroundEntry] = useState<NetworkEntry | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [panelMessage, setPanelMessage] = useState<{
    kind: 'info' | 'error' | 'warning';
    text: string;
  } | null>(null);
  const [panelTabUrl, setPanelTabUrl] = useState<string | undefined>();
  const [clearKinds, setClearKinds] = useState<SiteDataKind[]>(loadClearKinds);
  const [siteDataVersion, setSiteDataVersion] = useState(0);
  const update = useUpdateStatus();
  const rec = data.recording;
  const now = useNow(!!rec);
  // The live tab whose site data the header acts on.
  const targetTabId =
    embeddedTabId ?? rec?.tabId ?? (data.session && !data.session.endedAt ? data.session.tabId : undefined);

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

  // The target tab URL must be known before the click: permission prompts need a user gesture.
  useEffect(() => {
    if (targetTabId === undefined || typeof chrome.tabs?.get !== 'function') {
      setPanelTabUrl(undefined);
      return;
    }
    chrome.tabs.get(targetTabId).then(
      (t) => setPanelTabUrl(t.url),
      () => setPanelTabUrl(undefined),
    );
  }, [targetTabId, version, reloadKey]);

  // Name the browser tab after the site so several dashboards are easy to tell apart.
  const siteHost = useMemo(() => {
    for (const u of [panelTabUrl, data.session?.origin]) {
      try {
        if (u && /^https?:/.test(u)) return new URL(u).host;
      } catch {
        // Try the next source.
      }
    }
    return '';
  }, [panelTabUrl, data.session?.origin]);
  const recordingLive = !!rec && !rec.paused;
  useEffect(() => {
    document.title = siteHost ? `${recordingLive ? '● ' : ''}${siteHost} · Dev Companion` : 'Dev Companion';
  }, [siteHost, recordingLive]);

  const siteDataBlocked =
    targetTabId === undefined
      ? 'No live tab: open the dashboard from a recorded tab or the DevTools panel'
      : !panelTabUrl || !/^https?:/.test(panelTabUrl)
        ? 'Site data is only available on http(s) pages'
        : !canRequestPermissions()
          ? 'Permissions cannot be requested from this page'
          : null;
  const clearData = (kinds: SiteDataKind[]) => {
    if (targetTabId === undefined || !panelTabUrl || !kinds.length) return;
    clearSiteData(targetTabId, panelTabUrl, kinds)
      .then((result) => setPanelMessage({ kind: result.ok ? 'info' : 'warning', text: result.message }))
      .catch((err: unknown) =>
        setPanelMessage({ kind: 'error', text: String(err instanceof Error ? err.message : err) }),
      )
      .finally(() => setSiteDataVersion((v) => v + 1));
  };
  const chooseClearKinds = (kinds: SiteDataKind[]) => {
    setClearKinds(kinds);
    try {
      localStorage.setItem(CLEAR_KINDS_KEY, JSON.stringify(kinds));
    } catch {
      // Not remembered; the choice still applies to this page.
    }
  };
  const toggleClearKind = (kind: SiteDataKind) =>
    chooseClearKinds(
      clearKinds.includes(kind)
        ? clearKinds.filter((k) => k !== kind)
        : ALL_SITE_DATA_KINDS.filter((k) => k === kind || clearKinds.includes(k)),
    );
  const allClearKinds = clearKinds.length === ALL_SITE_DATA_KINDS.length;

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
  const closeSession = (session: Session) => {
    sendToWorker<{ ok: boolean; message?: string }>({ type: 'end-session', sessionId: session.id })
      .then((result) => {
        if (!result.ok)
          setPanelMessage({ kind: 'error', text: result.message ?? 'Could not close the session.' });
        else setPanelMessage({ kind: 'info', text: `Closed ${session.label}. Stored data is kept.` });
        reload();
      })
      .catch((err: unknown) =>
        setPanelMessage({ kind: 'error', text: String(err instanceof Error ? err.message : err) }),
      );
  };
  const toggleAdvanced = () => {
    if (!rec) return;
    const enable = !rec.advanced;
    void (async () => {
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
    })().catch((err: unknown) =>
      setPanelMessage({
        kind: 'error',
        text: `Advanced capture failed: ${String(err instanceof Error ? err.message : err)}`,
      }),
    );
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
        onCompare: (slot, id) => {
          setCompareIds((c) => ({ ...c, [slot]: id }));
          navigate('investigations', { tab: 'compare' });
        },
        onReplay: setReplayEntry,
        onPlayground: setPlaygroundEntry,
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
      ...SITE_DATA_KINDS.map((k) => ({
        id: `clear-${k.kind}`,
        label: `Clear ${k.label.toLowerCase()} for this site`,
        run: () => clearData([k.kind]),
        disabled: !!siteDataBlocked,
      })),
      {
        id: 'clear-selected',
        label: 'Clear selected site data',
        run: () => clearData(clearKinds),
        disabled: !!siteDataBlocked || !clearKinds.length,
      },
      {
        id: 'updates',
        label: 'Check for extension updates',
        run: () => navigate('settings', { section: 'updates' }),
      },
      { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelp(true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec, theme, navigate, targetTabId, panelTabUrl, siteDataBlocked, clearKinds],
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
        <SessionPicker
          value={data.sessionId}
          sessions={data.sessions}
          onChange={setSessionId}
          onClose={closeSession}
        />
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
        <div className="site-data-bar" role="group" aria-label="Clear site data">
          <button
            type="button"
            className="link small"
            onClick={() => navigate('storage')}
            title="See this site's cookies and storage"
          >
            {siteHost || 'Site data'}
          </button>
          <span className="muted small">Clear:</span>
          <div className="chip-group" role="group" aria-label="Data to clear">
            {SITE_DATA_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={`chip ${clearKinds.includes(k.kind) ? 'chip-on' : ''}`}
                aria-pressed={clearKinds.includes(k.kind)}
                disabled={!!siteDataBlocked}
                onClick={() => toggleClearKind(k.kind)}
                title={siteDataBlocked ?? `Include ${k.label.toLowerCase()}`}
              >
                {embeddedTabId !== undefined ? k.short : k.label}
              </button>
            ))}
            <button
              type="button"
              className={`chip ${allClearKinds ? 'chip-on' : ''}`}
              aria-pressed={allClearKinds}
              disabled={!!siteDataBlocked}
              onClick={() => chooseClearKinds(allClearKinds ? [] : ALL_SITE_DATA_KINDS)}
              title={siteDataBlocked ?? (allClearKinds ? 'Deselect all' : 'Select all')}
            >
              All
            </button>
          </div>
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={!!siteDataBlocked || !clearKinds.length}
            onClick={() => clearData(clearKinds)}
            title={
              siteDataBlocked ??
              (clearKinds.length
                ? `Clear ${clearKinds.length} selected type${clearKinds.length === 1 ? '' : 's'} for this site`
                : 'Select what to clear first')
            }
          >
            Clear selected{clearKinds.length ? ` (${clearKinds.length})` : ''}
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
      {update.show && update.status && route.view !== 'settings' && (
        <UpdateBanner status={update.status} onDismiss={update.dismiss} />
      )}

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
        ) : route.view === 'storage' ? (
          <StorageView
            {...viewProps}
            site={{
              tabId: targetTabId,
              url: panelTabUrl,
              host: siteHost,
              blocked: siteDataBlocked,
              version: siteDataVersion,
            }}
          />
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
      {playgroundEntry && (
        <RequestPlayground
          entry={playgroundEntry}
          settings={settings}
          onClose={() => setPlaygroundEntry(null)}
          onCompare={(a, b) => {
            setCompareIds({ a, b });
            setPlaygroundEntry(null);
            navigate('investigations', { tab: 'compare' });
          }}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {help && <ShortcutHelp items={SHORTCUT_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
