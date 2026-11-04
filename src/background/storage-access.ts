// chrome.storage.local holds settings and simulation rules. Content scripts never
// read it (the bridge gets its capture config from the worker), so it is closed
// to them: Chrome then refuses storage.local in every content script, including
// one running in a compromised renderer. Chrome forgets the setting when the
// extension reloads, so the worker applies it each time it starts.

export type StorageAccessResult = 'restricted' | 'unsupported' | 'failed';

type AccessLevelArea = { setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void> };

/** Never rejects: without the restriction, storage keeps Chrome's default access. */
export async function restrictLocalStorageAccess(
  storage: { local?: unknown } | undefined = globalThis.chrome?.storage,
): Promise<StorageAccessResult> {
  const local = storage?.local as AccessLevelArea | undefined;
  if (typeof local?.setAccessLevel !== 'function') return 'unsupported';
  try {
    await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return 'restricted';
  } catch (err) {
    console.warn('Dev Companion: could not restrict chrome.storage.local to extension contexts', err);
    return 'failed';
  }
}
