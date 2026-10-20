import { describe, expect, it } from 'vitest';
import { detectIssues, extractErrorMessage } from '../../src/analysis/error-detector';
import { inferShape } from '../../src/analysis/contracts';
import type { EntryBodies } from '../../src/shared/types';
import { entry, jsonBodies, timelineEvent } from '../helpers/entries';

const base = { timeline: [], slowRequestMs: 2000 };

describe('Error Detective', () => {
  it('reports HTTP errors with server evidence, explanations, next steps and limitations', () => {
    const e = entry({
      id: 'o',
      method: 'POST',
      url: 'https://app.test/api/orders',
      status: 422,
      statusText: 'Unprocessable Entity',
    });
    const bodies = new Map([['o', jsonBodies('o', { message: 'Insufficient stock', code: 'OUT_OF_STOCK' })]]);
    const [f] = detectIssues({ ...base, entries: [e], bodies });
    expect(f).toMatchObject({ kind: 'http-error', severity: 'warning', confidence: 'high', entryIds: ['o'] });
    expect(f!.evidence[0]!.value).toContain('Insufficient stock');
    expect(f!.explanations.join(' ')).toMatch(/validation/);
    expect(f!.nextSteps.length).toBeGreaterThan(0);
    expect(f!.limitations.join(' ')).toMatch(/not necessarily indicate a frontend bug/);
  });

  it('reports network failures with CORS and mixed-content hypotheses', () => {
    const cors = entry({
      id: 'c',
      url: 'https://api.other.test/x',
      state: 'error',
      status: undefined,
      errorName: 'TypeError',
      errorMessage: 'Failed to fetch',
    });
    const mixed = entry({ id: 'm', url: 'http://app.test/insecure', state: 'error', status: undefined });
    const findings = detectIssues({ ...base, entries: [cors, mixed] });
    const byEntry = Object.fromEntries(findings.map((f) => [f.entryIds[0], f]));
    expect(byEntry.c!.explanations.join(' ')).toMatch(/CORS/);
    expect(byEntry.c!.confidence).toBe('medium');
    expect(byEntry.m!.explanations[0]).toMatch(/Mixed content/);
    expect(byEntry.m!.confidence).toBe('high');
  });

  it('reports slow requests with timing evidence', () => {
    const slow = entry({
      id: 's',
      duration: 4500,
      startedAt: 0,
      responseAt: 4000,
      endedAt: 4500,
      responseHeaders: [{ name: 'server-timing', value: 'db;dur=3800' }],
    });
    const [f] = detectIssues({ ...base, entries: [slow] });
    expect(f!.kind).toBe('slow');
    expect(f!.evidence.map((e) => e.value)).toContain('db;dur=3800');
    expect(f!.explanations[0]).toMatch(/waiting for the server/);
  });

  describe('repeated requests', () => {
    const body = (id: string): [string, EntryBodies] => [
      id,
      { id, request: { kind: 'json', text: '{"productId":"1"}' } },
    ];

    it('flags identical mutations close together as a possible double submit (medium confidence)', () => {
      const a = entry({
        id: 'a',
        method: 'POST',
        url: 'https://app.test/api/orders',
        startedAt: 1000,
        endedAt: 1300,
        status: 201,
      });
      const b = entry({
        id: 'b',
        method: 'POST',
        url: 'https://app.test/api/orders',
        startedAt: 1100,
        endedAt: 1400,
        status: 201,
      });
      const [f] = detectIssues({ ...base, entries: [a, b], bodies: new Map([body('a'), body('b')]) });
      expect(f).toMatchObject({ kind: 'repeated', severity: 'warning', confidence: 'medium' });
      expect(f!.explanations.join(' ')).toMatch(/double submit/);
      expect(f!.explanations.join(' ')).toMatch(/StrictMode/);
    });

    it('does not call different payloads duplicates', () => {
      const a = entry({ id: 'a', method: 'POST', url: 'https://app.test/api/orders', startedAt: 1000 });
      const b = entry({ id: 'b', method: 'POST', url: 'https://app.test/api/orders', startedAt: 1100 });
      const bodies = new Map([
        body('a'),
        ['b', { id: 'b', request: { kind: 'json' as const, text: '{"productId":"2"}' } }],
      ]);
      expect(detectIssues({ ...base, entries: [a, b], bodies })).toEqual([]);
    });

    it('recognizes polling and retries as likely intentional', () => {
      const polling = [0, 1000, 2000, 3000].map((t, i) =>
        entry({ id: `p${i}`, url: 'https://app.test/api/status', startedAt: t, endedAt: t + 50 }),
      );
      const [poll] = detectIssues({ ...base, entries: polling });
      expect(poll).toMatchObject({ severity: 'info', confidence: 'low' });
      expect(poll!.explanations.join(' ')).toMatch(/polling/);

      const retry = [
        entry({
          id: 'r1',
          method: 'POST',
          url: 'https://app.test/api/pay',
          startedAt: 0,
          endedAt: 100,
          status: 503,
        }),
        entry({
          id: 'r2',
          method: 'POST',
          url: 'https://app.test/api/pay',
          startedAt: 600,
          endedAt: 700,
          status: 200,
        }),
      ];
      const repeated = detectIssues({ ...base, entries: retry }).find((f) => f.kind === 'repeated');
      expect(repeated).toMatchObject({ severity: 'info', confidence: 'low' });
      expect(repeated!.explanations[0]).toMatch(/retries/);
    });

    it('ignores two identical GETs (common and usually harmless)', () => {
      const a = entry({ id: 'a', startedAt: 0 });
      const b = entry({ id: 'b', startedAt: 10 });
      expect(detectIssues({ ...base, entries: [a, b] })).toEqual([]);
    });
  });

  it('reports contract differences only with an explicit baseline', () => {
    const baseline = entry({ id: 'base', url: 'https://app.test/api/products/1' });
    const current = entry({ id: 'cur', url: 'https://app.test/api/products/2' });
    const bodies = new Map([
      ['base', jsonBodies('base', { id: 1, price: 10 })],
      ['cur', jsonBodies('cur', { id: 2, price: '10' })],
    ]);
    expect(detectIssues({ ...base, entries: [baseline, current], bodies })).toEqual([]);
    const contracts = [
      {
        endpointKey: 'GET app.test/api/products/:id',
        kind: 'inferred' as const,
        schema: inferShape({ id: 1, price: 10 }),
        sourceEntryId: 'base',
        createdAt: 0,
      },
    ];
    const [f] = detectIssues({ ...base, entries: [baseline, current], bodies, contracts });
    expect(f).toMatchObject({ kind: 'contract', confidence: 'medium', entryIds: ['cur'] });
    expect(f!.limitations[0]).toMatch(/not a contract/);
  });

  it('reports console errors near failed requests with low confidence', () => {
    const failed = entry({ id: 'f', status: 500, startedAt: 1000, endedAt: 1100 });
    const err = timelineEvent({
      id: 'e',
      kind: 'console-error',
      timestamp: 1200,
      message: "Cannot read properties of undefined (reading 'items')",
    });
    const finding = detectIssues({ ...base, entries: [failed], timeline: [err] }).find(
      (f) => f.kind === 'console-near-failure',
    );
    expect(finding).toMatchObject({ confidence: 'low', entryIds: ['f'] });
  });

  it('compares the latest request per endpoint with the previous session', () => {
    const prev = entry({ id: 'p', sessionId: 'old', status: 200 });
    const cur = entry({ id: 'c', sessionId: 'new', status: 200 });
    const findings = detectIssues({
      ...base,
      entries: [cur],
      bodies: new Map([['c', jsonBodies('c', { price: '9.99' })]]),
      baselineEntries: [prev],
      baselineBodies: new Map([['p', jsonBodies('p', { price: 9.99 })]]),
    });
    expect(findings[0]).toMatchObject({ kind: 'session-diff', confidence: 'low', entryIds: ['p', 'c'] });
  });

  it('extracts server error messages', () => {
    expect(extractErrorMessage(jsonBodies('x', { error: 'bad', detail: { field: 'qty' } }))).toBe(
      'error: bad; detail: {"field":"qty"}',
    );
    expect(extractErrorMessage({ id: 'x', response: { kind: 'text', text: '  Internal error  ' } })).toBe(
      'Internal error',
    );
  });
});
