// In-memory stand-in for the chrome.* APIs used by the recording controller.
import { vi } from 'vitest';

export function installFakeChrome(opts: { grantedPatterns?: string[] } = {}) {
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>();
  const registered = new Map<string, chrome.scripting.RegisteredContentScript>();
  const granted = new Set(opts.grantedPatterns ?? []);
  const tabMessages: { tabId: number; message: unknown }[] = [];
  const badges = new Map<number, string>();
  const executed: { tabId: number; files: string[]; world?: string }[] = [];

  const fake = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
        }),
      },
      session: {
        get: vi.fn(async (key: string) =>
          session.has(key) ? { [key]: structuredClone(session.get(key)) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
        }),
        remove: vi.fn(async (key: string) => {
          session.delete(key);
        }),
      },
    },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => origins.every((o) => granted.has(o))),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async ({ ids }: { ids: string[] }) =>
        ids.filter((id) => registered.has(id)).map((id) => registered.get(id)!),
      ),
      registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
        for (const s of scripts) {
          if (registered.has(s.id)) throw new Error(`Duplicate script id ${s.id}`);
          registered.set(s.id, s);
        }
      }),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
        for (const id of ids) registered.delete(id);
      }),
      executeScript: vi.fn(async (inj: { target: { tabId: number }; files: string[]; world?: string }) => {
        executed.push({ tabId: inj.target.tabId, files: inj.files, world: inj.world });
        return [];
      }),
    },
    tabs: {
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        tabMessages.push({ tabId, message });
      }),
    },
    action: {
      setBadgeText: vi.fn(async ({ tabId, text }: { tabId: number; text: string }) => {
        badges.set(tabId, text);
      }),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { fake, session, local, registered, granted, tabMessages, badges, executed };
}
