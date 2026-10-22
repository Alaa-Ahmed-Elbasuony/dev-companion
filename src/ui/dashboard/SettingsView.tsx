import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { OpenApiError, parseOpenApi } from '../../analysis/openapi';
import { redactEntry } from '../../analysis/redaction';
import { TOKENS_KEY } from '../../background/server-traces';
import { originToPattern } from '../../background/url-policy';
import { DEFAULT_SETTINGS, isLoopbackUrl, normalizeOrigin, normalizeSettings } from '../../shared/settings';
import type { ContractBaseline, RealtimeExpectation, ServerIntegration, Settings } from '../../shared/types';
import { createId, formatBytes } from '../../shared/util';
import { estimateBytes } from '../../storage/entry-builder';
import { Notice } from '../components/common';
import { UpdateCommits, UpdateSteps } from '../components/UpdateBanner';
import { ConfirmDialog } from '../components/ui';
import {
  canRequestPermissions,
  getStore,
  notifyDataChanged,
  saveSettings,
  sendToWorker,
} from '../lib/extension';
import type { ThemeChoice } from '../lib/theme';
import { loadBuildInfo, useUpdateStatus } from '../lib/updates';
import type { BuildInfo } from '../lib/updates';

const lines = (list: string[]) => list.join('\n');
const parseLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

type Msg = { kind: 'info' | 'error' | 'warning'; text: string } | null;

export function SettingsView({
  settings,
  usage,
  contracts,
  theme,
  onTheme,
  onChanged,
  section,
}: {
  settings: Settings;
  usage: { entryCount: number; totalBytes: number };
  contracts: ContractBaseline[];
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  onChanged: () => void;
  section?: string;
}) {
  const [draft, setDraft] = useState(settings);
  const [headerText, setHeaderText] = useState(lines(settings.redaction.headerNames));
  const [keyText, setKeyText] = useState(lines(settings.redaction.keyRules));
  const [adapterText, setAdapterText] = useState(lines(settings.appAdapterOrigins));
  const [selectorText, setSelectorText] = useState(lines(settings.notificationSelectors));
  const [message, setMessage] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const integrationsRef = useRef<HTMLElement>(null);
  const updatesRef = useRef<HTMLElement>(null);
  const update = useUpdateStatus();
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (section === 'integrations') integrationsRef.current?.scrollIntoView({ block: 'start' });
    if (section === 'updates') updatesRef.current?.scrollIntoView({ block: 'start' });
  }, [section]);

  useEffect(() => {
    void loadBuildInfo().then(setBuild);
  }, []);

  // Saved right away (not with "Save settings"), so the draft follows along.
  const setUpdateChecks = (on: boolean) => {
    setDraft((d) => ({ ...d, checkForUpdates: on }));
    void saveSettings(normalizeSettings({ ...settings, checkForUpdates: on }));
  };
  const checkNow = () => {
    setChecking(true);
    void update.checkNow().finally(() => setChecking(false));
  };

  const num = (key: keyof Settings) => ({
    value: String(draft[key]),
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: Number(e.target.value) })),
  });
  const bool = (
    key:
      'captureConsole' | 'captureInteractions' | 'captureStacks' | 'captureRealtime' | 'captureFetchStreams',
  ) => ({
    checked: draft[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.checked })),
  });

  const save = async () => {
    const invalidOrigins = parseLines(adapterText).filter((o) => !normalizeOrigin(o));
    const next = normalizeSettings({
      ...draft,
      appAdapterOrigins: parseLines(adapterText),
      notificationSelectors: parseLines(selectorText),
      redaction: { ...draft.redaction, headerNames: parseLines(headerText), keyRules: parseLines(keyText) },
    });
    await saveSettings(next);
    setDraft(next);
    setHeaderText(lines(next.redaction.headerNames));
    setKeyText(lines(next.redaction.keyRules));
    setAdapterText(lines(next.appAdapterOrigins));
    const store = await getStore();
    await store.enforceRetention({ maxEntries: next.maxEntries, maxBytes: next.maxStorageMB * 1024 * 1024 });
    await store.enforceTimelineRetention(next.maxTimelineEvents);
    await store.enforceRealtimeRetention(next.maxRealtimeMessages);
    if (next.retentionDays > 0) await store.deleteOlderThan(Date.now() - next.retentionDays * 86_400_000);
    notifyDataChanged();
    onChanged();
    setMessage({
      kind: invalidOrigins.length ? 'warning' : 'info',
      text:
        (invalidOrigins.length ? `Ignored invalid origin(s): ${invalidOrigins.join(', ')}. ` : '') +
        'Settings saved. Capture settings apply to recording tabs immediately (page adapters after the next page load); new redaction rules apply to new captures and exports.',
    });
  };

  const reset = () => {
    setDraft(DEFAULT_SETTINGS);
    setHeaderText(lines(DEFAULT_SETTINGS.redaction.headerNames));
    setKeyText(lines(DEFAULT_SETTINGS.redaction.keyRules));
    setAdapterText('');
    setSelectorText(lines(DEFAULT_SETTINGS.notificationSelectors));
    setMessage({ kind: 'info', text: 'Defaults loaded. Click Save to apply.' });
  };

  const applyRedaction = async () => {
    setBusy(true);
    try {
      const store = await getStore();
      const changed = await store.rewriteEntries((entry, bodies) => {
        const r = redactEntry(entry, bodies, settings.redaction);
        if (!r.count) return null;
        return { entry: { ...r.entry, bytes: estimateBytes(r.entry, r.bodies) }, bodies: r.bodies };
      });
      notifyDataChanged();
      onChanged();
      setMessage({
        kind: 'info',
        text: `Rewrote ${changed} stored request(s) with the saved redaction rules.`,
      });
    } catch (err) {
      setMessage({ kind: 'error', text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    setConfirmDeleteAll(false);
    const store = await getStore();
    const sessions = await store.listSessions();
    await store.clearAll(sessions.filter((s) => !s.endedAt && !s.imported).map((s) => s.id));
    notifyDataChanged();
    onChanged();
    setMessage({ kind: 'info', text: 'All captured data deleted. Active recordings keep running.' });
  };

  const recompute = async () => {
    const u = await (await getStore()).recomputeUsage();
    onChanged();
    setMessage({
      kind: 'info',
      text: `Usage recomputed: ${u.entryCount} requests, ${formatBytes(u.totalBytes)}.`,
    });
  };

  return (
    <div className="settings">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <section>
        <h2>Appearance</h2>
        <label>
          Theme{' '}
          <select value={theme} onChange={(e) => onTheme(e.target.value as ThemeChoice)} aria-label="Theme">
            <option value="system">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Retention</h2>
        <p className="muted small">
          Currently stored: {usage.entryCount} requests, approximately {formatBytes(usage.totalBytes)}. The
          oldest records are deleted when a limit is exceeded.
        </p>
        <div className="form-grid">
          <label>
            Maximum stored requests <input type="number" min={50} {...num('maxEntries')} />
          </label>
          <label>
            Maximum storage (MB) <input type="number" min={5} {...num('maxStorageMB')} />
          </label>
          <label>
            Maximum body size per request/response (KB) <input type="number" min={1} {...num('maxBodyKB')} />
          </label>
          <label>
            Maximum timeline events <input type="number" min={100} {...num('maxTimelineEvents')} />
          </label>
          <label>
            Maximum realtime messages <input type="number" min={100} {...num('maxRealtimeMessages')} />
          </label>
          <label>
            Maximum server spans <input type="number" min={100} {...num('maxSpans')} />
          </label>
          <label>
            Delete records older than (days, 0 = never){' '}
            <input type="number" min={0} max={365} {...num('retentionDays')} />
          </label>
          <label>
            Slow request threshold (ms) <input type="number" min={50} {...num('slowRequestMs')} />
          </label>
        </div>
      </section>

      <section>
        <h2>Capture</h2>
        <label className="check">
          <input type="checkbox" {...bool('captureConsole')} /> Record console errors and warnings
        </label>
        <label className="check">
          <input type="checkbox" {...bool('captureInteractions')} /> Record clicks and form submissions
          (labels only, never field values)
        </label>
        <label className="check">
          <input type="checkbox" {...bool('captureStacks')} /> Record initiator stack traces
        </label>
        <label className="check">
          <input type="checkbox" {...bool('captureRealtime')} /> Record WebSocket and EventSource traffic
          (Socket.IO, SignalR and SSE are decoded)
        </label>
        <div className="form-grid">
          <label>
            Maximum realtime frame size (KB, larger frames are truncated){' '}
            <input type="number" min={1} {...num('maxFrameKB')} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" {...bool('captureFetchStreams')} /> Parse fetch() event streams
          (text/event-stream) as SSE — reads a clone of the response, up to the body size limit
        </label>
        <p className="muted small">
          Advanced capture (chrome.debugger) is turned on per tab from the popup or the header. It sees all
          SSE event types and document response headers, but Chrome shows a debugging banner while it is
          attached.
        </p>
      </section>

      <section ref={integrationsRef} id="integrations">
        <h2>Integrations</h2>
        <h3>Server tracing (development only)</h3>
        <p className="muted small">
          Pulls server-side rendering and outbound request spans from the local collector started by{' '}
          <code>@dev-companion/server-tracer</code> (see examples/next-ssr). Collectors must run on this
          machine (127.0.0.1 / localhost). The token is stored only in this browser and is never exported.
        </p>
        <IntegrationsEditor
          integrations={draft.serverIntegrations}
          onChange={(serverIntegrations) => setDraft((d) => ({ ...d, serverIntegrations }))}
          onMessage={setMessage}
          onSaveSettings={async (serverIntegrations) => {
            const next = normalizeSettings({ ...settings, serverIntegrations });
            await saveSettings(next);
            setDraft((d) => ({ ...d, serverIntegrations: next.serverIntegrations }));
            onChanged();
          }}
        />
        <h3>Page API and notification observer (opt-in per origin)</h3>
        <p className="muted small">
          For the listed origins, pages get <code>window.__devCompanion</code> (signal stages such as
          “handler-ran”, attach Socket.IO/SignalR clients) and text appearing in notification regions is
          recorded. Nothing runs on other origins. Applies from the next page load.
        </p>
        <div className="form-grid two">
          <label>
            Origins (one per line, e.g. http://localhost:3000)
            <textarea rows={4} value={adapterText} onChange={(e) => setAdapterText(e.target.value)} />
          </label>
          <label>
            Notification region selectors (one per line)
            <textarea rows={4} value={selectorText} onChange={(e) => setSelectorText(e.target.value)} />
          </label>
        </div>
      </section>

      <section>
        <h2>Realtime expectations</h2>
        <p className="muted small">
          Describe what should happen, so investigations can check it: e.g. after POST /api/orders,
          “order.created” arrives within 5 s and contains orderId.
        </p>
        <ExpectationsEditor
          expectations={draft.realtimeExpectations}
          onChange={(realtimeExpectations) => setDraft((d) => ({ ...d, realtimeExpectations }))}
        />
      </section>

      <section>
        <h2>API contracts (OpenAPI 3.x)</h2>
        <OpenApiManager contracts={contracts} onChanged={onChanged} onMessage={setMessage} />
      </section>

      <section>
        <h2>Redaction</h2>
        <p className="muted small">
          Matching values are replaced with <code>[REDACTED]</code> <strong>before</strong> a request or
          message is stored, and again when exporting. Rules added later apply to exports, but stored values
          are shown as they are until you apply the rules to stored history (requests only).
        </p>
        <div className="form-grid two">
          <label>
            Header names (one per line, exact, case-insensitive)
            <textarea rows={10} value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
          </label>
          <label>
            Field/parameter/header key rules (one per line). Plain = substring match; <code>=name</code> =
            exact match. Matching ignores case, <code>-</code>, <code>_</code> and spaces.
            <textarea rows={10} value={keyText} onChange={(e) => setKeyText(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.redaction.redactTokenValues}
            onChange={(e) =>
              setDraft((d) => ({ ...d, redaction: { ...d.redaction, redactTokenValues: e.target.checked } }))
            }
          />{' '}
          Redact JWTs and Bearer/Basic tokens anywhere in text
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.redaction.redactCardNumbers}
            onChange={(e) =>
              setDraft((d) => ({ ...d, redaction: { ...d.redaction, redactCardNumbers: e.target.checked } }))
            }
          />{' '}
          Redact payment card numbers (Luhn-valid, common card prefixes)
        </label>
      </section>

      <div className="settings-actions sticky-actions">
        <button type="button" className="btn btn-primary" onClick={save}>
          Save settings
        </button>
        <button type="button" className="btn" onClick={reset}>
          Load defaults
        </button>
      </div>

      <section>
        <h2>Stored data</h2>
        <div className="settings-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={applyRedaction}
            title="Uses the saved rules"
          >
            Apply redaction to stored history
          </button>
          <button type="button" className="btn" onClick={recompute}>
            Recompute usage
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteAll(true)}>
            Delete all data
          </button>
        </div>
        <p className="muted small">
          Data is stored in this browser profile (IndexedDB) and is never sent anywhere by Dev Companion.
          Removing the extension deletes it.
        </p>
      </section>

      <section ref={updatesRef} id="updates">
        <h2>Updates</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.checkForUpdates}
            onChange={(e) => setUpdateChecks(e.target.checked)}
          />{' '}
          Tell me when the repository has a newer version (asks GitHub's public API every few hours; sends
          only the commit this build came from)
        </label>
        {!build?.commit ? (
          <p className="muted small">
            This build was not made from a git checkout, so it cannot check for updates.
          </p>
        ) : build.dirty ? (
          <p className="muted small">
            This is a development build: it was made from <code>{build.commit.slice(0, 7)}</code> with
            uncommitted changes, so it does not check for updates. Commit and rebuild to turn checks on.
          </p>
        ) : (
          <>
            <p className="muted small">
              Built from <code>{build.commit.slice(0, 7)}</code>
              {build.branch && build.branch !== 'HEAD' ? ` on ${build.branch}` : ''} ·{' '}
              {new Date(build.builtAt).toLocaleString()}
              {update.status ? ` · last checked ${new Date(update.status.checkedAt).toLocaleString()}` : ''}
            </p>
            <div className="settings-actions">
              <button type="button" className="btn" disabled={checking} onClick={checkNow}>
                {checking ? 'Checking…' : 'Check now'}
              </button>
            </div>
            {update.status?.error && (
              <Notice kind="warning">Update check failed: {update.status.error}</Notice>
            )}
            {update.status && !update.status.error && !update.status.available && (
              <p className="small">You have the latest version.</p>
            )}
            {update.status?.available && (
              <>
                <Notice kind="info">
                  <strong>Update available.</strong> The repository has extension changes newer than this
                  build.
                </Notice>
                <UpdateCommits status={update.status} />
                <h4>How to update</h4>
                <UpdateSteps />
              </>
            )}
          </>
        )}
      </section>
      {confirmDeleteAll && (
        <ConfirmDialog
          title="Delete all captured data?"
          confirmLabel="Delete everything"
          danger
          onConfirm={deleteAll}
          onCancel={() => setConfirmDeleteAll(false)}
        >
          <p>
            All requests, timeline events, realtime messages, server spans, sessions and saved investigations
            will be deleted. Active recordings keep running. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function IntegrationsEditor({
  integrations,
  onChange,
  onMessage,
  onSaveSettings,
}: {
  integrations: ServerIntegration[];
  onChange: (list: ServerIntegration[]) => void;
  onMessage: (m: Msg) => void;
  onSaveSettings: (list: ServerIntegration[]) => Promise<void>;
}) {
  const [appOrigin, setAppOrigin] = useState('http://localhost:3100');
  const [collector, setCollector] = useState('http://127.0.0.1:4319');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  const add = () => {
    const app = normalizeOrigin(appOrigin);
    const col = normalizeOrigin(collector);
    if (!app) return onMessage({ kind: 'error', text: 'The application origin is not a valid http(s) URL.' });
    if (!col || !isLoopbackUrl(col))
      return onMessage({
        kind: 'error',
        text: 'The collector must be a local address (http://127.0.0.1:<port> or http://localhost:<port>).',
      });
    if (token.trim().length < 16)
      return onMessage({
        kind: 'error',
        text: 'Paste the token from .dev-companion/token (printed by the dev server at startup).',
      });
    // Host permission for the collector must be requested from the click.
    const ask = canRequestPermissions()
      ? chrome.permissions.request({ origins: [originToPattern(col)] })
      : Promise.resolve(true);
    void ask.then(async (granted) => {
      if (!granted)
        return onMessage({
          kind: 'error',
          text: `Access to ${col} was not granted; the extension cannot reach the collector.`,
        });
      const integration: ServerIntegration = {
        id: createId(),
        appOrigin: app,
        collectorUrl: col,
        enabled: true,
      };
      const tokens = ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Record<
        string,
        string
      >;
      await chrome.storage.local.set({ [TOKENS_KEY]: { ...tokens, [integration.id]: token.trim() } });
      const list = [...integrations, integration];
      onChange(list);
      await onSaveSettings(list);
      setToken('');
      onMessage({
        kind: 'info',
        text: `Server tracing for ${app} added. Spans are pulled while ${app} is being recorded.`,
      });
    });
  };

  const remove = async (id: string) => {
    const tokens = ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Record<string, string>;
    delete tokens[id];
    await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
    const list = integrations.filter((i) => i.id !== id);
    onChange(list);
    await onSaveSettings(list);
  };

  const test = async (i: ServerIntegration) => {
    setTesting(i.id);
    try {
      const tokens = ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Record<
        string,
        string
      >;
      const res = await fetch(`${i.collectorUrl}/v1/health`, {
        headers: { authorization: `Bearer ${tokens[i.id] ?? ''}` },
        credentials: 'omit',
      });
      const body = (await res.json().catch(() => ({}))) as { service?: string; buffered?: number };
      onMessage(
        res.ok
          ? {
              kind: 'info',
              text: `Collector reachable: service “${body.service}”, ${body.buffered} span(s) buffered.`,
            }
          : {
              kind: 'error',
              text:
                res.status === 401
                  ? 'The collector rejected the token.'
                  : `Collector answered HTTP ${res.status}.`,
            },
      );
      void sendToWorker({ type: 'sync-server-traces' }).catch(() => undefined);
    } catch (err) {
      onMessage({
        kind: 'error',
        text: `Collector unreachable at ${i.collectorUrl}: ${String(err)}. Start the dev server with DEV_COMPANION_TRACING=1.`,
      });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="integrations">
      {integrations.length > 0 && (
        <table className="kv">
          <tbody>
            {integrations.map((i) => (
              <tr key={i.id}>
                <th>{i.appOrigin}</th>
                <td>
                  → {i.collectorUrl}{' '}
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={testing === i.id}
                    onClick={() => void test(i)}
                  >
                    {testing === i.id ? 'Testing…' : 'Test connection'}
                  </button>{' '}
                  <button
                    type="button"
                    className="btn btn-small btn-danger-ghost"
                    onClick={() => void remove(i.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <label>
          Application origin <input value={appOrigin} onChange={(e) => setAppOrigin(e.target.value)} />
        </label>
        <label>
          Collector URL <input value={collector} onChange={(e) => setCollector(e.target.value)} />
        </label>
        <label>
          Token{' '}
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      </div>
      <button type="button" className="btn" onClick={add}>
        Add server integration
      </button>
    </div>
  );
}

function ExpectationsEditor({
  expectations,
  onChange,
}: {
  expectations: RealtimeExpectation[];
  onChange: (list: RealtimeExpectation[]) => void;
}) {
  const [form, setForm] = useState({
    eventName: '',
    afterMethod: 'POST',
    afterPath: '',
    withinMs: '5000',
    requiredFields: '',
  });
  return (
    <div>
      {expectations.length > 0 && (
        <ul className="plain expectations">
          {expectations.map((e) => (
            <li key={e.id}>
              <code>{e.eventName}</code>
              {e.afterPath ? ` within ${e.withinMs} ms after ${e.afterMethod ?? ''} ${e.afterPath}` : ''}
              {e.requiredFields.length ? `, requires ${e.requiredFields.join(', ')}` : ''}{' '}
              <button
                type="button"
                className="btn btn-small btn-danger-ghost"
                onClick={() => onChange(expectations.filter((x) => x.id !== e.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-grid">
        <label>
          Event name{' '}
          <input
            value={form.eventName}
            placeholder="order.created"
            onChange={(e) => setForm({ ...form, eventName: e.target.value })}
          />
        </label>
        <label>
          After method{' '}
          <select
            value={form.afterMethod}
            onChange={(e) => setForm({ ...form, afterMethod: e.target.value })}
          >
            {['', 'POST', 'PUT', 'PATCH', 'DELETE', 'GET'].map((m) => (
              <option key={m} value={m}>
                {m || '(any)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          After path{' '}
          <input
            value={form.afterPath}
            placeholder="/api/orders"
            onChange={(e) => setForm({ ...form, afterPath: e.target.value })}
          />
        </label>
        <label>
          Within (ms){' '}
          <input
            type="number"
            min={100}
            value={form.withinMs}
            onChange={(e) => setForm({ ...form, withinMs: e.target.value })}
          />
        </label>
        <label>
          Required fields (comma-separated){' '}
          <input
            value={form.requiredFields}
            placeholder="orderId, status"
            onChange={(e) => setForm({ ...form, requiredFields: e.target.value })}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn"
        disabled={!form.eventName.trim()}
        onClick={() => {
          onChange([
            ...expectations,
            {
              id: createId(),
              label: form.eventName.trim(),
              eventName: form.eventName.trim(),
              afterMethod: form.afterPath ? form.afterMethod || undefined : undefined,
              afterPath: form.afterPath.trim() || undefined,
              withinMs: Number(form.withinMs) || 5000,
              requiredFields: form.requiredFields
                .split(',')
                .map((f) => f.trim())
                .filter(Boolean),
            },
          ]);
          setForm({ ...form, eventName: '', requiredFields: '' });
        }}
      >
        Add expectation
      </button>{' '}
      <span className="muted small">Click Save settings to apply.</span>
    </div>
  );
}

function OpenApiManager({
  contracts,
  onChanged,
  onMessage,
}: {
  contracts: ContractBaseline[];
  onChanged: () => void;
  onMessage: (m: Msg) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const docs = contracts.filter((c) => c.kind === 'openapi');
  const onFile = async (file: File) => {
    try {
      if (file.size > 10 * 1024 * 1024) throw new OpenApiError('File is larger than 10 MB.');
      const doc = parseOpenApi(await file.text());
      await (
        await getStore()
      ).putContract({
        endpointKey: `openapi:${doc.title}`,
        kind: 'openapi',
        schema: doc.raw,
        createdAt: Date.now(),
      });
      notifyDataChanged();
      onChanged();
      onMessage({
        kind: 'info',
        text: `Imported “${doc.title}” ${doc.version} (${Object.keys(doc.paths).length} paths). Matching requests are validated in Network details and Investigations.`,
      });
    } catch (err) {
      onMessage({
        kind: 'error',
        text: `OpenAPI import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
  return (
    <div>
      <p className="muted small">
        JSON documents only (convert YAML first). Local $refs are resolved; validation uses a JSON Schema
        subset. Without a document, no contract validation is claimed.
      </p>
      {docs.length > 0 && (
        <ul className="plain">
          {docs.map((d) => (
            <li key={d.endpointKey}>
              {d.endpointKey.replace(/^openapi:/, '')}{' '}
              <button
                type="button"
                className="btn btn-small btn-danger-ghost"
                onClick={async () => {
                  await (await getStore()).deleteContract(d.endpointKey);
                  notifyDataChanged();
                  onChanged();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        Import OpenAPI JSON…
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
    </div>
  );
}
