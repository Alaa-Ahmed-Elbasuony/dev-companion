import type { CaptureSource, NetworkEntry } from '../shared/types';

export type StatusFilter =
  'all' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'failed' | 'pending';

export interface RequestFilter {
  text: string;
  methods: string[];
  status: StatusFilter;
  sources: CaptureSource[];
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Status code expression, e.g. `200, 4xx, 500-599, !404` (see parseStatusCodes). */
  codes?: string;
  /** Comma-separated host fragments; an entry matches when its host contains any of them. */
  hosts?: string;
  /** Substring of the response content type, e.g. `json`. */
  contentType?: string;
  /** Response body size bounds in bytes. */
  minSizeBytes?: number;
  maxSizeBytes?: number;
  hasWarnings?: boolean;
  redirected?: boolean;
}

export const EMPTY_FILTER: RequestFilter = { text: '', methods: [], status: 'all', sources: [] };

export type StatusClass = Exclude<StatusFilter, 'all'> | 'other';

export function statusClass(entry: NetworkEntry): StatusClass {
  if (entry.state === 'pending') return 'pending';
  if (entry.state !== 'complete') return 'failed';
  const s = entry.status ?? 0;
  if (s >= 200 && s < 300) return 'success';
  if (s >= 300 && s < 400) return 'redirect';
  if (s >= 400 && s < 500) return 'client-error';
  if (s >= 500) return 'server-error';
  return 'other';
}

export function isFailure(entry: NetworkEntry): boolean {
  const c = statusClass(entry);
  return c === 'failed' || c === 'client-error' || c === 'server-error';
}

export interface StatusCodeMatcher {
  include: [number, number][];
  exclude: [number, number][];
  invalid: string[];
}

/**
 * Parses a status code expression: comma/space separated codes (`404`), classes
 * (`4xx`) or ranges (`500-599`); a leading `!` or `-` excludes. Unrecognised
 * tokens are reported in `invalid` and otherwise ignored.
 */
export function parseStatusCodes(expr: string): StatusCodeMatcher {
  const out: StatusCodeMatcher = { include: [], exclude: [], invalid: [] };
  for (const raw of expr.split(/[\s,]+/).filter(Boolean)) {
    const negate = /^[!-]/.test(raw);
    const token = negate ? raw.slice(1) : raw;
    let range: [number, number] | undefined;
    let m: RegExpMatchArray | null;
    if ((m = /^([1-5])xx$/i.exec(token))) range = [Number(m[1]) * 100, Number(m[1]) * 100 + 99];
    else if ((m = /^(\d{3})-(\d{3})$/.exec(token))) range = [Number(m[1]), Number(m[2])];
    else if (/^\d{3}$/.test(token)) range = [Number(token), Number(token)];
    if (!range || range[0] > range[1]) out.invalid.push(raw);
    else (negate ? out.exclude : out.include).push(range);
  }
  return out;
}

function matchesStatusCodes(status: number | undefined, m: StatusCodeMatcher): boolean {
  const inRange = ([lo, hi]: [number, number]) => status !== undefined && status >= lo && status <= hi;
  if (m.exclude.some(inRange)) return false;
  return !m.include.length || m.include.some(inRange);
}

/** Splits a search query into tokens that must match and `-token`s that must not. */
export function parseQuery(text: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const t of text.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith('-')) exclude.push(t.slice(1));
    else include.push(t);
  }
  return { include, exclude };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Number of advanced (non-toolbar) criteria in use, for the toggle's badge. */
export function advancedFilterCount(f: RequestFilter): number {
  return [
    f.sources.length > 1,
    f.maxDurationMs !== undefined,
    !!f.codes?.trim(),
    !!f.hosts?.trim(),
    !!f.contentType?.trim(),
    f.minSizeBytes !== undefined || f.maxSizeBytes !== undefined,
    !!f.hasWarnings,
    !!f.redirected,
  ].filter(Boolean).length;
}

function searchableText(entry: NetworkEntry): string {
  return [
    entry.method,
    entry.url,
    entry.finalUrl ?? '',
    entry.status !== undefined ? String(entry.status) : '',
    entry.statusText ?? '',
    entry.state,
    entry.errorMessage ?? '',
    entry.source,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Whitespace-separated tokens must all match the entry's method, URL, status or
 * error text. An entry also matches when its id is in `bodyMatches` (captured
 * body text matched the whole query).
 */
export function matchesFilter(
  entry: NetworkEntry,
  filter: RequestFilter,
  bodyMatches?: Set<string>,
): boolean {
  if (filter.methods.length && !filter.methods.includes(entry.method)) return false;
  if (filter.sources.length && !filter.sources.includes(entry.source)) return false;
  if (filter.status !== 'all' && statusClass(entry) !== filter.status) return false;
  if (filter.minDurationMs !== undefined && (entry.duration ?? -1) < filter.minDurationMs) return false;
  if (filter.maxDurationMs !== undefined && (entry.duration ?? Infinity) > filter.maxDurationMs) return false;
  if (filter.codes?.trim() && !matchesStatusCodes(entry.status, parseStatusCodes(filter.codes))) return false;
  if (filter.hosts?.trim()) {
    const host = hostOf(entry.url);
    const wanted = filter.hosts
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (!wanted.some((h) => host.includes(h))) return false;
  }
  if (
    filter.contentType?.trim() &&
    !(entry.responseContentType ?? '').toLowerCase().includes(filter.contentType.trim().toLowerCase())
  )
    return false;
  if (filter.minSizeBytes !== undefined && (entry.responseBodySize ?? -1) < filter.minSizeBytes) return false;
  if (filter.maxSizeBytes !== undefined && (entry.responseBodySize ?? Infinity) > filter.maxSizeBytes)
    return false;
  if (filter.hasWarnings && !entry.warnings.length) return false;
  if (filter.redirected && !entry.redirected) return false;
  const { include, exclude } = parseQuery(filter.text);
  if (!include.length && !exclude.length) return true;
  const haystack = searchableText(entry);
  if (exclude.some((t) => haystack.includes(t))) return false;
  if (include.every((t) => haystack.includes(t))) return true;
  return bodyMatches?.has(entry.id) ?? false;
}

export function filterEntries(
  entries: NetworkEntry[],
  filter: RequestFilter,
  bodyMatches?: Set<string>,
): NetworkEntry[] {
  return entries.filter((e) => matchesFilter(e, filter, bodyMatches));
}
