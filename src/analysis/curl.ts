import { REDACTED } from '../shared/settings';
import type { EntryBodies, HeaderPair, NetworkEntry } from '../shared/types';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface CurlInput {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
}

/** Builds a POSIX-shell cURL command. Headers with redacted values are omitted. */
export function buildCurl(input: CurlInput): { command: string; omittedHeaders: string[] } {
  const parts = ['curl'];
  const method = input.method.toUpperCase();
  if (method !== 'GET' || input.body !== undefined) parts.push('-X', method);
  parts.push(shellQuote(input.url));
  const omittedHeaders: string[] = [];
  for (const h of input.headers) {
    if (h.value.includes(REDACTED)) {
      omittedHeaders.push(h.name);
      continue;
    }
    parts.push('-H', shellQuote(`${h.name}: ${h.value}`));
  }
  if (input.body !== undefined) parts.push('--data-raw', shellQuote(input.body));
  return { command: parts.join(' '), omittedHeaders };
}

export type CurlResult = { ok: true; command: string; notes: string[] } | { ok: false; reason: string };

export function curlForEntry(entry: NetworkEntry, bodies: EntryBodies | undefined): CurlResult {
  const req = bodies?.request;
  if (req && req.kind !== 'none') {
    if (req.text === undefined) {
      return {
        ok: false,
        reason: `The request body (${req.kind}) was not captured, so cURL cannot reproduce it.`,
      };
    }
    if (req.truncated) {
      return { ok: false, reason: 'The request body was truncated, so cURL would send a different payload.' };
    }
  }
  const { command, omittedHeaders } = buildCurl({
    method: entry.method,
    url: entry.url,
    headers: entry.requestHeaders,
    body: req?.text,
  });
  const notes: string[] = [];
  if (omittedHeaders.length) notes.push(`Omitted redacted headers: ${omittedHeaders.join(', ')}`);
  notes.push('Cookies and browser-added headers are not included.');
  return { ok: true, command, notes };
}
