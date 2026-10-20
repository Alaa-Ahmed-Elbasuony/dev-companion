// Redaction applied on the server before a span ever leaves the process. Mirrors
// the extension's default rules (the extension redacts again on ingest).

export const REDACTED = '[REDACTED]';

export const DEFAULT_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
];

export const DEFAULT_KEY_RULES = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'sessionid',
  'authorization',
  'cookie',
  'cardnumber',
  'creditcard',
  '=pwd',
  '=cvv',
  '=cvc',
  '=ssn',
  '=pin',
  '=otp',
];

const normalize = (key) =>
  String(key)
    .toLowerCase()
    .replace(/[-_\s.]/g, '');
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * @param {{ headerNames?: string[]; keyRules?: string[] }} [extra]
 */
export function createRedactor(extra = {}) {
  const headers = new Set(
    [...DEFAULT_HEADER_NAMES, ...(extra.headerNames ?? [])].map((h) => h.toLowerCase()),
  );
  const exact = new Set();
  const partial = [];
  for (const rule of [...DEFAULT_KEY_RULES, ...(extra.keyRules ?? [])]) {
    if (rule.startsWith('=')) exact.add(normalize(rule.slice(1)));
    else if (rule.trim()) partial.push(normalize(rule));
  }
  const isSensitiveKey = (key) => {
    const n = normalize(key);
    return exact.has(n) || partial.some((p) => n.includes(p));
  };
  let count = 0;
  const string = (value) =>
    String(value)
      .replace(JWT, () => (count++, REDACTED))
      .replace(AUTH_SCHEME, (_m, scheme) => (count++, `${scheme} ${REDACTED}`));

  const url = (value) => {
    let u;
    try {
      u = new URL(value);
    } catch {
      return string(value);
    }
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      count++;
    }
    for (const [k] of [...u.searchParams]) {
      if (isSensitiveKey(k)) {
        u.searchParams.set(k, REDACTED);
        count++;
      }
    }
    return string(u.href);
  };

  /** Free text that may embed URLs (span names, status messages). */
  const text = (value) => string(String(value).replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => url(m)));

  const json = (value) => {
    if (Array.isArray(value)) return value.map(json);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (isSensitiveKey(k) && v !== null && v !== '') {
          out[k] = REDACTED;
          count++;
        } else out[k] = json(v);
      }
      return out;
    }
    return typeof value === 'string' ? string(value) : value;
  };

  /** Redacts body text: JSON structurally, everything else by pattern. */
  const body = (text) => {
    try {
      return JSON.stringify(json(JSON.parse(text)));
    } catch {
      return string(
        text.replace(/"([^"\\]{1,200})"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, (m, key, sep) =>
          isSensitiveKey(key) ? (count++, `"${key}"${sep}"${REDACTED}"`) : m,
        ),
      );
    }
  };

  return {
    isSensitiveHeader: (name) => headers.has(String(name).toLowerCase()) || isSensitiveKey(name),
    isSensitiveKey,
    string,
    text,
    url,
    json,
    body,
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}
