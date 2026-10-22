// @vitest-environment jsdom
// Reading a site's cookies and storage for the Storage view, and removing single items.
// The fake executeScript runs the injected function here, against jsdom's storage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSiteDataAccess, readSiteData, removeSiteItem } from '../../src/ui/lib/site-data';

function install() {
  const fake = {
    permissions: { contains: vi.fn(async () => true) },
    cookies: {
      getAll: vi.fn(async () => [
        { name: 'z', value: '1', domain: 'a.test', path: '/', secure: true, storeId: '0' },
        { name: 'a', value: '2', domain: 'a.test', path: '/', secure: true, storeId: '0' },
      ]),
    },
    scripting: {
      executeScript: vi.fn(async (inj: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [
        { result: await inj.func(...(inj.args ?? [])) },
      ]),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

describe('reading site data', () => {
  let fake: ReturnType<typeof install>;
  beforeEach(() => {
    fake = install();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('checks the cookies permission and host access', async () => {
    expect(await hasSiteDataAccess('https://a.test/x')).toBe(true);
    expect(fake.permissions.contains).toHaveBeenCalledWith({
      permissions: ['cookies'],
      origins: ['https://a.test/*'],
    });
    expect(await hasSiteDataAccess('chrome://settings')).toBe(false);
  });

  it('returns sorted cookies and the page storage', async () => {
    localStorage.setItem('token', '{"a":1}');
    sessionStorage.setItem('step', '2');
    const snap = await readSiteData(4, 'https://a.test/page');
    expect(fake.cookies.getAll).toHaveBeenCalledWith({ url: 'https://a.test' });
    expect(snap.cookies.map((c) => c.name)).toEqual(['a', 'z']);
    expect(snap.localStorage).toEqual([['token', '{"a":1}']]);
    expect(snap.sessionStorage).toEqual([['step', '2']]);
    expect(snap.pageError).toBeUndefined();
  });

  it('still lists cookies when the page cannot be read', async () => {
    fake.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    const snap = await readSiteData(4, 'https://a.test/');
    expect(snap.cookies).toHaveLength(2);
    expect(snap.pageError).toBe('Cannot access a chrome:// URL');
  });

  it('removes a single storage key in the tab', async () => {
    localStorage.setItem('keep', '1');
    localStorage.setItem('drop', '2');
    expect(await removeSiteItem(4, 'localStorage', 'drop')).toBe(true);
    expect(fake.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4 }, args: ['localStorage', 'drop'] }),
    );
    expect(localStorage.getItem('drop')).toBeNull();
    expect(localStorage.getItem('keep')).toBe('1');
  });
});
