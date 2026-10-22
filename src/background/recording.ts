// Recording lifecycle: per-tab state, content-script registration for granted
// origins, injection into already-open pages and the toolbar badge.
import type { StartResult } from '../shared/messages';
import { captureConfigFrom } from '../shared/settings';
import type { RecordingState, Session, Settings } from '../shared/types';
import { createId } from '../shared/util';
import type { EntryStore } from '../storage/database';
import { checkRecordableUrl, originToPattern } from './url-policy';

const STATE_KEY = 'recordingTabs';
const SCRIPT_IDS = { main: 'dc-main-world', bridge: 'dc-bridge' } as const;

type StateMap = Record<string, RecordingState>;

export class RecordingController {
  constructor(
    private readonly store: EntryStore,
    private readonly settings: () => Promise<Settings>,
    private readonly broadcast: () => void,
  ) {}

  async loadState(): Promise<StateMap> {
    const data = await chrome.storage.session.get(STATE_KEY);
    return (data[STATE_KEY] as StateMap | undefined) ?? {};
  }

  private async saveState(state: StateMap) {
    await chrome.storage.session.set({ [STATE_KEY]: state });
  }

  async get(tabId: number): Promise<RecordingState | null> {
    return (await this.loadState())[String(tabId)] ?? null;
  }

  async start(tabId: number, url: string): Promise<StartResult> {
    const policy = checkRecordableUrl(url);
    if (!policy.ok) return { ok: false, reason: 'restricted-url', message: policy.message };
    const granted = await chrome.permissions.contains({ origins: [policy.pattern] });
    if (!granted) {
      return {
        ok: false,
        reason: 'permission-required',
        message: `Dev Companion needs permission to access ${policy.origin}.`,
      };
    }

    const state = await this.loadState();
    const existing = state[String(tabId)];
    if (existing && existing.origin === policy.origin) {
      const session = await this.store.getSession(existing.sessionId);
      if (session) return { ok: true, session, injected: true };
    }
    if (existing) await this.stop(tabId, 'Recording moved to another origin');

    const now = Date.now();
    const session: Session = {
      id: createId(),
      tabId,
      origin: policy.origin,
      startedAt: now,
      label: `${new URL(policy.origin).host} · ${new Date(now).toLocaleString()}`,
    };
    await this.store.putSession(session);
    const fresh = await this.loadState();
    fresh[String(tabId)] = { sessionId: session.id, tabId, origin: policy.origin, startedAt: now };
    await this.saveState(fresh);
    await this.syncRegistration(fresh);
    await this.store.putTimeline({
      id: createId(),
      sessionId: session.id,
      tabId,
      origin: policy.origin,
      pageId: '',
      pageUrl: '',
      kind: 'recording',
      timestamp: now,
      message: 'Recording started',
    });

    const injected = await this.injectIntoTab(tabId);
    await this.notifyTab(tabId, true);
    await this.setBadge(tabId, true);
    this.broadcast();
    return { ok: true, session, injected };
  }

  async stop(tabId: number, reason = 'Recording stopped'): Promise<void> {
    const state = await this.loadState();
    const rec = state[String(tabId)];
    if (!rec) return;
    delete state[String(tabId)];
    await this.saveState(state);
    const session = await this.store.getSession(rec.sessionId);
    if (session) await this.store.putSession({ ...session, endedAt: Date.now() });
    await this.store.markSessionIncomplete(rec.sessionId, 'Recording stopped before this request completed');
    await this.store.markConnectionsUnobserved(
      rec.sessionId,
      'Recording stopped while this connection was open; the page connection itself was not closed',
    );
    await this.store.putTimeline({
      id: createId(),
      sessionId: rec.sessionId,
      tabId,
      origin: rec.origin,
      pageId: '',
      pageUrl: '',
      kind: 'recording',
      timestamp: Date.now(),
      message: reason,
    });
    await this.syncRegistration(state);
    await this.notifyTab(tabId, false);
    await this.setBadge(tabId, false);
    this.broadcast();
  }

  /** The tab currently recording into a session, if any. */
  async tabForSession(sessionId: string): Promise<number | undefined> {
    return Object.values(await this.loadState()).find((r) => r.sessionId === sessionId)?.tabId;
  }

  /**
   * Closes a session that is not recording any more but was never marked ended
   * (e.g. the browser restarted mid-recording). Recording sessions go through stop().
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (!session || session.endedAt) return;
    await this.store.putSession({ ...session, endedAt: Date.now() });
    await this.store.markSessionIncomplete(sessionId, 'Session closed before this request completed');
    await this.store.markConnectionsUnobserved(sessionId, 'Session closed while this connection was open');
    this.broadcast();
  }

  /** Registers the recorder for every origin that has an active recording. */
  async syncRegistration(state?: StateMap): Promise<void> {
    const current = state ?? (await this.loadState());
    const patterns = [...new Set(Object.values(current).map((r) => originToPattern(r.origin)))];
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [SCRIPT_IDS.main, SCRIPT_IDS.bridge],
    });
    const key = (list: readonly string[] | undefined) => [...(list ?? [])].sort().join('\n');
    const unchanged =
      existing.length === 2 && existing.every((s) => key(s.matches) === key(patterns)) && patterns.length > 0;
    if (unchanged) return;
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    if (!patterns.length) return;
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_IDS.main,
        js: ['main-world.js'],
        matches: patterns,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: false,
      },
      {
        id: SCRIPT_IDS.bridge,
        js: ['content-script.js'],
        matches: patterns,
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
  }

  /** Injects into the already-loaded document so recording starts without a reload. */
  private async injectIntoTab(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['main-world.js'],
        world: 'MAIN',
        injectImmediately: true,
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js'],
        injectImmediately: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Sends the capture configuration to the tab's bridge. Capture is enabled only while recording and not paused. */
  async notifyTab(tabId: number, recording: boolean): Promise<void> {
    const rec = recording ? await this.get(tabId) : null;
    const enabled = recording && !rec?.paused;
    const config = captureConfigFrom(await this.settings(), enabled, rec?.origin);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'recording-state', recording: enabled, config });
    } catch {
      /* no bridge in this tab (yet) */
    }
  }

  async notifyAllRecordingTabs(): Promise<void> {
    const state = await this.loadState();
    await Promise.all(Object.values(state).map((r) => this.notifyTab(r.tabId, true)));
  }

  /**
   * Pausing suspends capture but keeps the session, the script registration and
   * everything stored. It never touches the page's own connections or requests.
   */
  async setPaused(tabId: number, paused: boolean): Promise<boolean> {
    const state = await this.loadState();
    const rec = state[String(tabId)];
    if (!rec || !!rec.paused === paused) return !!rec;
    state[String(tabId)] = { ...rec, paused };
    await this.saveState(state);
    await this.store.putTimeline({
      id: createId(),
      sessionId: rec.sessionId,
      tabId,
      origin: rec.origin,
      pageId: '',
      pageUrl: '',
      kind: 'recording',
      timestamp: Date.now(),
      message: paused
        ? 'Recording paused (nothing is captured until resumed)'
        : 'Recording resumed (events while paused were not captured)',
    });
    await this.notifyTab(tabId, true);
    await this.setBadge(tabId, true, paused);
    this.broadcast();
    return true;
  }

  /** Persists a flag on the tab's recording state (e.g. advanced capture attached). */
  async patchState(tabId: number, patch: Partial<RecordingState>): Promise<void> {
    const state = await this.loadState();
    const rec = state[String(tabId)];
    if (!rec) return;
    state[String(tabId)] = { ...rec, ...patch };
    await this.saveState(state);
  }

  async setBadge(tabId: number, recording: boolean, paused = false): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text: recording ? (paused ? 'II' : 'REC') : '' });
      if (recording) {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: paused ? '#b45309' : '#dc2626' });
      }
    } catch {
      /* tab may be gone */
    }
  }
}
