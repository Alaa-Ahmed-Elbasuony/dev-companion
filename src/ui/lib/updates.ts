// Tells people who built the extension from a git checkout that the repository
// has newer extension changes. The build records its commit in build-info.json;
// this asks GitHub's public compare API what changed on the branch since then.
import { useCallback, useEffect, useState } from 'react';
import { loadSettings } from './extension';

export interface BuildInfo {
  commit: string | null;
  branch: string | null;
  /** "owner/name" on GitHub. */
  repo: string | null;
  builtAt: number;
}

export interface UpdateCommit {
  sha: string;
  message: string;
  date: string;
  url: string;
}

export interface UpdateStatus {
  /** The build this status was computed for. */
  commit: string;
  checkedAt: number;
  available: boolean;
  /** Newest commit on the branch, used to remember a dismissal. */
  latestSha: string;
  /** Extension-relevant commits since the build, newest first (merge commits left out). */
  commits: UpdateCommit[];
  compareUrl: string;
  error?: string;
}

const STATUS_KEY = 'updateStatus';
const DISMISSED_KEY = 'updateDismissed';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Changes outside these paths (docs, examples, tests) do not need a rebuild. */
const RELEVANT = /^(src\/|scripts\/|package(-lock)?\.json$|vite\.config\.ts$|tsconfig\.json$)/;
/** GitHub lists at most 300 files per comparison; past that, assume the extension changed. */
const MAX_FILES = 300;

interface CompareResponse {
  ahead_by: number;
  html_url: string;
  commits: {
    sha: string;
    html_url: string;
    parents: unknown[];
    commit: { message: string; author?: { date?: string }; committer?: { date?: string } };
  }[];
  files?: { filename: string }[];
}

let buildInfoPromise: Promise<BuildInfo | null> | null = null;
export function loadBuildInfo(): Promise<BuildInfo | null> {
  buildInfoPromise ??= fetch(chrome.runtime.getURL('build-info.json'))
    .then((r) => (r.ok ? (r.json() as Promise<BuildInfo>) : null))
    .catch(() => null);
  return buildInfoPromise;
}

export function compareToStatus(commit: string, body: CompareResponse, now = Date.now()): UpdateStatus {
  const files = body.files ?? [];
  const relevant = files.length >= MAX_FILES || files.some((f) => RELEVANT.test(f.filename));
  const commits = body.commits
    .filter((c) => c.parents.length < 2)
    .map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0] ?? '',
      date: c.commit.committer?.date ?? c.commit.author?.date ?? '',
      url: c.html_url,
    }))
    .reverse();
  return {
    commit,
    checkedAt: now,
    available: body.ahead_by > 0 && relevant,
    latestSha: body.commits.at(-1)?.sha ?? commit,
    commits,
    compareUrl: body.html_url,
  };
}

/**
 * Returns the cached status, or asks GitHub when it is older than six hours
 * (or `force` is set). Returns null when checks are off or this build has no
 * commit (not built from a git checkout).
 */
export async function checkForUpdate(force = false): Promise<UpdateStatus | null> {
  const [settings, build] = await Promise.all([loadSettings(), loadBuildInfo()]);
  if ((!settings.checkForUpdates && !force) || !build?.commit || !build.repo) return null;
  const cached = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] as UpdateStatus | undefined;
  const fresh = cached?.commit === build.commit && Date.now() - cached.checkedAt < CHECK_EVERY_MS;
  if (cached && fresh && !force) return cached;

  const branch = build.branch && build.branch !== 'HEAD' ? build.branch : 'main';
  let status: UpdateStatus;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${build.repo}/compare/${build.commit}...${encodeURIComponent(branch)}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (res.status === 404) {
      // The build's commit is not on GitHub (local, unpushed work): nothing to compare.
      status = {
        commit: build.commit,
        checkedAt: Date.now(),
        available: false,
        latestSha: build.commit,
        commits: [],
        compareUrl: `https://github.com/${build.repo}`,
      };
    } else if (!res.ok) {
      throw new Error(
        res.status === 403 ? 'GitHub rate limit reached; try again later' : `GitHub responded ${res.status}`,
      );
    } else {
      status = compareToStatus(build.commit, (await res.json()) as CompareResponse);
    }
  } catch (err) {
    // Keep what we knew; just record the failure.
    status = {
      ...(cached?.commit === build.commit
        ? cached
        : {
            commit: build.commit,
            available: false,
            latestSha: build.commit,
            commits: [],
            compareUrl: `https://github.com/${build.repo}`,
          }),
      checkedAt: Date.now(),
      error: String(err instanceof Error ? err.message : err),
    };
  }
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

/** Update status for the banner: checks on mount, and follows checks made by other pages. */
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    void checkForUpdate()
      .then(setStatus)
      .catch(() => undefined);
    void chrome.storage.local
      .get(DISMISSED_KEY)
      .then((d) => setDismissed((d[DISMISSED_KEY] as string | undefined) ?? null))
      .catch(() => undefined);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes[STATUS_KEY]) setStatus((changes[STATUS_KEY].newValue as UpdateStatus | undefined) ?? null);
      if (changes[DISMISSED_KEY])
        setDismissed((changes[DISMISSED_KEY].newValue as string | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const dismiss = useCallback(() => {
    if (status) void chrome.storage.local.set({ [DISMISSED_KEY]: status.latestSha });
  }, [status]);
  const checkNow = useCallback(() => checkForUpdate(true).then(setStatus), []);

  // A dismissal hides the banner until something newer lands.
  const show = !!status?.available && status.latestSha !== dismissed;
  return { status, show, dismiss, checkNow };
}

/** Opens Chrome's extensions page on this extension, where the reload button is. */
export function openExtensionsPage() {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}
