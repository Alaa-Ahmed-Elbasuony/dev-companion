// Service worker: routes messages, gates capture on recording state and writes
// to IndexedDB. Holds no durable state in memory; it may be terminated at any time.
import type { PageConfigResponse, StartResult, TabStateResponse, WorkerRequest } from '../shared/messages';
import { captureConfigFrom, normalizeSettings } from '../shared/settings';
import type { Settings } from '../shared/types';
import { createId, originOf } from '../shared/util';
import { EntryStore } from '../storage/database';
import { AdvancedCapture } from './cdp';
import { Ingestor } from './ingest';
import { RecordingController } from './recording';
import { TraceSync } from './server-traces';
import { originToPattern } from './url-policy';

const PENDING_START_KEY = 'pendingStart';
const STORAGE_STATUS_KEY = 'storageStatus';

const storePromise = EntryStore.open();
let settingsCache: Settings | null = null;

async function getSettings(): Promise<Settings> {
  if (!settingsCache) {
    const data = await chrome.storage.local.get('settings');
    settingsCache = normalizeSettings(data.settings);
  }
  return settingsCache;
}

// Serialize all state-changing work so start/stop/ingest never interleave.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
function broadcastDataChanged() {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = undefined;
    chrome.runtime.sendMessage({ type: 'data-changed' }).catch(() => undefined);
  }, 250);
}

function reportStorageError(message: string) {
  void chrome.storage.session.set({ [STORAGE_STATUS_KEY]: { message, at: Date.now() } });
}

async function getController() {
  return new RecordingController(await storePromise, getSettings, () => {
    chrome.runtime.sendMessage({ type: 'recording-changed' }).catch(() => undefined);
    broadcastDataChanged();
  });
}

async function getIngestor() {
  const store = await storePromise;
  const controller = await getController();
  return new Ingestor({
    store,
    settings: getSettings,
    recording: (tabId) => controller.get(tabId),
    onStorageError: reportStorageError,
  });
}

let advancedCapture: AdvancedCapture | null = null;
async function getAdvancedCapture(): Promise<AdvancedCapture> {
  if (!advancedCapture) {
    const store = await storePromise;
    const controller = await getController();
    advancedCapture = new AdvancedCapture({
      store,
      settings: getSettings,
      recording: (tabId) => controller.get(tabId),
      setAdvancedFlag: (tabId, advanced) => controller.patchState(tabId, { advanced }),
      ingest: async (tabId, events) => {
        const ingestor = await getIngestor();
        const result = await serial(() => ingestor.ingestTrusted(tabId, events));
        if (result.stored) broadcastDataChanged();
        return result;
      },
      onChanged: () => {
        chrome.runtime.sendMessage({ type: 'recording-changed' }).catch(() => undefined);
        broadcastDataChanged();
      },
    });
  }
  return advancedCapture;
}

let traceSync: TraceSync | null = null;
async function getTraceSync(): Promise<TraceSync> {
  if (!traceSync) {
    const store = await storePromise;
    const controller = await getController();
    traceSync = new TraceSync({
      store,
      settings: getSettings,
      recordings: async () => Object.values(await controller.loadState()),
      onStored: broadcastDataChanged,
    });
  }
  return traceSync;
}

/** Schedules a server-span pull when the recorded origin has a server integration. */
async function maybeScheduleTraceSync(origin: string) {
  const settings = await getSettings();
  if (settings.serverIntegrations.some((i) => i.enabled && i.appOrigin === origin)) {
    (await getTraceSync()).schedule(origin);
  }
}

// Registered at startup so debugger events wake the worker.
let debuggerListeners = false;
function registerDebuggerListeners() {
  if (debuggerListeners || typeof chrome.debugger?.onEvent?.addListener !== 'function') return;
  debuggerListeners = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    void getAdvancedCapture()
      .then((a) => a.onEvent(tabId, method, (params ?? {}) as Record<string, unknown>))
      .catch(() => undefined);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    void getAdvancedCapture()
      .then((a) => a.onDetach(tabId, String(reason)))
      .catch(() => undefined);
  });
}
registerDebuggerListeners();

const isExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

async function handle(message: WorkerRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const controller = await getController();
  switch (message.type) {
    case 'capture-batch': {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0) return { ok: false };
      const ingestor = await getIngestor();
      const result = await serial(() =>
        ingestor.ingestBatch(tabId, sender.origin ?? originOf(sender.url ?? ''), message.events),
      );
      if (result.sawHello) {
        const rec = await controller.get(tabId);
        await controller.setBadge(tabId, !!rec, rec?.paused);
      }
      if (result.stored) {
        broadcastDataChanged();
        const rec = await controller.get(tabId);
        if (rec) void maybeScheduleTraceSync(rec.origin).catch(() => undefined);
      }
      return { ok: true };
    }
    case 'page-config-request': {
      const tabId = sender.tab?.id;
      const settings = await getSettings();
      const rec = tabId === undefined ? null : await controller.get(tabId);
      const origin = sender.origin ?? originOf(sender.url ?? '');
      const recording = !!rec && rec.origin === origin && sender.frameId === 0 && !rec.paused;
      const response: PageConfigResponse = {
        recording,
        config: captureConfigFrom(settings, recording, origin),
      };
      return response;
    }
  }

  // Remaining messages control recording and must come from extension pages.
  if (!isExtensionPage(sender)) return { ok: false, reason: 'forbidden' };
  switch (message.type) {
    case 'start-recording':
      return serial<StartResult>(() => controller.start(message.tabId, message.url)).catch(
        (err: unknown): StartResult => ({ ok: false, reason: 'error', message: String(err) }),
      );
    case 'stop-recording': {
      const rec = await controller.get(message.tabId);
      if (rec?.advanced) await (await getAdvancedCapture()).disable(message.tabId, 'Recording stopped');
      await serial(() => controller.stop(message.tabId));
      return { ok: true };
    }
    case 'end-session': {
      const tabId = await controller.tabForSession(message.sessionId);
      if (tabId === undefined) {
        await serial(() => controller.closeSession(message.sessionId));
        return { ok: true };
      }
      const rec = await controller.get(tabId);
      if (rec?.advanced) await (await getAdvancedCapture()).disable(tabId, 'Session closed');
      await serial(() => controller.stop(tabId, 'Session closed'));
      return { ok: true };
    }
    case 'sync-server-traces':
      return { ok: true, status: await (await getTraceSync()).syncAll() };
    case 'set-advanced-capture': {
      registerDebuggerListeners();
      const advanced = await getAdvancedCapture();
      if (!message.enabled) {
        await advanced.disable(message.tabId);
        return { ok: true, attached: false };
      }
      return advanced.enable(message.tabId);
    }
    case 'pause-recording':
    case 'resume-recording': {
      const ok = await serial(() => controller.setPaused(message.tabId, message.type === 'pause-recording'));
      return ok ? { ok: true } : { ok: false, message: 'This tab is not being recorded.' };
    }
    case 'get-tab-state': {
      const response: TabStateResponse = { recording: await controller.get(message.tabId) };
      return response;
    }
    case 'add-marker': {
      const rec = await controller.get(message.tabId);
      if (!rec) return { ok: false, message: 'This tab is not being recorded.' };
      const store = await storePromise;
      await store.putTimeline({
        id: createId(),
        sessionId: rec.sessionId,
        tabId: rec.tabId,
        origin: rec.origin,
        pageId: '',
        pageUrl: '',
        kind: 'marker',
        timestamp: Date.now(),
        message: message.label.slice(0, 200) || 'Marker',
      });
      broadcastDataChanged();
      return { ok: true };
    }
    case 'set-pending-start':
      await chrome.storage.session.set({
        [PENDING_START_KEY]: { tabId: message.tabId, url: message.url, at: Date.now() },
      });
      return { ok: true };
  }
  return { ok: false, reason: 'unknown-message' };
}

chrome.runtime.onMessage.addListener((message: WorkerRequest, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
  if (sender.id !== chrome.runtime.id) return false;
  handle(message, sender).then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, message: String(err) }),
  );
  return true;
});

// If the popup closes while Chrome shows the permission prompt, finish the start here.
chrome.permissions.onAdded.addListener((permissions) => {
  void (async () => {
    const data = await chrome.storage.session.get(PENDING_START_KEY);
    const pending = data[PENDING_START_KEY] as { tabId: number; url: string; at: number } | undefined;
    if (!pending || Date.now() - pending.at > 120_000) return;
    await chrome.storage.session.remove(PENDING_START_KEY);
    let pattern: string;
    try {
      pattern = originToPattern(new URL(pending.url).origin);
    } catch {
      return;
    }
    if (!permissions.origins?.includes(pattern)) return;
    const controller = await getController();
    await serial(() => controller.start(pending.tabId, pending.url));
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const controller = await getController();
    await serial(() => controller.stop(tabId, 'Tab closed'));
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settingsCache = normalizeSettings(changes.settings.newValue);
  void getController().then((c) => c.notifyAllRecordingTabs());
});

// Registered scripts do not persist across browser restarts (and neither does
// session state); keep the two consistent whenever the worker starts.
void getController()
  .then((c) => serial(() => c.syncRegistration()))
  .catch(() => undefined);

// Advanced capture survives worker restarts only while Chrome keeps the debugger attached.
void (async () => {
  const controller = await getController();
  const states = Object.values(await controller.loadState());
  if (!states.some((s) => s.advanced)) return;
  registerDebuggerListeners();
  await (await getAdvancedCapture()).reconcile(states);
})().catch(() => undefined);
