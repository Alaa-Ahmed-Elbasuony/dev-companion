// Thin wrappers around extension APIs used by the UI.
import { checkRecordableUrl } from '../../background/url-policy';
import type { StartResult, TabStateResponse, WorkerRequest } from '../../shared/messages';
import { normalizeSettings } from '../../shared/settings';
import type { Settings } from '../../shared/types';
import { EntryStore } from '../../storage/database';

let storePromise: Promise<EntryStore> | null = null;
export function getStore(): Promise<EntryStore> {
  storePromise ??= EntryStore.open();
  return storePromise;
}

export function sendToWorker<T = unknown>(message: WorkerRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get('settings');
  return normalizeSettings(data.settings);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: normalizeSettings(settings) });
}

/** Tells other extension pages that stored data changed. */
export function notifyDataChanged() {
  chrome.runtime.sendMessage({ type: 'data-changed' }).catch(() => undefined);
}

export function getTabState(tabId: number) {
  return sendToWorker<TabStateResponse>({ type: 'get-tab-state', tabId });
}

export const canRequestPermissions = () => typeof chrome.permissions?.request === 'function';

/**
 * Requests host permission for the tab's origin and starts recording. Must be
 * called directly from a click handler: Chrome requires a user gesture for the
 * permission prompt, so nothing is awaited before chrome.permissions.request.
 */
export function requestPermissionAndStart(tabId: number, url: string): Promise<StartResult> {
  const policy = checkRecordableUrl(url);
  if (!policy.ok) return Promise.resolve({ ok: false, reason: 'restricted-url', message: policy.message });
  // If the popup closes while the prompt is open, the worker finishes the start.
  void sendToWorker({ type: 'set-pending-start', tabId, url }).catch(() => undefined);
  return chrome.permissions.request({ origins: [policy.pattern] }).then((granted) => {
    if (!granted) {
      return {
        ok: false,
        reason: 'permission-required',
        message: `Permission for ${policy.origin} was not granted.`,
      } as StartResult;
    }
    return sendToWorker<StartResult>({ type: 'start-recording', tabId, url });
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be unavailable in DevTools panels; fall back to execCommand.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function downloadText(fileName: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
