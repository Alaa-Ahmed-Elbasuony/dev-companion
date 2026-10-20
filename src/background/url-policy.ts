// Decides which pages may be recorded. Chrome forbids injection into browser
// pages and the extension stores; we only support http(s) pages.

const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'microsoftedge.microsoft.com'];

export type UrlPolicyResult = { ok: true; origin: string; pattern: string } | { ok: false; message: string };

export function originToPattern(origin: string): string {
  const u = new URL(origin);
  // Match patterns cannot contain ports; the pattern covers every port of the host.
  return `${u.protocol}//${u.hostname}/*`;
}

export function checkRecordableUrl(url: string | undefined): UrlPolicyResult {
  if (!url) return { ok: false, message: 'This tab has no accessible URL.' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: 'This tab has an invalid URL.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      message: `Pages using ${u.protocol} cannot be recorded. Chrome does not allow extensions to inject scripts into browser, extension or file pages.`,
    };
  }
  if (
    RESTRICTED_HOSTS.includes(u.hostname) ||
    (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))
  ) {
    return { ok: false, message: 'Chrome does not allow extensions to run on extension store pages.' };
  }
  return { ok: true, origin: u.origin, pattern: originToPattern(u.origin) };
}
