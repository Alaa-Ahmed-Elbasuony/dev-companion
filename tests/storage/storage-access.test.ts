// chrome.storage.local is closed to content scripts: the worker restricts it on
// start, and nothing that runs in a page depends on extension storage.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restrictLocalStorageAccess } from '../../src/background/storage-access';

afterEach(() => vi.restoreAllMocks());

describe('restrictLocalStorageAccess', () => {
  it('limits local storage to extension pages and the worker', async () => {
    const setAccessLevel = vi.fn(async () => undefined);
    const local = { setAccessLevel };
    expect(await restrictLocalStorageAccess({ local })).toBe('restricted');
    expect(setAccessLevel).toHaveBeenCalledOnce();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Called as a method, as Chrome's bindings require.
    expect(setAccessLevel.mock.contexts[0]).toBe(local);
  });

  it('keeps working where Chrome has no access levels for local storage', async () => {
    expect(await restrictLocalStorageAccess({ local: {} })).toBe('unsupported');
    expect(await restrictLocalStorageAccess({})).toBe('unsupported');
    expect(await restrictLocalStorageAccess(undefined)).toBe('unsupported');
  });

  it('never rejects when Chrome refuses the change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const setAccessLevel = vi.fn(async () => {
      throw new Error('This StorageArea is not available for setting access level');
    });
    expect(await restrictLocalStorageAccess({ local: { setAccessLevel } })).toBe('failed');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not touch the area otherwise (reads and writes are unchanged)', async () => {
    const get = vi.fn();
    const set = vi.fn();
    await restrictLocalStorageAccess({ local: { setAccessLevel: async () => undefined, get, set } });
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('scripts that run in pages', () => {
  // The bundles Chrome injects (see scripts/build.mjs), including everything they import.
  const entries = {
    'content-script (bridge)': { entry: 'src/content/content-script.ts', define: {} },
    'main-world recorder': { entry: 'src/capture/main-world.ts', define: {} },
    'armed main-world recorder': {
      entry: 'src/capture/main-world.ts',
      define: { __DC_SIMULATION_ARMED__: 'true' },
    },
  };

  it.each(Object.entries(entries))('%s never uses extension storage', async (_name, { entry, define }) => {
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, '../..', entry)],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      define,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]!.text;
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/\bstorage\s*\.\s*(local|session|sync|managed|onChanged)\b/);
    expect(code).not.toMatch(/chrome\s*\.\s*storage/);
  });
});
