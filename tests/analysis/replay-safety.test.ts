import { describe, expect, it } from 'vitest';
import { assessReplay, parseHeaderLines } from '../../src/analysis/replay-safety';
import type { ReplayDraft } from '../../src/analysis/replay-safety';
import { DEFAULT_REDACTION } from '../../src/shared/settings';

const original = 'https://shop.test/api/orders';
const draft = (d: Partial<ReplayDraft> = {}): ReplayDraft => ({
  method: 'GET',
  url: 'https://shop.test/api/products',
  headers: [],
  includeCredentials: false,
  ...d,
});

describe('replay safeguards', () => {
  it('flags state-changing requests and requires acknowledgement', () => {
    const a = assessReplay(draft({ method: 'POST', url: original, body: '{}' }), original, DEFAULT_REDACTION);
    expect(a.isMutation).toBe(true);
    expect(a.mutationReasons.join(' ')).toMatch(/POST/);
    expect(a.mutationReasons.join(' ')).toMatch(/order, payment, deletion/);
    expect(a.requiresAcknowledgement).toBe(true);
  });

  it('flags risky paths even for GET (e.g. /delete links)', () => {
    const a = assessReplay(
      draft({ url: 'https://shop.test/account/delete?id=1' }),
      original,
      DEFAULT_REDACTION,
    );
    expect(a.isMutation).toBe(true);
  });

  it('does not require acknowledgement for a plain same-origin GET', () => {
    const a = assessReplay(draft(), original, DEFAULT_REDACTION);
    expect(a).toMatchObject({
      valid: true,
      isMutation: false,
      requiresAcknowledgement: false,
      targetOrigin: 'https://shop.test',
    });
    expect(a.warnings.join(' ')).toMatch(/sent from the extension/);
  });

  it('never sends redacted placeholders or browser-controlled headers', () => {
    const a = assessReplay(
      draft({
        headers: [
          { name: 'authorization', value: '[REDACTED]' },
          { name: 'cookie', value: 'sid=1' },
          { name: 'sec-fetch-mode', value: 'cors' },
          { name: 'accept', value: 'application/json' },
        ],
      }),
      original,
      DEFAULT_REDACTION,
    );
    expect(a.headersToSend).toEqual([{ name: 'accept', value: 'application/json' }]);
    expect(a.dropped.map((d) => d.name)).toEqual(['authorization', 'cookie', 'sec-fetch-mode']);
  });

  it('drops credential headers when the target origin differs from the original request', () => {
    const a = assessReplay(
      draft({
        url: 'https://evil.test/collect',
        headers: [{ name: 'Authorization', value: 'Bearer typed-by-user' }],
      }),
      original,
      DEFAULT_REDACTION,
    );
    expect(a.originChanged).toBe(true);
    expect(a.headersToSend).toEqual([]);
    expect(a.dropped[0]!.reason).toMatch(/different from the original/);
    expect(a.requiresAcknowledgement).toBe(true);
  });

  it('warns when the user explicitly types a credential for the same origin, and when cookies are included', () => {
    const a = assessReplay(
      draft({ headers: [{ name: 'Authorization', value: 'Bearer new' }], includeCredentials: true }),
      original,
      DEFAULT_REDACTION,
    );
    expect(a.headersToSend).toHaveLength(1);
    expect(a.warnings.join(' ')).toMatch(/credential header/);
    expect(a.warnings.join(' ')).toMatch(/cookies/);
    expect(a.requiresAcknowledgement).toBe(true);
  });

  it('warns when the URL or body still contains redaction placeholders', () => {
    const a = assessReplay(
      draft({
        method: 'POST',
        url: 'https://shop.test/api/login?api_key=%5BREDACTED%5D',
        body: '{"email":"ada@example.com","password":"[REDACTED]"}',
      }),
      original,
      DEFAULT_REDACTION,
    );
    expect(a.warnings.join(' ')).toMatch(/URL and body still contain \[REDACTED\] placeholders/);
    const clean = assessReplay(draft({ method: 'POST', body: '{"a":1}' }), original, DEFAULT_REDACTION);
    expect(clean.warnings.join(' ')).not.toMatch(/placeholders/);
  });

  it('rejects invalid requests', () => {
    expect(assessReplay(draft({ url: 'javascript:alert(1)' }), original, DEFAULT_REDACTION).errors).toContain(
      'Only http and https URLs can be replayed.',
    );
    expect(assessReplay(draft({ body: 'x' }), original, DEFAULT_REDACTION).errors).toContain(
      'GET requests cannot have a body.',
    );
    expect(assessReplay(draft({ method: 'TRACE' }), original, DEFAULT_REDACTION).valid).toBe(false);
    expect(assessReplay(draft({ url: 'not a url' }), original, DEFAULT_REDACTION).valid).toBe(false);
  });

  it('parses header lines and reports malformed ones', () => {
    expect(parseHeaderLines('Accept: a\n\nbad line\nX-Y:  z ')).toEqual({
      headers: [
        { name: 'Accept', value: 'a' },
        { name: 'X-Y', value: 'z' },
      ],
      errors: ['Line 3: expected "Name: value"'],
    });
  });
});
