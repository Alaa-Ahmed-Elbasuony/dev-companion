// Clearing a site's cookies and storage from the dashboard header.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_SITE_DATA_KINDS, clearSiteData, cookieUrl } from '../../src/ui/lib/site-data';

function install(granted = true) {
  const fake = {
    permissions: { request: vi.fn(async () => granted) },
    cookies: {
      getAll: vi.fn(async () => [
        { name: 'sid', domain: '.example.com', path: '/', secure: true, storeId: '0' },
        { name: 'theme', domain: 'app.example.com', path: '/ui', secure: false, storeId: '0' },
      ]),
      remove: vi.fn(async (d: { name: string }) => d),
    },
    browsingData: { remove: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => []) },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

describe('site data', () => {
  let fake: ReturnType<typeof install>;
  beforeEach(() => {
    fake = install();
  });

  it('builds the cookie URL from domain, path and secure flag', () => {
    expect(cookieUrl({ domain: '.example.com', path: '/', secure: true })).toBe('https://example.com/');
    expect(cookieUrl({ domain: 'a.example.com', path: '/x', secure: false })).toBe('http://a.example.com/x');
  });

  it('removes only the cookies the site receives', async () => {
    const result = await clearSiteData(3, 'https://app.example.com/page', ['cookies']);
    expect(fake.permissions.request).toHaveBeenCalledWith({
      permissions: ['cookies'],
      origins: ['https://app.example.com/*'],
    });
    expect(fake.cookies.getAll).toHaveBeenCalledWith({ url: 'https://app.example.com' });
    expect(fake.cookies.remove).toHaveBeenCalledWith({
      url: 'https://example.com/',
      name: 'sid',
      storeId: '0',
    });
    expect(fake.cookies.remove).toHaveBeenCalledWith({
      url: 'http://app.example.com/ui',
      name: 'theme',
      storeId: '0',
    });
    expect(fake.browsingData.remove).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, message: expect.stringContaining('2 cookies for app.example.com') });
  });

  it('clears storage types for the origin only', async () => {
    await clearSiteData(3, 'https://app.example.com/', ['localStorage', 'indexedDB']);
    expect(fake.browsingData.remove).toHaveBeenCalledWith(
      { origins: ['https://app.example.com'] },
      { localStorage: true, indexedDB: true },
    );
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('clears session storage inside the tab', async () => {
    await clearSiteData(7, 'http://localhost:5173/', ['sessionStorage']);
    expect(fake.permissions.request).toHaveBeenCalledWith({
      permissions: [],
      origins: ['http://localhost/*'],
    });
    expect(fake.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('clears everything and reports failures', async () => {
    fake.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access contents'));
    const result = await clearSiteData(3, 'https://app.example.com/', ALL_SITE_DATA_KINDS);
    expect(fake.browsingData.remove).toHaveBeenCalledWith(
      { origins: ['https://app.example.com'] },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('session storage (Cannot access contents)');
  });

  it('stops when permission is denied or the page is not http(s)', async () => {
    fake = install(false);
    expect((await clearSiteData(3, 'https://a.test/', ['cookies'])).ok).toBe(false);
    expect(fake.cookies.getAll).not.toHaveBeenCalled();
    expect((await clearSiteData(3, 'chrome://settings', ['cookies'])).ok).toBe(false);
  });
});
