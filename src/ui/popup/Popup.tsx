import { useCallback, useEffect, useState } from 'react';
import { isFailure } from '../../analysis/filter';
import { checkRecordableUrl } from '../../background/url-policy';
import type { AdvancedCaptureResult } from '../../shared/messages';
import type { RecordingState } from '../../shared/types';
import { Notice } from '../components/common';
import { getStore, getTabState, requestPermissionAndStart, sendToWorker } from '../lib/extension';
import { useDataVersion } from '../lib/hooks';

interface TabInfo {
  id: number;
  url?: string;
}

export function Popup() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [counts, setCounts] = useState({ total: 0, failed: 0, connections: 0, openConnections: 0 });
  const [message, setMessage] = useState<{ kind: 'error' | 'info' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [justStarted, setJustStarted] = useState(false);
  const [marker, setMarker] = useState('');
  const version = useDataVersion();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (t?.id !== undefined) setTab({ id: t.id, url: t.url });
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!tab) return;
    const state = await getTabState(tab.id);
    setRecording(state.recording);
    if (state.recording) {
      const store = await getStore();
      const entries = await store.listEntries({ sessionId: state.recording.sessionId });
      const connections = await store.listConnections({ sessionId: state.recording.sessionId });
      setCounts({
        total: entries.length,
        failed: entries.filter(isFailure).length,
        connections: connections.length,
        openConnections: connections.filter((c) => c.state === 'open').length,
      });
    }
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const policy = checkRecordableUrl(tab?.url);

  const start = () => {
    if (!tab?.url) return;
    setBusy(true);
    setMessage(null);
    requestPermissionAndStart(tab.id, tab.url)
      .then((result) => {
        if (!result.ok) setMessage({ kind: 'error', text: result.message });
        else {
          setJustStarted(true);
          if (!result.injected)
            setMessage({
              kind: 'warning',
              text: 'Recorder could not be injected into the open page. Reload the page.',
            });
        }
        return refresh();
      })
      .catch((err: unknown) => setMessage({ kind: 'error', text: String(err) }))
      .finally(() => setBusy(false));
  };

  const stop = async () => {
    if (!tab) return;
    setBusy(true);
    await sendToWorker({ type: 'stop-recording', tabId: tab.id });
    setJustStarted(false);
    await refresh();
    setBusy(false);
  };

  const addMarker = async () => {
    if (!tab) return;
    const result = await sendToWorker<{ ok: boolean; message?: string }>({
      type: 'add-marker',
      tabId: tab.id,
      label: marker.trim() || 'Marker',
    }).catch((err: unknown) => ({ ok: false, message: String(err) }));
    if (!result?.ok) {
      setMessage({ kind: 'error', text: `Marker not added: ${result?.message ?? 'unknown error'}` });
      return;
    }
    setMarker('');
    setMessage({ kind: 'info', text: 'Marker added to the timeline.' });
  };

  const openExplorer = (hash = '') => {
    const query = recording ? `?session=${encodeURIComponent(recording.sessionId)}` : '';
    void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${query}${hash}`) });
    window.close();
  };

  const togglePause = async () => {
    if (!recording) return;
    setBusy(true);
    await sendToWorker({
      type: recording.paused ? 'resume-recording' : 'pause-recording',
      tabId: recording.tabId,
    });
    await refresh();
    setBusy(false);
  };

  const toggleAdvanced = () => {
    if (!recording) return;
    const enable = !recording.advanced;
    void (async () => {
      const result = await sendToWorker<AdvancedCaptureResult>({
        type: 'set-advanced-capture',
        tabId: recording.tabId,
        enabled: enable,
      });
      setMessage(
        result.ok
          ? {
              kind: 'info',
              text: enable
                ? 'Advanced capture on. Chrome shows a debugging banner; dismissing it turns advanced capture off.'
                : 'Advanced capture off.',
            }
          : { kind: 'error', text: result.message },
      );
      await refresh();
    })().catch((err: unknown) =>
      setMessage({
        kind: 'error',
        text: `Advanced capture failed: ${String(err instanceof Error ? err.message : err)}`,
      }),
    );
  };

  return (
    <div className="popup-root">
      <header className="popup-header">
        <strong>Dev Companion</strong>
        {recording && (
          <span className={recording.paused ? 'rec-dot rec-paused' : 'rec-dot'}>
            {recording.paused ? 'PAUSED' : 'REC'}
          </span>
        )}
      </header>

      <section className="popup-section">
        <div className="muted small">Current tab</div>
        <div className="origin" title={tab?.url}>
          {policy.ok ? policy.origin : (tab?.url ?? '…')}
        </div>
      </section>

      {!policy.ok && tab && <Notice kind="info">{policy.message}</Notice>}

      {policy.ok && (
        <section className="popup-section">
          {recording ? (
            <>
              <div className="stat-row">
                <button
                  type="button"
                  className="stat-link"
                  onClick={() => openExplorer('#network')}
                  title="Open the request list"
                >
                  <strong>{counts.total}</strong> requests
                </button>
                <button
                  type="button"
                  className={`stat-link ${counts.failed ? 'text-error' : ''}`}
                  onClick={() => openExplorer('#network?problems=1')}
                  title="Open failed requests"
                >
                  <strong>{counts.failed}</strong> failed
                </button>
                {counts.connections > 0 && (
                  <button
                    type="button"
                    className="stat-link"
                    onClick={() => openExplorer('#realtime')}
                    title="Open realtime connections"
                  >
                    <strong>{counts.openConnections}</strong>/{counts.connections} connections open
                  </button>
                )}
              </div>
              <p className="muted small">
                Since {new Date(recording.startedAt).toLocaleTimeString()}. Recording continues while this
                popup is closed.
                {recording.paused ? ' Paused: nothing is captured until you resume.' : ''}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={togglePause}
                  title="Pause keeps the session and stored data"
                >
                  {recording.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={stop}
                  title="The page and its connections keep running"
                >
                  Stop recording
                </button>
              </div>
              <label
                className="check small"
                title="chrome.debugger: sees all SSE event types and document headers; Chrome shows a debugging banner"
              >
                <input type="checkbox" checked={!!recording.advanced} onChange={toggleAdvanced} /> Advanced
                capture (debugger)
              </label>
              {justStarted && (
                <div className="notice notice-info">
                  Requests made before recording started were not captured. To capture page-load requests and
                  console messages,{' '}
                  <button type="button" className="link" onClick={() => void chrome.tabs.reload(tab!.id)}>
                    reload the page
                  </button>
                  .
                </div>
              )}
              <div className="marker-row">
                <input
                  type="text"
                  placeholder="Marker label (e.g. clicked Create Order)"
                  value={marker}
                  maxLength={200}
                  onChange={(e) => setMarker(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void addMarker()}
                />
                <button type="button" className="btn btn-small" onClick={addMarker}>
                  Add marker
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={busy || !tab}
                onClick={start}
              >
                Start recording this site
              </button>
              <p className="muted small">
                Chrome will ask for access to <code>{policy.origin}</code> the first time. Captured data stays
                in this browser.
              </p>
            </>
          )}
        </section>
      )}

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <footer className="popup-footer">
        <button type="button" className="btn btn-block" onClick={() => openExplorer()}>
          Open debugging workspace
        </button>
        <p className="copyright">© 2026 Alaa El-Basuony. All rights reserved.</p>
      </footer>
    </div>
  );
}
