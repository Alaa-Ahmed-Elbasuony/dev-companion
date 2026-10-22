// Reads and clears the inspected site's cookies and storage (dashboard header
// and Storage view).
import { checkRecordableUrl } from '../../background/url-policy';

export type SiteDataKind =
  'cookies' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cacheStorage' | 'serviceWorkers';

export const SITE_DATA_KINDS: { kind: SiteDataKind; label: string; short: string }[] = [
  { kind: 'cookies', label: 'Cookies', short: 'Cookies' },
  { kind: 'localStorage', label: 'Local storage', short: 'Local' },
  { kind: 'sessionStorage', label: 'Session storage', short: 'Session' },
  { kind: 'indexedDB', label: 'IndexedDB', short: 'IDB' },
  { kind: 'cacheStorage', label: 'Cache storage', short: 'Cache' },
  { kind: 'serviceWorkers', label: 'Service workers', short: 'SW' },
];

export const ALL_SITE_DATA_KINDS = SITE_DATA_KINDS.map((k) => k.kind);

export interface ClearResult {
  ok: boolean;
  message: string;
}

const BROWSING_DATA_KINDS = ['localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers'] as const;

/** URL that chrome.cookies.remove needs to target one specific cookie. */
export function cookieUrl(cookie: Pick<chrome.cookies.Cookie, 'domain' | 'path' | 'secure'>): string {
  const host = cookie.domain.replace(/^\./, '');
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
}

export function removeCookie(c: chrome.cookies.Cookie): Promise<boolean> {
  return chrome.cookies
    .remove({
      url: cookieUrl(c),
      name: c.name,
      storeId: c.storeId,
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    })
    .then((r) => !!r)
    .catch(() => false);
}

async function clearCookies(origin: string): Promise<number> {
  const cookies = await chrome.cookies.getAll({ url: origin });
  const results = await Promise.all(cookies.map(removeCookie));
  return results.filter(Boolean).length;
}

/**
 * Requests the permissions and clears the chosen data for the tab's origin.
 * Must be called directly from a click handler: the permission prompt needs a
 * user gesture, so nothing is awaited before chrome.permissions.request.
 */
export function clearSiteData(tabId: number, url: string, kinds: SiteDataKind[]): Promise<ClearResult> {
  const policy = checkRecordableUrl(url);
  if (!policy.ok) return Promise.resolve({ ok: false, message: policy.message });
  const { origin, pattern } = policy;
  const permissions: chrome.runtime.ManifestPermission[] = [];
  if (kinds.includes('cookies')) permissions.push('cookies');
  if (BROWSING_DATA_KINDS.some((k) => kinds.includes(k))) permissions.push('browsingData');

  return chrome.permissions.request({ permissions, origins: [pattern] }).then(async (granted) => {
    if (!granted) {
      return { ok: false, message: `Permission to clear site data for ${origin} was not granted.` };
    }
    const done: string[] = [];
    const failed: string[] = [];
    const label = (k: SiteDataKind) => SITE_DATA_KINDS.find((d) => d.kind === k)!.label.toLowerCase();

    if (kinds.includes('cookies')) {
      try {
        const n = await clearCookies(origin);
        done.push(`${n} cookie${n === 1 ? '' : 's'}`);
      } catch (err) {
        failed.push(`cookies (${String(err instanceof Error ? err.message : err)})`);
      }
    }

    const dataTypes = BROWSING_DATA_KINDS.filter((k) => kinds.includes(k));
    if (dataTypes.length) {
      try {
        await chrome.browsingData.remove(
          { origins: [origin] },
          Object.fromEntries(dataTypes.map((k) => [k, true])),
        );
        done.push(...dataTypes.map(label));
      } catch (err) {
        failed.push(
          `${dataTypes.map(label).join(', ')} (${String(err instanceof Error ? err.message : err)})`,
        );
      }
    }

    // browsingData cannot clear sessionStorage; it lives only in the tab.
    if (kinds.includes('sessionStorage')) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => sessionStorage.clear(),
        });
        done.push('session storage');
      } catch (err) {
        failed.push(`session storage (${String(err instanceof Error ? err.message : err)})`);
      }
    }

    const host = new URL(origin).host;
    const parts = [
      done.length ? `Cleared ${done.join(', ')} for ${host}.` : '',
      failed.length ? `Failed: ${failed.join('; ')}.` : '',
      done.length ? 'Reload the page to see the effect.' : '',
    ];
    return { ok: failed.length === 0, message: parts.filter(Boolean).join(' ') };
  });
}

export interface IndexedDbInfo {
  name: string;
  version?: number;
  stores: { name: string; count: number }[];
  error?: string;
}

export interface SiteSnapshot {
  origin: string;
  cookies: chrome.cookies.Cookie[];
  localStorage: [string, string][];
  sessionStorage: [string, string][];
  indexedDB: IndexedDbInfo[];
  cacheStorage: { name: string; urls: string[]; total: number }[];
  serviceWorkers: { scope: string; scriptURL: string; state: string }[];
  /** Set when the page itself could not be read (cookies may still be listed). */
  pageError?: string;
}

type PageSnapshot = Omit<SiteSnapshot, 'origin' | 'cookies' | 'pageError'>;

/** Runs inside the page (isolated world, same storage as the page). Must be self-contained. */
async function readPageStorage(): Promise<PageSnapshot> {
  const entries = (s: Storage): [string, string][] =>
    Array.from({ length: s.length }, (_, i) => {
      const key = s.key(i) ?? '';
      return [key, s.getItem(key) ?? ''];
    });
  const withTimeout = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
  const request = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('request failed'));
    });

  const indexedDB: IndexedDbInfo[] = [];
  const list = typeof self.indexedDB?.databases === 'function' ? await self.indexedDB.databases() : [];
  for (const d of list) {
    if (!d.name) continue;
    const name = d.name;
    const info: IndexedDbInfo = { name, version: d.version, stores: [] };
    try {
      const db = await withTimeout(
        new Promise<IDBDatabase>((resolve, reject) => {
          const open = self.indexedDB.open(name);
          // The database was deleted meanwhile: do not create it.
          open.onupgradeneeded = () => open.transaction?.abort();
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error ?? new Error('open failed'));
          open.onblocked = () => reject(new Error('blocked by an open connection'));
        }),
        2000,
      );
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const count = await request(db.transaction(store, 'readonly').objectStore(store).count());
          info.stores.push({ name: store, count });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      info.error = String(err instanceof Error ? err.message : err);
    }
    indexedDB.push(info);
  }

  const cacheStorage: PageSnapshot['cacheStorage'] = [];
  if (typeof self.caches?.keys === 'function') {
    for (const name of await self.caches.keys()) {
      const keys = await (await self.caches.open(name)).keys();
      cacheStorage.push({ name, urls: keys.slice(0, 500).map((r) => r.url), total: keys.length });
    }
  }

  const serviceWorkers: PageSnapshot['serviceWorkers'] = [];
  if (navigator.serviceWorker) {
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      const worker = reg.active ?? reg.waiting ?? reg.installing;
      serviceWorkers.push({
        scope: reg.scope,
        scriptURL: worker?.scriptURL ?? '',
        state: worker?.state ?? 'unknown',
      });
    }
  }

  return {
    localStorage: entries(localStorage),
    sessionStorage: entries(sessionStorage),
    indexedDB,
    cacheStorage,
    serviceWorkers,
  };
}

/** Permissions needed to read the site's data. */
function accessRequest(pattern: string): chrome.permissions.Permissions {
  return { permissions: ['cookies'], origins: [pattern] };
}

export async function hasSiteDataAccess(url: string): Promise<boolean> {
  const policy = checkRecordableUrl(url);
  if (!policy.ok) return false;
  try {
    return await chrome.permissions.contains(accessRequest(policy.pattern));
  } catch {
    return false;
  }
}

/** Must be called directly from a click handler. */
export function requestSiteDataAccess(url: string): Promise<boolean> {
  const policy = checkRecordableUrl(url);
  if (!policy.ok) return Promise.resolve(false);
  return chrome.permissions.request(accessRequest(policy.pattern));
}

export async function readSiteData(tabId: number, url: string): Promise<SiteSnapshot> {
  const policy = checkRecordableUrl(url);
  if (!policy.ok) throw new Error(policy.message);
  const snapshot: SiteSnapshot = {
    origin: policy.origin,
    cookies: [],
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cacheStorage: [],
    serviceWorkers: [],
  };
  const [cookies, page] = await Promise.allSettled([
    chrome.cookies.getAll({ url: policy.origin }),
    chrome.scripting.executeScript({ target: { tabId }, func: readPageStorage }),
  ]);
  if (cookies.status === 'fulfilled') {
    snapshot.cookies = cookies.value.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (page.status === 'fulfilled' && page.value[0]?.result) {
    Object.assign(snapshot, page.value[0].result as PageSnapshot);
  } else {
    snapshot.pageError =
      page.status === 'rejected'
        ? String(page.reason instanceof Error ? page.reason.message : page.reason)
        : 'The page did not return its storage.';
  }
  return snapshot;
}

export type SiteItemKind = Exclude<SiteDataKind, 'cookies'>;

/** Runs inside the page. Must be self-contained. */
async function removePageItem(kind: SiteItemKind, key: string): Promise<boolean> {
  switch (kind) {
    case 'localStorage':
      localStorage.removeItem(key);
      return true;
    case 'sessionStorage':
      sessionStorage.removeItem(key);
      return true;
    case 'indexedDB':
      return new Promise((resolve) => {
        const r = indexedDB.deleteDatabase(key);
        r.onsuccess = () => resolve(true);
        r.onerror = () => resolve(false);
        // Deletion completes once the page closes its connections.
        r.onblocked = () => resolve(true);
      });
    case 'cacheStorage':
      return caches.delete(key);
    case 'serviceWorkers': {
      const reg = (await navigator.serviceWorker.getRegistrations()).find((r) => r.scope === key);
      return reg ? reg.unregister() : false;
    }
  }
}

/** Removes one storage key, IndexedDB database, cache or service worker (by scope). */
export async function removeSiteItem(tabId: number, kind: SiteItemKind, key: string): Promise<boolean> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: removePageItem,
    args: [kind, key],
  });
  return res?.result === true;
}
