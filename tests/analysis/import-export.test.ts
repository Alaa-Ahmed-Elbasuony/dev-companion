import { describe, expect, it } from 'vitest';
import { buildHar, buildJsonExport } from '../../src/io/export';
import { ImportError, parseImport } from '../../src/io/import';
import { DEFAULT_REDACTION, DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { EntryBodies, Session } from '../../src/shared/types';
import { entry, timelineEvent } from '../helpers/entries';

const session: Session = { id: 's-1', tabId: 1, origin: 'https://app.test', startedAt: 0, label: 'test' };

// Simulates a value stored before a redaction rule existed.
const leaky = entry({
  id: 'x',
  method: 'POST',
  url: 'https://app.test/api/login?session_id=abc',
  requestHeaders: [{ name: 'Authorization', value: 'Bearer abcdefghijkl' }],
  status: 200,
});
const leakyBodies: EntryBodies = {
  id: 'x',
  request: { kind: 'json', text: '{"user":"ada","password":"hunter2"}' },
  response: { kind: 'json', text: '{"ok":true}' },
};

describe('export', () => {
  it('applies redaction to JSON exports, including timeline text', () => {
    const bundle = buildJsonExport(
      [session],
      [leaky],
      new Map([['x', leakyBodies]]),
      [timelineEvent({ message: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' })],
      DEFAULT_REDACTION,
    );
    const text = JSON.stringify(bundle);
    for (const secret of ['hunter2', 'abcdefghijkl', 'session_id=abc', 'eyJhbGciOiJIUzI1NiJ9'])
      expect(text).not.toContain(secret);
    expect(bundle).toMatchObject({ format: 'dev-companion-session', version: 2 });
    expect(bundle.entries[0]!.bodies?.request?.text).toContain('ada');
  });

  it('removes URL query secrets from stacks, error messages and timeline URLs in exports', () => {
    const secret = 'synthetic-oauth-code-77';
    const e = entry({
      id: 'y',
      initiatorStack: `    at https://app.test/cb?access_token=${secret}:12:5`,
      errorMessage: `Failed https://app.test/x?token=${secret}`,
    });
    const tl = timelineEvent({
      kind: 'route-change',
      message: 'Route changed via history.pushState',
      detail: `https://app.test/cb?access_token=${secret} → https://app.test/home`,
      pageUrl: `https://app.test/cb?access_token=${secret}`,
    });
    const json = JSON.stringify(buildJsonExport([session], [e], new Map(), [tl], DEFAULT_REDACTION));
    const har = JSON.stringify(buildHar([e], new Map(), DEFAULT_REDACTION, '0.1.0'));
    expect(json).not.toContain(secret);
    expect(har).not.toContain(secret);
  });

  it('produces redacted HAR 1.2', () => {
    const har = buildHar([leaky], new Map([['x', leakyBodies]]), DEFAULT_REDACTION, '0.1.0');
    expect(har.log.version).toBe('1.2');
    const e = har.log.entries[0]!;
    expect(e.request.method).toBe('POST');
    expect(e.request.queryString).toEqual([{ name: 'session_id', value: '[REDACTED]' }]);
    expect(e.request.headers).toEqual([{ name: 'Authorization', value: '[REDACTED]' }]);
    expect(e.response.status).toBe(200);
    expect(JSON.stringify(har)).not.toContain('hunter2');
  });
});

describe('import (untrusted)', () => {
  it('round-trips a Dev Companion export into a new imported session with new ids', () => {
    const bundle = buildJsonExport(
      [session],
      [leaky],
      new Map([['x', leakyBodies]]),
      [timelineEvent()],
      DEFAULT_REDACTION,
    );
    const result = parseImport(JSON.stringify(bundle), 'bug-123.json', DEFAULT_SETTINGS);
    expect(result.session).toMatchObject({ imported: true, tabId: -1, label: 'Imported: bug-123.json' });
    expect(result.entries).toHaveLength(1);
    const imported = result.entries[0]!;
    expect(imported.entry.id).not.toBe('x');
    expect(imported.entry.sessionId).toBe(result.session.id);
    expect(imported.entry.method).toBe('POST');
    expect(imported.bodies?.request?.text).toContain('ada');
    expect(imported.entry.warnings).toContain('Imported data (untrusted)');
    expect(result.timeline).toHaveLength(1);
  });

  it('validates records, re-applies redaction and neutralizes pending state', () => {
    const malicious = {
      format: 'dev-companion-session',
      version: 1,
      entries: [
        {
          id: 'a',
          method: 'GET',
          url: 'https://ok.test/',
          state: 'pending',
          startedAt: 1,
          requestHeaders: [{ name: 'cookie', value: 'sid=1' }],
        },
        { id: 'b', method: '<script>', url: 'https://ok.test/', state: 'complete', startedAt: 1 },
        { id: 'c', method: 'GET', url: 'javascript:alert(1)', state: 'complete', startedAt: 1 },
        { id: 'd', method: 'GET', url: 'https://ok.test/', state: 'complete', startedAt: 'yesterday' },
        'garbage',
      ],
    };
    const result = parseImport(JSON.stringify(malicious), 'x.json', DEFAULT_SETTINGS);
    expect(result.entries).toHaveLength(2);
    expect(result.skipped).toBe(3);
    const first = result.entries[0]!.entry;
    expect(first.state).toBe('incomplete');
    expect(first.requestHeaders).toEqual([{ name: 'cookie', value: '[REDACTED]' }]);
  });

  it('imports HAR files', () => {
    const har = {
      log: {
        entries: [
          {
            startedDateTime: '2026-10-19T10:00:00.000Z',
            time: 120,
            request: {
              method: 'POST',
              url: 'https://api.test/orders',
              headers: [],
              postData: { mimeType: 'application/json', text: '{"qty":2}' },
            },
            response: {
              status: 422,
              statusText: 'Unprocessable Entity',
              headers: [],
              content: { mimeType: 'application/json', text: '{"code":"OUT_OF_STOCK"}' },
            },
          },
          { request: {}, response: {} },
        ],
      },
    };
    const result = parseImport(JSON.stringify(har), 'trace.har', DEFAULT_SETTINGS);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.entry).toMatchObject({
      method: 'POST',
      status: 422,
      duration: 120,
      source: 'import',
    });
    expect(result.entries[0]!.bodies?.response?.kind).toBe('json');
  });

  it('truncates oversized imported bodies', () => {
    const big = {
      format: 'dev-companion-session',
      version: 1,
      entries: [
        {
          id: 'a',
          method: 'GET',
          url: 'https://ok.test/',
          state: 'complete',
          startedAt: 1,
          bodies: { response: { kind: 'text', text: 'x'.repeat(5000) } },
        },
      ],
    };
    const result = parseImport(JSON.stringify(big), 'x.json', { ...DEFAULT_SETTINGS, maxBodyKB: 1 });
    expect(result.entries[0]!.bodies?.response).toMatchObject({ truncated: true });
    expect(result.entries[0]!.bodies!.response!.text!.length).toBe(1024);
  });

  it('rejects unknown formats', () => {
    expect(() => parseImport('not json', 'a', DEFAULT_SETTINGS)).toThrow(ImportError);
    expect(() => parseImport('{"hello":1}', 'a', DEFAULT_SETTINGS)).toThrow(/Unrecognized/);
    expect(() =>
      parseImport('{"format":"dev-companion-session","version":9}', 'a', DEFAULT_SETTINGS),
    ).toThrow(/version/);
  });
});

describe('export/import v2: realtime and server spans', () => {
  const conn = {
    id: 'c-old',
    pageId: 'p',
    pageUrl: 'https://app.test/',
    transport: 'websocket' as const,
    url: 'wss://app.test/socket.io/?EIO=4&transport=websocket&token=ws-secret',
    state: 'open' as const,
    createdAt: 10,
    warnings: [],
    source: 'main-world' as const,
    sessionId: 's-1',
    tabId: 1,
    origin: 'https://app.test',
    protocol: 'socket.io' as const,
    sources: ['main-world' as const],
    attempt: 0,
    inCount: 1,
    outCount: 0,
    bytesIn: 40,
    bytesOut: 0,
    redactions: 0,
  };
  const message = {
    id: 'm-old',
    connectionId: 'c-old',
    direction: 'in' as const,
    timestamp: 20,
    opcode: 'text' as const,
    text: '42["login",{"password":"rt-hunter2"}]',
    size: 40,
    source: 'main-world' as const,
    sessionId: 's-1',
    tabId: 1,
    sources: ['main-world' as const],
    dedupKey: 'k',
    redactions: 0,
  };
  const span = {
    id: `${'a'.repeat(32)}:${'b'.repeat(16)}`,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'fetch GET http://up/x?api_key=span-secret',
    kind: 'client' as const,
    startTime: 15,
    status: 'unset' as const,
    outbound: true,
    attributes: {},
    events: [],
    source: 'next-adapter',
    sessionId: 's-1',
    origin: 'https://app.test',
    redactions: 0,
  };

  it('exports redacted realtime records and spans, and re-imports them under new ids', () => {
    const bundle = buildJsonExport([session], [entry({ id: 'e' })], new Map(), [], DEFAULT_REDACTION, {
      connections: [conn],
      messages: [message],
      spans: [span],
    });
    const text = JSON.stringify(bundle);
    for (const secret of ['ws-secret', 'rt-hunter2', 'span-secret']) expect(text).not.toContain(secret);

    const result = parseImport(text, 'rt.json', DEFAULT_SETTINGS);
    expect(result.connections).toHaveLength(1);
    const [c] = result.connections;
    expect(c).toMatchObject({
      protocol: 'socket.io',
      state: 'closed',
      sessionId: result.session.id,
      inCount: 1,
    });
    expect(c!.id).not.toBe('c-old');
    expect(result.messages[0]).toMatchObject({ connectionId: c!.id, sources: ['import'] });
    expect(result.messages[0]!.decoded?.[0]).toMatchObject({
      name: 'login',
      args: [{ password: '[REDACTED]' }],
    });
    expect(result.spans[0]).toMatchObject({ sessionId: result.session.id, outbound: true });
  });

  it('still imports version 1 exports (no realtime data)', () => {
    const v1 = JSON.stringify({
      format: 'dev-companion-session',
      version: 1,
      sessions: [session],
      entries: [{ ...entry({ id: 'v1' }) }],
      timeline: [],
    });
    const result = parseImport(v1, 'old.json', DEFAULT_SETTINGS);
    expect(result.entries).toHaveLength(1);
    expect(result.connections).toEqual([]);
  });

  it('drops messages whose connection is missing or forged', () => {
    const bad = JSON.stringify({
      format: 'dev-companion-session',
      version: 2,
      entries: [],
      timeline: [],
      connections: [{ ...conn, url: 'javascript:alert(1)' }],
      messages: [message],
    });
    const result = parseImport(bad, 'bad.json', DEFAULT_SETTINGS);
    expect(result.connections).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.skipped).toBe(2);
  });
});
