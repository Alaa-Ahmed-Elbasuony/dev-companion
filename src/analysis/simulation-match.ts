// Matches requests against simulation rules. Pure, so the main-world recorder,
// the worker and the UI share it.
//
// URL patterns:
// - "localhost:3000/api/orders/:id"   host[:port] + path; ":name" is one path segment
// - "localhost:3000/api/*"            "*" matches anything, including "/"
// - "http://localhost:3000/api/*"     a scheme restricts the match to that scheme
// - "/api/orders"                     path only: any host
// - "...?status=open&page=*"          query parameters (see SimulationRule.match.query)
// A trailing "/" on the request path is ignored. Hosts are case-insensitive.
import type { SimulationRule } from '../shared/simulation';

export interface CompiledRule {
  rule: SimulationRule;
  /** Tested against "scheme://host/path", "host/path" or "/path" depending on the pattern. */
  target: 'full' | 'host' | 'path';
  re: RegExp;
  /** Query parameters from the pattern; "*" matches any value. */
  query: [string, string][];
  methods: Set<string>;
}

// Authentication and payment endpoints are never simulated unless the rule says so.
// This is a safety heuristic over path names, not a guarantee: an endpoint named
// differently is not recognized. Only the path is examined, never the request.
//
// A whole path segment is sensitive when it is one of these names:
const AUTH_SEGMENT =
  /^(?:login|logout|log-in|log-out|signin|sign-in|signout|sign-out|signup|sign-up|register|oauth2?|openid|openid-connect|oidc|token|tokens|refresh|refresh-token|auth|authenticate|authorize|authorization|session|sessions|sso|saml|mfa|2fa|otp|password|passwords|reset-password|forgot-password|verify|\.well-known)$/i;
const PAYMENT_SEGMENT =
  /^(?:pay|payment|payments|checkout|billing|charge|charges|card|cards|stripe|paypal|braintree|adyen|invoice|invoices|refund|refunds|subscription|subscriptions|purchase|purchases|wallet|transfer|transfers|withdraw|payout|payouts)$/i;

const escape = (s: string) => s.replace(/[.+?^$()|[\]{}\\]/g, '\\$&');

// Inside a compound segment ("oauth-callback", "resetPassword", "payment_methods")
// only words that are unambiguous on their own count; ambiguous ones ("pay", "card",
// "token", "session", "verify") count as a whole segment above, or in a phrase below.
const AUTH_WORDS = new Set([
  'login',
  'logout',
  'signin',
  'signout',
  'signup',
  'oauth',
  'oauth2',
  'openid',
  'oidc',
  'sso',
  'saml',
  'mfa',
  '2fa',
  'otp',
  'totp',
  'auth',
  'authn',
  'authz',
  'authenticate',
  'authentication',
  'authorize',
  'authorization',
  'password',
  'passwords',
  'passwd',
  'passcode',
  'credential',
  'credentials',
  'passkey',
  'passkeys',
  'webauthn',
]);
const PAYMENT_WORDS = new Set([
  'payment',
  'payments',
  'checkout',
  'billing',
  'stripe',
  'paypal',
  'braintree',
  'adyen',
  'payout',
  'payouts',
]);
// Word sequences, within a segment or across adjacent segments ("/account/recovery").
const AUTH_PHRASES = [
  ['sign', 'in'],
  ['sign', 'out'],
  ['sign', 'up'],
  ['log', 'in'],
  ['log', 'out'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['id', 'token'],
  ['auth', 'token'],
  ['session', 'token'],
  ['csrf', 'token'],
  ['token', 'refresh'],
  ['token', 'exchange'],
  ['token', 'revoke'],
  ['token', 'introspect'],
  ['api', 'key'],
  ['api', 'keys'],
  ['two', 'factor'],
  ['magic', 'link'],
  ['verify', 'email'],
  ['verify', 'phone'],
  ['email', 'verification'],
  ['phone', 'verification'],
  ['confirm', 'email'],
  ['email', 'confirmation'],
  ['verification', 'code'],
  ['account', 'recovery'],
  ['account', 'verification'],
  ['account', 'security'],
  ['account', 'delete'],
  ['delete', 'account'],
  ['account', 'deletion'],
  ['close', 'account'],
];
const PAYMENT_PHRASES = [
  ['credit', 'card'],
  ['debit', 'card'],
  ['card', 'details'],
  ['place', 'order'],
  ['bank', 'account'],
  ['pay', 'now'],
];

/** The words of a path segment or host label: split at camelCase and any non-alphanumeric, lower-cased. */
function segmentWords(segment: string): string[] {
  return segment
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const hasPhrase = (words: string[], phrases: string[][]) =>
  phrases.some((p) => words.some((_, i) => p.every((w, j) => words[i + j] === w)));

/** The sensitive category of a URL, or undefined. */
export function sensitiveCategory(url: string): 'authentication' | 'payment' | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const decoded = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  // "payment_intents" and "login.json" count by their parts as well.
  const segments = decoded.flatMap((s) => [s, ...s.split(/[._]/)]);
  const words = decoded.flatMap(segmentWords);
  // Hosts dedicated to sign-in or payments ("login.example.com", "api.stripe.com"):
  // their labels, without the top-level domain, count by unambiguous words only.
  const hostWords = u.hostname.split('.').slice(0, -1).flatMap(segmentWords);
  if (
    segments.some((s) => AUTH_SEGMENT.test(s)) ||
    words.some((w) => AUTH_WORDS.has(w)) ||
    hostWords.some((w) => AUTH_WORDS.has(w))
  )
    return 'authentication';
  if (hasPhrase(words, AUTH_PHRASES)) return 'authentication';
  if (
    segments.some((s) => PAYMENT_SEGMENT.test(s)) ||
    words.some((w) => PAYMENT_WORDS.has(w)) ||
    hostWords.some((w) => PAYMENT_WORDS.has(w))
  )
    return 'payment';
  if (hasPhrase(words, PAYMENT_PHRASES)) return 'payment';
  return undefined;
}

export function compileRule(rule: SimulationRule): CompiledRule {
  const raw = rule.match.urlPattern.trim();
  const qIndex = raw.indexOf('?');
  const pattern = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = qIndex === -1 ? [] : [...new URLSearchParams(raw.slice(qIndex + 1)).entries()];
  let target: CompiledRule['target'] = 'host';
  if (/^https?:\/\//i.test(pattern)) target = 'full';
  else if (pattern.startsWith('/')) target = 'path';
  const body = pattern
    .replace(/\/+$/, '')
    .split(/(\*+|:[A-Za-z_][\w-]*)/)
    .map((part) => {
      if (/^\*+$/.test(part)) return '.*';
      if (/^:[A-Za-z_]/.test(part)) return '[^/]+';
      return escape(part);
    })
    .join('');
  return {
    rule,
    target,
    // Case-insensitive so hosts match regardless of case; paths are compared the same way.
    re: new RegExp(`^${body}/?$`, 'i'),
    query,
    methods: new Set(rule.match.methods),
  };
}

export function compileRules(rules: readonly SimulationRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      out.push(compileRule(rule));
    } catch {
      /* an uncompilable pattern never matches */
    }
  }
  return out;
}

function queryMatches(compiled: CompiledRule, params: URLSearchParams): boolean {
  for (const [name, value] of compiled.query) {
    const actual = params.getAll(name);
    if (!actual.length) return false;
    if (value !== '*' && !actual.includes(value)) return false;
  }
  if (compiled.rule.match.query !== 'exact') return true;
  // Exact: no parameters beyond the ones the pattern names (order does not matter).
  const named = new Set(compiled.query.map(([name]) => name));
  for (const name of params.keys()) if (!named.has(name)) return false;
  return [...params.keys()].length === compiled.query.length;
}

/**
 * The first enabled rule (in priority order) that matches the request, or undefined.
 * Only http(s) URLs are ever matched. Rules without `allowSensitive` never match
 * authentication or payment URLs; a later rule that allows them still can.
 */
export function matchRule(
  compiled: readonly CompiledRule[],
  method: string,
  url: string,
): SimulationRule | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const m = method.toUpperCase();
  const path = u.pathname;
  const subjects = {
    full: `${u.protocol}//${u.host}${path}`,
    host: `${u.host}${path}`,
    path,
  };
  const sensitive = sensitiveCategory(url) !== undefined;
  for (const c of compiled) {
    if (!c.rule.enabled) continue;
    if (c.methods.size && !c.methods.has(m)) continue;
    if (!c.re.test(subjects[c.target])) continue;
    if (!queryMatches(c, u.searchParams)) continue;
    if (sensitive && !c.rule.allowSensitive) continue;
    return c.rule;
  }
  return undefined;
}
