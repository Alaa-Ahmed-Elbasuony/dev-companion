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

/**
 * Builds a POSIX-shell cURL command, one option per line with `\` continuations.
 * Headers with redacted values are omitted.
 */
export function buildCurl(input: CurlInput): { command: string; omittedHeaders: string[] } {
  const lines = [`curl ${shellQuote(input.url)}`];
  const method = input.method.toUpperCase();
  if (method !== 'GET' || input.body !== undefined) lines.push(`-X ${method}`);
  const omittedHeaders: string[] = [];
  for (const h of input.headers) {
    if (h.value.includes(REDACTED)) {
      omittedHeaders.push(h.name);
      continue;
    }
    lines.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  if (input.body !== undefined) lines.push(`--data-raw ${shellQuote(input.body)}`);
  return { command: lines.join(' \\\n  '), omittedHeaders };
}

/**
 * Builds a `fetch(...)` call. JSON bodies are written as an indented
 * `JSON.stringify(...)` literal so they are easy to edit. Redacted headers are omitted.
 */
export function buildFetch(input: CurlInput): { code: string; omittedHeaders: string[] } {
  const method = input.method.toUpperCase();
  const omittedHeaders: string[] = [];
  const headers: Record<string, string> = {};
  for (const h of input.headers) {
    if (h.value.includes(REDACTED)) omittedHeaders.push(h.name);
    else headers[h.name] = h.value;
  }
  const indent = (text: string) => text.replace(/\n/g, '\n  ');
  const options: string[] = [];
  if (method !== 'GET') options.push(`method: ${JSON.stringify(method)}`);
  if (Object.keys(headers).length) options.push(`headers: ${indent(JSON.stringify(headers, null, 2))}`);
  if (input.body !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(input.body);
    } catch {
      json = undefined;
    }
    options.push(
      typeof json === 'object' && json !== null
        ? `body: JSON.stringify(${indent(JSON.stringify(json, null, 2))})`
        : `body: ${JSON.stringify(input.body)}`,
    );
  }
  const code = options.length
    ? `await fetch(${JSON.stringify(input.url)}, {\n  ${options.join(',\n  ')},\n});`
    : `await fetch(${JSON.stringify(input.url)});`;
  return { code, omittedHeaders };
}

export type CurlResult = { ok: true; command: string; notes: string[] } | { ok: false; reason: string };

/** Why a captured request body cannot be reproduced by `tool`, or null when it can. */
function unreproducibleBody(bodies: EntryBodies | undefined, tool: string): string | null {
  const req = bodies?.request;
  if (!req || req.kind === 'none') return null;
  if (req.text === undefined) {
    return `The request body (${req.kind}) was not captured, so ${tool} cannot reproduce it.`;
  }
  if (req.truncated) return `The request body was truncated, so ${tool} would send a different payload.`;
  return null;
}

export function curlForEntry(entry: NetworkEntry, bodies: EntryBodies | undefined): CurlResult {
  const reason = unreproducibleBody(bodies, 'cURL');
  if (reason) return { ok: false, reason };
  const { command, omittedHeaders } = buildCurl({
    method: entry.method,
    url: entry.url,
    headers: entry.requestHeaders,
    body: bodies?.request?.text,
  });
  const notes: string[] = [];
  if (omittedHeaders.length) notes.push(`Omitted redacted headers: ${omittedHeaders.join(', ')}`);
  notes.push('Cookies and browser-added headers are not included.');
  return { ok: true, command, notes };
}

export function fetchForEntry(entry: NetworkEntry, bodies: EntryBodies | undefined): CurlResult {
  const reason = unreproducibleBody(bodies, 'fetch');
  if (reason) return { ok: false, reason };
  const { code, omittedHeaders } = buildFetch({
    method: entry.method,
    url: entry.url,
    headers: entry.requestHeaders,
    body: bodies?.request?.text,
  });
  const notes = omittedHeaders.length ? [`Omitted redacted headers: ${omittedHeaders.join(', ')}`] : [];
  return { ok: true, command: code, notes };
}
