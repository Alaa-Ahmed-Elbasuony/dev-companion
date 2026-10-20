import type { CaptureSource, NetworkEntry } from '../shared/types';

export type StatusFilter =
  'all' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'failed' | 'pending';

export interface RequestFilter {
  text: string;
  methods: string[];
  status: StatusFilter;
  sources: CaptureSource[];
  minDurationMs?: number;
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
  const query = filter.text.trim().toLowerCase();
  if (!query) return true;
  const haystack = searchableText(entry);
  const tokens = query.split(/\s+/);
  if (tokens.every((t) => haystack.includes(t))) return true;
  return bodyMatches?.has(entry.id) ?? false;
}

export function filterEntries(
  entries: NetworkEntry[],
  filter: RequestFilter,
  bodyMatches?: Set<string>,
): NetworkEntry[] {
  return entries.filter((e) => matchesFilter(e, filter, bodyMatches));
}
