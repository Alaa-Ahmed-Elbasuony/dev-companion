// Structural comparison of two captured requests/responses.
import type { CapturedBody, EntryBodies, HeaderPair, NetworkEntry } from '../shared/types';
import { tryParseJson } from '../shared/util';

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'undefined';

export function typeOf(value: unknown): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object' || t === 'undefined') return t;
  return 'string';
}

export interface JsonChange {
  path: string;
  kind: 'added' | 'removed' | 'type-changed' | 'value-changed';
  before?: unknown;
  after?: unknown;
  beforeType?: ValueType;
  afterType?: ValueType;
}

const keyPath = (base: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

export function diffJson(a: unknown, b: unknown, maxChanges = 500): JsonChange[] {
  const changes: JsonChange[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (changes.length >= maxChanges) return;
    const tx = typeOf(x);
    const ty = typeOf(y);
    if (tx !== ty) {
      changes.push({ path, kind: 'type-changed', before: x, after: y, beforeType: tx, afterType: ty });
      return;
    }
    if (tx === 'object') {
      const ox = x as Record<string, unknown>;
      const oy = y as Record<string, unknown>;
      for (const key of Object.keys(ox)) {
        const p = keyPath(path, key);
        if (!Object.hasOwn(oy, key))
          changes.push({ path: p, kind: 'removed', before: ox[key], beforeType: typeOf(ox[key]) });
        else walk(ox[key], oy[key], p);
      }
      for (const key of Object.keys(oy)) {
        if (!Object.hasOwn(ox, key)) {
          changes.push({
            path: keyPath(path, key),
            kind: 'added',
            after: oy[key],
            afterType: typeOf(oy[key]),
          });
        }
      }
      return;
    }
    if (tx === 'array') {
      const ax = x as unknown[];
      const ay = y as unknown[];
      const n = Math.min(Math.max(ax.length, ay.length), 200);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        if (i >= ax.length) changes.push({ path: p, kind: 'added', after: ay[i], afterType: typeOf(ay[i]) });
        else if (i >= ay.length)
          changes.push({ path: p, kind: 'removed', before: ax[i], beforeType: typeOf(ax[i]) });
        else walk(ax[i], ay[i], p);
      }
      return;
    }
    if (x !== y)
      changes.push({ path, kind: 'value-changed', before: x, after: y, beforeType: tx, afterType: ty });
  };
  walk(a, b, '$');
  return changes;
}

export interface HeaderDiff {
  added: HeaderPair[];
  removed: HeaderPair[];
  changed: { name: string; before: string; after: string }[];
}

/** Headers that typically differ between any two responses. */
export const VOLATILE_HEADERS = new Set([
  'date',
  'age',
  'etag',
  'last-modified',
  'expires',
  'x-request-id',
  'cf-ray',
  'server-timing',
  'content-length',
  'x-amzn-requestid',
  'traceparent',
]);

export function diffHeaders(a: HeaderPair[], b: HeaderPair[]): HeaderDiff {
  const map = (list: HeaderPair[]) => {
    const m = new Map<string, string>();
    for (const h of list) {
      const k = h.name.toLowerCase();
      m.set(k, m.has(k) ? `${m.get(k)}, ${h.value}` : h.value);
    }
    return m;
  };
  const ma = map(a);
  const mb = map(b);
  const diff: HeaderDiff = { added: [], removed: [], changed: [] };
  for (const [name, value] of ma) {
    if (!mb.has(name)) diff.removed.push({ name, value });
    else if (mb.get(name) !== value) diff.changed.push({ name, before: value, after: mb.get(name)! });
  }
  for (const [name, value] of mb) if (!ma.has(name)) diff.added.push({ name, value });
  return diff;
}

export type BodyDiff =
  | { mode: 'json'; changes: JsonChange[] }
  | { mode: 'text'; identical: boolean }
  | { mode: 'unavailable'; reason: string };

function parsedJson(body: CapturedBody | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!body?.text || body.truncated) return { ok: false };
  return tryParseJson(body.text);
}

export function diffBodies(a: CapturedBody | undefined, b: CapturedBody | undefined): BodyDiff {
  if (!a?.text && !b?.text) return { mode: 'unavailable', reason: 'Neither body was captured as text.' };
  if (a?.truncated || b?.truncated) {
    return {
      mode: 'unavailable',
      reason: 'At least one body was truncated; a structural comparison would be unreliable.',
    };
  }
  const ja = parsedJson(a);
  const jb = parsedJson(b);
  if (ja.ok && jb.ok) return { mode: 'json', changes: diffJson(ja.value, jb.value) };
  return { mode: 'text', identical: (a?.text ?? '') === (b?.text ?? '') };
}

export interface EntryComparison {
  status: { a?: number; b?: number; same: boolean };
  state: { a: string; b: string; same: boolean };
  method: { a: string; b: string; same: boolean };
  url: { a: string; b: string; same: boolean };
  duration: { a?: number; b?: number; deltaMs?: number };
  requestHeaders: HeaderDiff;
  responseHeaders: HeaderDiff;
  requestBody: BodyDiff;
  responseBody: BodyDiff;
}

export function compareEntries(
  a: NetworkEntry,
  aBodies: EntryBodies | undefined,
  b: NetworkEntry,
  bBodies: EntryBodies | undefined,
): EntryComparison {
  return {
    status: { a: a.status, b: b.status, same: a.status === b.status },
    state: { a: a.state, b: b.state, same: a.state === b.state },
    method: { a: a.method, b: b.method, same: a.method === b.method },
    url: { a: a.url, b: b.url, same: a.url === b.url },
    duration: {
      a: a.duration,
      b: b.duration,
      deltaMs: a.duration !== undefined && b.duration !== undefined ? b.duration - a.duration : undefined,
    },
    requestHeaders: diffHeaders(a.requestHeaders, b.requestHeaders),
    responseHeaders: diffHeaders(a.responseHeaders, b.responseHeaders),
    requestBody: diffBodies(aBodies?.request, bBodies?.request),
    responseBody: diffBodies(aBodies?.response, bBodies?.response),
  };
}
