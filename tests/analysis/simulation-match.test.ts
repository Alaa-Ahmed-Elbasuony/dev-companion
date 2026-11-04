import { describe, expect, it } from 'vitest';
import { compileRules, matchRule, sensitiveCategory } from '../../src/analysis/simulation-match';
import { normalizeSimulationRules } from '../../src/shared/simulation';

let n = 0;
function rule(urlPattern: string, extra: Record<string, unknown> = {}, match: Record<string, unknown> = {}) {
  return {
    id: `r${++n}`,
    enabled: true,
    match: { methods: [], urlPattern, query: 'ignore', ...match },
    action: { kind: 'fail', mode: 'network-error' },
    ...extra,
  };
}

function matcher(...raw: Record<string, unknown>[]) {
  const compiled = compileRules(normalizeSimulationRules(raw));
  return (url: string, method = 'GET') => matchRule(compiled, method, url)?.id;
}

describe('simulation rule matching: URLs', () => {
  it('matches host + path, ignoring a trailing slash and host case', () => {
    const m = matcher(rule('localhost:3000/api/orders', { id: 'a' }));
    expect(m('http://localhost:3000/api/orders')).toBe('a');
    expect(m('http://localhost:3000/api/orders/')).toBe('a');
    expect(m('http://LOCALHOST:3000/api/orders')).toBe('a');
    expect(m('http://localhost:3000/api/orders/1')).toBeUndefined();
    expect(m('http://localhost:3000/api/order')).toBeUndefined();
  });

  it('treats the port as part of the host', () => {
    const m = matcher(rule('localhost:3000/api/*', { id: 'a' }));
    expect(m('http://localhost:4000/api/orders')).toBeUndefined();
    expect(m('http://localhost/api/orders')).toBeUndefined();
  });

  it('matches one path segment with :param', () => {
    const m = matcher(rule('localhost:3000/api/orders/:id', { id: 'a' }));
    expect(m('http://localhost:3000/api/orders/42')).toBe('a');
    expect(m('http://localhost:3000/api/orders/9b1c-uuid')).toBe('a');
    expect(m('http://localhost:3000/api/orders/42/items')).toBeUndefined();
    expect(m('http://localhost:3000/api/orders')).toBeUndefined();
  });

  it('matches any characters, across segments, with *', () => {
    const m = matcher(rule('localhost:3000/api/*/items', { id: 'a' }));
    expect(m('http://localhost:3000/api/orders/42/items')).toBe('a');
    expect(m('http://localhost:3000/api/carts/items')).toBe('a');
    expect(m('http://localhost:3000/api/items')).toBeUndefined();
  });

  it('escapes regex characters in patterns', () => {
    const m = matcher(rule('localhost:3000/api/v1.0/(x)', { id: 'a' }));
    expect(m('http://localhost:3000/api/v1.0/(x)')).toBe('a');
    expect(m('http://localhost:3000/api/v1x0/(x)')).toBeUndefined();
  });

  it('restricts the scheme only when the pattern has one', () => {
    const scheme = matcher(rule('https://api.local/api/*', { id: 'a' }));
    expect(scheme('https://api.local/api/x')).toBe('a');
    expect(scheme('http://api.local/api/x')).toBeUndefined();
    const any = matcher(rule('api.local/api/*', { id: 'b' }));
    expect(any('http://api.local/api/x')).toBe('b');
    expect(any('https://api.local/api/x')).toBe('b');
  });

  it('matches path-only patterns on any host', () => {
    const m = matcher(rule('/api/orders', { id: 'a' }));
    expect(m('http://localhost:3000/api/orders')).toBe('a');
    expect(m('https://api.local/api/orders')).toBe('a');
  });

  it('never matches non-http(s) or invalid URLs', () => {
    const m = matcher(rule('*', { id: 'a' }));
    expect(m('http://localhost:3000/anything')).toBe('a');
    expect(m('data:application/json,{}')).toBeUndefined();
    expect(m('blob:http://localhost:3000/abc')).toBeUndefined();
    expect(m('not a url')).toBeUndefined();
  });
});

describe('simulation rule matching: methods and query', () => {
  it('matches any method when none is listed, otherwise only the listed ones', () => {
    const any = matcher(rule('/api/x', { id: 'a' }));
    expect(any('http://h/api/x', 'DELETE')).toBe('a');
    const post = matcher(rule('/api/x', { id: 'b' }, { methods: ['post', 'PUT'] }));
    expect(post('http://h/api/x', 'post')).toBe('b');
    expect(post('http://h/api/x', 'PUT')).toBe('b');
    expect(post('http://h/api/x', 'GET')).toBeUndefined();
  });

  it('ignores the request query by default but requires parameters the pattern names', () => {
    const plain = matcher(rule('/api/items', { id: 'a' }));
    expect(plain('http://h/api/items?page=2&sort=asc')).toBe('a');

    const named = matcher(rule('/api/items?status=open&page=*', { id: 'b' }));
    expect(named('http://h/api/items?page=2&status=open&sort=asc')).toBe('b');
    expect(named('http://h/api/items?status=closed&page=2')).toBeUndefined();
    expect(named('http://h/api/items?status=open')).toBeUndefined();
  });

  it('requires exactly the named parameters in exact mode, in any order', () => {
    const m = matcher(rule('/api/items?status=open&page=1', { id: 'a' }, { query: 'exact' }));
    expect(m('http://h/api/items?page=1&status=open')).toBe('a');
    expect(m('http://h/api/items?page=1&status=open&sort=asc')).toBeUndefined();
    expect(m('http://h/api/items?status=open')).toBeUndefined();
    const none = matcher(rule('/api/items', { id: 'b' }, { query: 'exact' }));
    expect(none('http://h/api/items')).toBe('b');
    expect(none('http://h/api/items?x=1')).toBeUndefined();
  });
});

describe('simulation rule matching: priority', () => {
  it('applies the first matching rule in order', () => {
    const m = matcher(rule('/api/orders/:id', { id: 'specific' }), rule('/api/*', { id: 'broad' }));
    expect(m('http://h/api/orders/1')).toBe('specific');
    expect(m('http://h/api/items')).toBe('broad');
  });

  it('skips disabled rules and falls through to the next match', () => {
    const m = matcher(rule('/api/*', { id: 'off', enabled: false }), rule('/api/*', { id: 'on' }));
    expect(m('http://h/api/x')).toBe('on');
  });

  it('skips rules whose method does not match', () => {
    const m = matcher(rule('/api/x', { id: 'post' }, { methods: ['POST'] }), rule('/api/x', { id: 'any' }));
    expect(m('http://h/api/x', 'GET')).toBe('any');
    expect(m('http://h/api/x', 'POST')).toBe('post');
  });
});

describe('sensitive endpoint protection', () => {
  it('classifies authentication and payment URLs', () => {
    expect(sensitiveCategory('http://h/api/auth/login')).toBe('authentication');
    expect(sensitiveCategory('http://h/oauth2/token')).toBe('authentication');
    expect(sensitiveCategory('http://h/.well-known/openid-configuration')).toBe('authentication');
    expect(sensitiveCategory('http://h/api/session')).toBe('authentication');
    // An OAuth callback: hyphenated names count by their words.
    expect(sensitiveCategory('http://h/api/auth-callback')).toBe('authentication');
    expect(sensitiveCategory('http://h/api/login.json')).toBe('authentication');
    expect(sensitiveCategory('http://h/api/checkout')).toBe('payment');
    expect(sensitiveCategory('http://h/v1/payment_intents')).toBe('payment');
    expect(sensitiveCategory('http://h/api/billing/invoices/1')).toBe('payment');
  });

  it('does not treat ordinary endpoints as sensitive', () => {
    expect(sensitiveCategory('http://h/api/orders')).toBeUndefined();
    expect(sensitiveCategory('http://h/api/authors')).toBeUndefined();
    expect(sensitiveCategory('http://h/api/products?pay=1')).toBeUndefined();
    expect(sensitiveCategory('not a url')).toBeUndefined();
  });

  const cat = (path: string) => sensitiveCategory(`http://h${path}`);

  it.each([
    // hyphenated, underscored and camelCase names
    ['/api/sign-in', '/api/sign_in', '/api/signIn', '/api/LogIn', '/api/user/log-out'],
    // nested authentication, session, token and credential paths
    ['/api/v2/auth/oauth-callback', '/api/OAuth2Callback', '/api/me/credentials', '/api/user-credentials'],
    ['/api/refresh_token', '/api/accessToken', '/api/tokens/refresh', '/api/v1/token/exchange'],
    ['/api/csrf-token', '/api/session-token', '/api/api-keys', '/api/sessions'],
    // password reset and verification
    ['/api/resetPassword', '/api/forgot_password', '/api/password-reset', '/api/users/42/change-password'],
    ['/api/verify-email', '/api/email/verification', '/api/verification-code', '/api/confirmEmail'],
    ['/api/two-factor/enable', '/api/mfa-setup', '/api/otp/verify', '/api/magic-link'],
    // account security paths
    ['/api/account/recovery', '/api/account/security', '/api/account/delete', '/api/delete-account'],
  ])('authentication: %s, %s, %s, %s', (...paths) => {
    for (const p of paths) expect(cat(p), p).toBe('authentication');
  });

  it.each([
    [
      '/api/payment-methods',
      '/api/paymentIntents',
      '/api/v1/payment_intents/pi_1/confirm',
      '/api/stripe_webhook',
    ],
    ['/api/checkout-session', '/api/create_checkout', '/api/cart/checkout/confirm', '/api/billing-portal'],
    ['/api/credit-card', '/api/cards/debit_card', '/api/card-details', '/api/place-order'],
    ['/api/bank-account', '/api/payouts/weekly', '/api/pay-now', '/api/billing/invoices/1'],
  ])('payment: %s, %s, %s, %s', (...paths) => {
    for (const p of paths) expect(cat(p), p).toBe('payment');
  });

  it.each([
    // ambiguous words inside compound names
    ['/blog/how-to-pay', '/api/card-games', '/api/token-usage', '/api/user-sessions'],
    ['/api/refresh-rate', '/api/verify-address', '/api/registered-users', '/api/charge-level'],
    // look-alikes
    ['/api/authors', '/api/author-profile', '/api/authorities', '/api/oauthor'],
    ['/api/passwordless-docs', '/api/paysDashboard', '/api/billboards', '/api/checkpoints-report'],
    // accounts and orders in general
    ['/api/accounts/42/orders', '/api/account/profile', '/api/orders/place', '/api/order-history'],
  ])('ordinary: %s, %s, %s, %s', (...paths) => {
    for (const p of paths) expect(cat(p), p).toBeUndefined();
  });

  it('recognizes hosts dedicated to sign-in or payments, by unambiguous words only', () => {
    const at = (url: string) => sensitiveCategory(url);
    expect(at('https://login.microsoftonline.com/common/v2.0/x')).toBe('authentication');
    expect(at('https://auth.example.com/api/items')).toBe('authentication');
    expect(at('https://sso.corp.test/x')).toBe('authentication');
    expect(at('https://api.stripe.com/v1/customers')).toBe('payment');
    expect(at('https://www.paypal.com/x')).toBe('payment');
    expect(at('https://checkout.example.com/x')).toBe('payment');
    // Ordinary hosts, look-alikes and ambiguous labels stay simulatable.
    for (const url of [
      'https://api.example.com/v1/items',
      'https://author.example.com/x',
      'https://pay.example.com/x',
      'https://billboard.example.com/x',
      'http://localhost:3000/api/items',
      'http://127.0.0.1:8080/api/items',
    ])
      expect(at(url), url).toBeUndefined();
  });

  it('splits words at any punctuation (matrix parameters, symbols)', () => {
    expect(cat('/login;jsessionid=abc123')).toBe('authentication');
    expect(cat('/api/sign-in~')).toBe('authentication');
    expect(cat('/api/login!')).toBe('authentication');
    expect(cat('/api/checkout;v=2')).toBe('payment');
    expect(cat('/api/orders;page=2')).toBeUndefined();
  });

  it('examines the path only, decoded but never changed', () => {
    expect(cat('/api/reset%2Dpassword')).toBe('authentication');
    expect(cat('/api/orders?next=/login')).toBeUndefined();
    expect(cat('/api/orders#checkout')).toBeUndefined();
    const m = matcher(rule('/api/*', { id: 'broad' }));
    expect(m('http://h/api/resetPassword', 'POST')).toBeUndefined();
    expect(m('http://h/api/account/profile')).toBe('broad');
  });

  it('never applies a rule to sensitive URLs unless the rule allows it', () => {
    const m = matcher(rule('/api/*', { id: 'broad' }));
    expect(m('http://h/api/orders')).toBe('broad');
    expect(m('http://h/api/auth/login', 'POST')).toBeUndefined();
    expect(m('http://h/api/checkout', 'POST')).toBeUndefined();
  });

  it('applies a rule that explicitly allows sensitive URLs', () => {
    const m = matcher(rule('/api/auth/*', { id: 'auth', allowSensitive: true }));
    expect(m('http://h/api/auth/login', 'POST')).toBe('auth');
  });

  it('lets a later rule that allows sensitive URLs match after a protected one is skipped', () => {
    const m = matcher(
      rule('/api/*', { id: 'broad' }),
      rule('/api/auth/*', { id: 'auth', allowSensitive: true }),
    );
    expect(m('http://h/api/auth/login')).toBe('auth');
    expect(m('http://h/api/items')).toBe('broad');
  });
});
