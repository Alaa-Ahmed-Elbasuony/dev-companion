import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  luhnValid,
  redactBodyText,
  redactEntry,
  redactFreeText,
  redactHeaders,
  redactUrl,
} from '../../src/analysis/redaction';
import { DEFAULT_REDACTION, REDACTED } from '../../src/shared/settings';
import { entry } from '../helpers/entries';

const r = createRedactor(DEFAULT_REDACTION);

describe('redaction', () => {
  it('redacts sensitive headers case-insensitively', () => {
    const { headers, count } = redactHeaders(
      [
        { name: 'Authorization', value: 'Bearer abc.def.ghi' },
        { name: 'Cookie', value: 'sid=1' },
        { name: 'X-Goog-Api-Key', value: 'k' },
        { name: 'Accept', value: 'application/json' },
      ],
      r,
    );
    expect(headers.map((h) => h.value)).toEqual([REDACTED, REDACTED, REDACTED, 'application/json']);
    expect(count).toBe(3);
  });

  it('redacts query parameters, URL credentials and token fragments', () => {
    const res = redactUrl(
      'https://user:pw@api.test/x?token=abc&page=2&client_secret=s#access_token=zzz&state=1',
      r,
    );
    const u = new URL(res.url);
    expect(u.username).toBe('');
    expect(u.searchParams.get('token')).toBe(REDACTED);
    expect(u.searchParams.get('client_secret')).toBe(REDACTED);
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.hash).toContain('access_token=%5BREDACTED%5D');
    expect(u.hash).toContain('state=1');
  });

  it('redacts nested JSON keys and keeps the rest', () => {
    const text = JSON.stringify({
      user: { name: 'Ada', password: 'p', profile: { apiKey: 'k', author: 'Bo' } },
      items: [{ refresh_token: 't' }],
      className: 'x',
    });
    const res = redactBodyText(text, 'json', r);
    const parsed = JSON.parse(res.text);
    expect(parsed.user.password).toBe(REDACTED);
    expect(parsed.user.profile.apiKey).toBe(REDACTED);
    expect(parsed.items[0].refresh_token).toBe(REDACTED);
    expect(parsed.user.name).toBe('Ada');
    expect(parsed.user.profile.author).toBe('Bo');
    expect(parsed.className).toBe('x');
    expect(res.count).toBe(3);
  });

  it('redacts form bodies and falls back to patterns for truncated JSON', () => {
    expect(redactBodyText('user=ada&password=hunter2', 'form', r).text).toBe(
      'user=ada&password=%5BREDACTED%5D',
    );
    const truncated = '{"user":"ada","password":"hunter2","items":[{"id":1,';
    const res = redactBodyText(truncated, 'json', r);
    expect(res.text).not.toContain('hunter2');
    expect(res.text).toContain('"user":"ada"');
  });

  it('redacts JWTs, bearer tokens and Luhn-valid card numbers in free text', () => {
    const text =
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefSIG card 4111 1111 1111 1111 auth Bearer abcdefghijkl';
    const res = r.redactString(text);
    expect(res.value).toBe(`jwt ${REDACTED} card ${REDACTED} auth Bearer ${REDACTED}`);
  });

  it('does not redact non-card numbers such as timestamps and ids', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(r.redactString('ts 1729350000000 id 4111111111111112 order 123456789012345678').count).toBe(0);
  });

  it('honors exact-match rules', () => {
    const custom = createRedactor({ ...DEFAULT_REDACTION, keyRules: ['=pin'] });
    expect(custom.isSensitiveKey('pin')).toBe(true);
    expect(custom.isSensitiveKey('shipping')).toBe(false);
  });

  it('redacts URLs embedded in free text (page URLs, route changes, stack frames)', () => {
    const secret = 'synthetic-oauth-code-77';
    expect(redactFreeText(`https://app.test/cb?access_token=${secret}&x=1`, DEFAULT_REDACTION)).toBe(
      'https://app.test/cb?access_token=%5BREDACTED%5D&x=1',
    );
    const route = redactFreeText(
      `https://app.test/ → https://app.test/cb?api_key=${secret}#token=${secret}`,
      DEFAULT_REDACTION,
    );
    expect(route).not.toContain(secret);
    expect(route.startsWith('https://app.test/ → https://app.test/cb?api_key=')).toBe(true);
    // Stack-frame locations stay readable; URLs without parameters are left alone.
    const stack = redactFreeText(
      `    at load (https://app.test/cb?code=1&token=${secret}:12:5)\n    at https://app.test/main.js:3:9`,
      DEFAULT_REDACTION,
    );
    expect(stack).toBe(
      '    at load (https://app.test/cb?code=1&token=%5BREDACTED%5D:12:5)\n    at https://app.test/main.js:3:9',
    );
  });

  it('redactEntry removes secrets from the initiator stack and error message', () => {
    const secret = 'synthetic-oauth-code-77';
    const e = entry({
      initiatorStack: `    at https://app.test/cb?access_token=${secret}:12:5`,
      errorMessage: `Failed to fetch https://app.test/x?token=${secret}`,
    });
    const res = redactEntry(e, undefined, DEFAULT_REDACTION);
    expect(JSON.stringify(res.entry)).not.toContain(secret);
    expect(res.entry.initiatorStack).toContain(':12:5');
    expect(res.count).toBe(2);
  });

  it('redactEntry counts removals and is idempotent', () => {
    const e = entry({
      requestHeaders: [{ name: 'authorization', value: 'x' }],
      url: 'https://a.test/?password=1',
    });
    const once = redactEntry(
      e,
      { id: e.id, request: { kind: 'json', text: '{"token":"t"}' } },
      DEFAULT_REDACTION,
    );
    expect(once.count).toBe(3);
    const twice = redactEntry(once.entry, once.bodies, DEFAULT_REDACTION);
    expect(twice.count).toBe(0);
  });
});
