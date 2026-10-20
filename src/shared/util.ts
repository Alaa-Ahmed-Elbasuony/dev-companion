// Small dependency-free helpers usable in every context (page, worker, UI).

export function createId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Truncates a string to at most maxBytes UTF-8 bytes (approximately, by code units). */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Length(text) <= maxBytes) return { text, truncated: false };
  // Binary search the largest prefix that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Length(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function safeUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

export function originOf(url: string): string {
  return safeUrl(url)?.origin ?? '';
}

export function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('x-www-form-urlencoded') ||
    ct.includes('graphql') ||
    ct.includes('yaml') ||
    ct.includes('csv')
  );
}

export function isJsonContentType(contentType: string | undefined): boolean {
  return !!contentType && /json/i.test(contentType);
}

export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function headerValue(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9a-z]{20,})$/i;

/** Groups requests by method + host + path with id-like segments replaced by ":id". */
export function endpointKey(method: string, url: string): string {
  const u = safeUrl(url);
  if (!u) return `${method.toUpperCase()} ${url}`;
  const path = u.pathname
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/');
  return `${method.toUpperCase()} ${u.host}${path}`;
}

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
