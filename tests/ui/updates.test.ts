// Update check for builds made from a git checkout: compares the build's commit
// with the branch on GitHub and reports only extension-relevant changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Updates from '../../src/ui/lib/updates';

const BUILD = { commit: 'aaa111', branch: 'main', repo: 'owner/dev-companion', builtAt: 1 };

function compare(files: string[], commits = [{ sha: 'bbb222', message: 'Fix the popup\n\nDetails' }]) {
  return {
    ahead_by: commits.length,
    html_url: 'https://github.com/owner/dev-companion/compare/aaa111...main',
    commits: commits.map((c) => ({
      sha: c.sha,
      html_url: `https://github.com/owner/dev-companion/commit/${c.sha}`,
      parents: [{}],
      commit: { message: c.message, committer: { date: '2026-10-20T10:00:00Z' } },
    })),
    files: files.map((filename) => ({ filename })),
  };
}

let local: Map<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let updates: typeof Updates;

async function setup(build: unknown = BUILD, settings: unknown = undefined) {
  local = new Map(settings ? [['settings', settings]] : []);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, id: 'x' },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, v);
        }),
      },
    },
  };
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith('build-info.json')
      ? new Response(JSON.stringify(build))
      : new Response(JSON.stringify(compare(['src/ui/popup/Popup.tsx', 'README.md']))),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  updates = await import('../../src/ui/lib/updates');
}

describe('update check', () => {
  beforeEach(async () => {
    await setup();
  });

  it('reports newer extension changes with their commits', async () => {
    const status = await updates.checkForUpdate();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/dev-companion/compare/aaa111...main',
      expect.anything(),
    );
    expect(status).toMatchObject({
      available: true,
      latestSha: 'bbb222',
      commits: [{ sha: 'bbb222', message: 'Fix the popup' }],
    });
  });

  it('ignores changes that only touch docs, tests or examples', () => {
    const status = updates.compareToStatus(
      'aaa111',
      compare(['README.md', 'docs/USER_GUIDE.md', 'tests/x.ts']),
    );
    expect(status.available).toBe(false);
  });

  it('lists newest commits first and leaves out merge commits', () => {
    const body = compare(
      ['src/a.ts'],
      [
        { sha: 'c1', message: 'First' },
        { sha: 'c2', message: 'Merge pull request #2' },
        { sha: 'c3', message: 'Third' },
      ],
    );
    body.commits[1]!.parents = [{}, {}];
    const status = updates.compareToStatus('aaa111', body);
    expect(status.commits.map((c) => c.sha)).toEqual(['c3', 'c1']);
    expect(status.latestSha).toBe('c3');
  });

  it('uses the cached result for six hours unless forced', async () => {
    await updates.checkForUpdate();
    await updates.checkForUpdate();
    const githubCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes('api.github.com')).length;
    expect(githubCalls()).toBe(1);
    await updates.checkForUpdate(true);
    expect(githubCalls()).toBe(2);
  });

  it('treats a commit unknown to GitHub (local work) as up to date', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('build-info.json')
        ? new Response(JSON.stringify(BUILD))
        : new Response('', { status: 404 }),
    );
    expect(await updates.checkForUpdate()).toMatchObject({ available: false });
  });

  it('records a rate-limit failure without losing the previous result', async () => {
    await updates.checkForUpdate();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('build-info.json')
        ? new Response(JSON.stringify(BUILD))
        : new Response('', { status: 403 }),
    );
    const status = await updates.checkForUpdate(true);
    expect(status).toMatchObject({ available: true, error: expect.stringContaining('rate limit') });
  });

  it('does not check development builds with uncommitted source changes', async () => {
    await setup({ ...BUILD, dirty: true });
    expect(await updates.checkForUpdate(true)).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.github.com'))).toBe(false);
  });

  it('does nothing when turned off or without a git commit', async () => {
    await setup(BUILD, { checkForUpdates: false });
    expect(await updates.checkForUpdate()).toBeNull();
    await setup({ ...BUILD, commit: null });
    expect(await updates.checkForUpdate(true)).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.github.com'))).toBe(false);
  });
});
