import { describe, expect, it } from 'vitest';
import { compareToShape, inferShape, validateJsonSchema } from '../../src/analysis/contracts';
import { correlate } from '../../src/analysis/correlate';
import { buildCurl, curlForEntry, shellQuote } from '../../src/analysis/curl';
import { EMPTY_FILTER, filterEntries, statusClass } from '../../src/analysis/filter';
import { compareEntries, diffHeaders, diffJson } from '../../src/analysis/request-diff';
import { endpointKey } from '../../src/shared/util';
import { entry, jsonBodies, timelineEvent } from '../helpers/entries';

describe('request filtering', () => {
  const list = [
    entry({ id: 'a', method: 'POST', url: 'https://app.test/api/orders', status: 422, duration: 120 }),
    entry({
      id: 'b',
      method: 'GET',
      url: 'https://app.test/api/products?page=2',
      status: 200,
      duration: 3000,
    }),
    entry({
      id: 'c',
      method: 'GET',
      url: 'https://cdn.test/a.js',
      state: 'error',
      status: undefined,
      source: 'xhr',
    }),
    entry({ id: 'd', method: 'DELETE', url: 'https://app.test/api/orders/1', status: 500 }),
  ];
  const ids = (f: Partial<typeof EMPTY_FILTER>, bodyMatches?: Set<string>) =>
    filterEntries(list, { ...EMPTY_FILTER, ...f }, bodyMatches).map((e) => e.id);

  it('searches endpoint, method and status tokens', () => {
    expect(ids({ text: '/api/orders' })).toEqual(['a', 'd']);
    expect(ids({ text: 'POST /api/orders' })).toEqual(['a']);
    expect(ids({ text: '422' })).toEqual(['a']);
  });
  it('matches captured body text through body search results', () => {
    expect(ids({ text: 'OUT_OF_STOCK' }, new Set(['a']))).toEqual(['a']);
  });
  it('filters by method, status class, type and duration', () => {
    expect(ids({ methods: ['GET'] })).toEqual(['b', 'c']);
    expect(ids({ status: 'client-error' })).toEqual(['a']);
    expect(ids({ status: 'server-error' })).toEqual(['d']);
    expect(ids({ status: 'failed' })).toEqual(['c']);
    expect(ids({ sources: ['xhr'] })).toEqual(['c']);
    expect(ids({ minDurationMs: 1000 })).toEqual(['b']);
  });
  it('classifies statuses', () => {
    expect(statusClass(entry({ state: 'pending' }))).toBe('pending');
    expect(statusClass(entry({ status: 302 }))).toBe('redirect');
    expect(statusClass(entry({ state: 'aborted' }))).toBe('failed');
  });
});

describe('request comparison', () => {
  it('reports added, removed, type-changed and nested differences', () => {
    const changes = diffJson(
      { id: 1, price: 10, tags: ['a'], meta: { x: 1, y: 2 } },
      { id: 1, price: '10', tags: ['a', 'b'], meta: { x: 1 }, extra: true },
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '$.price',
          kind: 'type-changed',
          beforeType: 'number',
          afterType: 'string',
        }),
        expect.objectContaining({ path: '$.tags[1]', kind: 'added' }),
        expect.objectContaining({ path: '$.meta.y', kind: 'removed' }),
        expect.objectContaining({ path: '$.extra', kind: 'added' }),
      ]),
    );
    expect(changes).toHaveLength(4);
  });

  it('treats keys named like Object.prototype members as ordinary fields', () => {
    expect(diffJson({ toString: 'a', constructor: 1, keep: 1 }, { keep: 1 })).toEqual([
      { path: '$.toString', kind: 'removed', before: 'a', beforeType: 'string' },
      { path: '$.constructor', kind: 'removed', before: 1, beforeType: 'number' },
    ]);
    expect(diffJson({ keep: 1 }, { valueOf: 'x', keep: 1 })).toEqual([
      { path: '$.valueOf', kind: 'added', after: 'x', afterType: 'string' },
    ]);
  });

  it('diffs headers case-insensitively', () => {
    const d = diffHeaders(
      [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'x-a', value: '1' },
      ],
      [
        { name: 'content-type', value: 'text/html' },
        { name: 'x-b', value: '2' },
      ],
    );
    expect(d.changed).toEqual([{ name: 'content-type', before: 'application/json', after: 'text/html' }]);
    expect(d.removed).toEqual([{ name: 'x-a', value: '1' }]);
    expect(d.added).toEqual([{ name: 'x-b', value: '2' }]);
  });

  it('compares status, timing and bodies of two entries and refuses truncated bodies', () => {
    const a = entry({ id: 'a', status: 200, duration: 100 });
    const b = entry({ id: 'b', status: 500, duration: 350 });
    const c = compareEntries(a, jsonBodies('a', { ok: true }), b, jsonBodies('b', { ok: false }));
    expect(c.status).toEqual({ a: 200, b: 500, same: false });
    expect(c.duration.deltaMs).toBe(250);
    expect(c.responseBody).toEqual({
      mode: 'json',
      changes: [expect.objectContaining({ path: '$.ok', kind: 'value-changed' })],
    });
    const truncated = compareEntries(
      a,
      { id: 'a', response: { kind: 'json', text: '{"a":', truncated: true } },
      b,
      jsonBodies('b', {}),
    );
    expect(truncated.responseBody.mode).toBe('unavailable');
  });
});

describe('contracts', () => {
  it('compares a response with an inferred baseline shape', () => {
    const shape = inferShape({ id: 'o1', price: 10, items: [{ sku: 'a', qty: 1 }] });
    expect(compareToShape({ id: 'o2', price: 12, items: [{ sku: 'b', qty: 3 }] }, shape)).toEqual([]);
    const issues = compareToShape({ id: 'o3', price: '12', items: [{ sku: 'c' }], coupon: null }, shape);
    expect(issues.map((i) => `${i.kind} ${i.path}`)).toEqual([
      'type-mismatch $.price',
      'missing $.items[0].qty',
      'unexpected $.coupon',
    ]);
  });

  it('validates the supported JSON Schema subset', () => {
    const schema = {
      type: 'object',
      required: ['id', 'price'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^o' },
        price: { type: 'number', minimum: 0 },
        status: { enum: ['new', 'paid'] },
        items: { type: 'array', items: { type: 'object', required: ['sku'] } },
      },
    };
    expect(validateJsonSchema({ id: 'o1', price: 3, status: 'new', items: [{ sku: 'a' }] }, schema)).toEqual(
      [],
    );
    const issues = validateJsonSchema({ id: 'x1', price: -1, status: 'lost', items: [{}], extra: 1 }, schema);
    expect(issues.map((i) => i.path)).toEqual(['$.id', '$.price', '$.status', '$.items[0].sku', '$.extra']);
  });

  it('does not mistake Object.prototype members for baseline or response fields', () => {
    expect(compareToShape({ id: 1 }, inferShape({ id: 1, constructor: 'x' })).map((i) => i.kind)).toEqual([
      'missing',
    ]);
    expect(
      validateJsonSchema({}, { type: 'object', required: ['toString'] }).map((i) => `${i.kind} ${i.path}`),
    ).toEqual(['missing $.toString']);
    expect(
      validateJsonSchema(
        { constructor: 'x' },
        { type: 'object', properties: {}, additionalProperties: false },
      ).map((i) => i.kind),
    ).toEqual(['unexpected']);
  });

  it('builds endpoint keys that group ids', () => {
    expect(endpointKey('get', 'https://api.test/orders/123/items/9f86d081884c7d659a2feaa0c55ad015?x=1')).toBe(
      'GET api.test/orders/:id/items/:id',
    );
  });
});

describe('correlation', () => {
  it('links console errors to failed requests shortly before them, and clicks to requests after them', () => {
    const failed = entry({ id: 'f', status: 500, startedAt: 1000, endedAt: 1200 });
    const ok = entry({ id: 'ok', status: 200, startedAt: 1000, endedAt: 1100 });
    const err = timelineEvent({ id: 'err', kind: 'console-error', timestamp: 1500 });
    const late = timelineEvent({ id: 'late', kind: 'console-error', timestamp: 60_000 });
    const click = timelineEvent({ id: 'click', kind: 'click', timestamp: 900 });
    const map = correlate([failed, ok], [err, late, click]);
    expect(map.get('err')).toEqual(['f']);
    expect(map.has('late')).toBe(false);
    expect(map.get('click')).toEqual(['f', 'ok']);
  });
});

describe('cURL', () => {
  it('quotes safely for POSIX shells and omits redacted headers', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const { command, omittedHeaders } = buildCurl({
      method: 'POST',
      url: 'https://api.test/orders',
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'authorization', value: '[REDACTED]' },
      ],
      body: `{"note":"it's"}`,
    });
    expect(command).toBe(
      `curl -X POST 'https://api.test/orders' -H 'content-type: application/json' --data-raw '{"note":"it'\\''s"}'`,
    );
    expect(omittedHeaders).toEqual(['authorization']);
  });

  it('refuses to build cURL when the body was truncated or not captured', () => {
    const e = entry({ method: 'POST' });
    expect(curlForEntry(e, { id: e.id, request: { kind: 'json', text: '{', truncated: true } }).ok).toBe(
      false,
    );
    expect(curlForEntry(e, { id: e.id, request: { kind: 'binary', size: 10 } }).ok).toBe(false);
    expect(curlForEntry(entry(), undefined)).toMatchObject({
      ok: true,
      command: "curl 'https://app.test/api/items'",
    });
  });
});
