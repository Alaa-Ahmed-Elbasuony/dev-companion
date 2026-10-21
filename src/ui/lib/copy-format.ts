// Turns what the UI shows into what developers expect on the clipboard:
// pretty-printed JSON, `Name: value` header blocks, query strings as objects.
import type { HeaderPair } from '../../shared/types';

/** JSON objects/arrays are re-indented with 2 spaces; any other text is kept verbatim. */
export function prettyForCopy(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : text;
  } catch {
    return text;
  }
}

/** Strings verbatim (pretty-printed when they hold JSON), everything else as indented JSON. */
export function valueForCopy(value: unknown): string {
  if (typeof value === 'string') return prettyForCopy(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** One `Name: value` per line, the format HTTP tools and the Replay dialog accept. */
export function headersForCopy(headers: HeaderPair[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join('\n');
}

/** Generic name/value rows as `name: value` lines. */
export function rowsForCopy(rows: { name: string; value: string }[]): string {
  return rows.map((r) => `${r.name}: ${r.value}`).join('\n');
}

/** Query parameters as a JSON object; repeated keys become arrays. */
export function queryForCopy(params: Iterable<[string, string]>): string {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of params) {
    const prev = out[name];
    out[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return JSON.stringify(out, null, 2);
}

/** Map/record of attributes as indented JSON. */
export function recordForCopy(record: Record<string, unknown>): string {
  return JSON.stringify(record, null, 2);
}
