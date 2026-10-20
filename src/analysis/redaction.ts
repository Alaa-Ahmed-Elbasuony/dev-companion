// Redaction of secrets in headers, URLs and bodies. Pure functions: used by the
// service worker before persisting (removal) and by the UI/export (masking).
import { REDACTED } from '../shared/settings';
import type { CapturedBody, EntryBodies, HeaderPair, NetworkEntry, RedactionRules } from '../shared/types';
import { safeUrl, tryParseJson } from '../shared/util';

export interface Redactor {
  isSensitiveKey(key: string): boolean;
  isSensitiveHeader(name: string): boolean;
  redactString(value: string): { value: string; count: number };
}

const normalize = (key: string) => key.toLowerCase().replace(/[-_\s.]/g, '');

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Card-brand prefixes (Visa, Mastercard, Amex, Discover) with optional separators.
const CARD = /\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6011|65\d{2})(?:[ -]?\d){11,15}\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function createRedactor(rules: RedactionRules): Redactor {
  const exact = new Set<string>();
  const partial: string[] = [];
  for (const rule of rules.keyRules) {
    if (rule.startsWith('=')) exact.add(normalize(rule.slice(1)));
    else if (rule.trim()) partial.push(normalize(rule));
  }
  const headerNames = new Set(rules.headerNames.map((h) => h.toLowerCase()));

  const isSensitiveKey = (key: string) => {
    const n = normalize(key);
    return exact.has(n) || partial.some((p) => p && n.includes(p));
  };

  return {
    isSensitiveKey,
    isSensitiveHeader: (name) => headerNames.has(name.toLowerCase()) || isSensitiveKey(name),
    redactString(value) {
      let count = 0;
      let out = value;
      if (rules.redactTokenValues) {
        out = out.replace(JWT, () => {
          count++;
          return REDACTED;
        });
        out = out.replace(AUTH_SCHEME, (_m, scheme: string) => {
          count++;
          return `${scheme} ${REDACTED}`;
        });
      }
      if (rules.redactCardNumbers) {
        out = out.replace(CARD, (match) => {
          const digits = match.replace(/[ -]/g, '');
          if (digits.length < 15 || digits.length > 19 || !luhnValid(digits)) return match;
          count++;
          return REDACTED;
        });
      }
      return { value: out, count };
    },
  };
}

export function redactHeaders(headers: HeaderPair[], r: Redactor): { headers: HeaderPair[]; count: number } {
  let count = 0;
  const out = headers.map((h) => {
    if (r.isSensitiveHeader(h.name)) {
      if (h.value === REDACTED) return h;
      count++;
      return { name: h.name, value: REDACTED };
    }
    const s = r.redactString(h.value);
    count += s.count;
    return s.count ? { name: h.name, value: s.value } : h;
  });
  return { headers: out, count };
}

function redactParams(params: URLSearchParams, r: Redactor): number {
  let count = 0;
  const entries = [...params.entries()];
  for (const [i, [key, value]] of entries.entries()) {
    if (r.isSensitiveKey(key)) {
      if (value !== REDACTED) {
        entries[i] = [key, REDACTED];
        count++;
      }
    } else {
      const s = r.redactString(value);
      if (s.count) {
        entries[i] = [key, s.value];
        count += s.count;
      }
    }
  }
  if (count) {
    for (const key of new Set(entries.map(([k]) => k))) params.delete(key);
    for (const [k, v] of entries) params.append(k, v);
  }
  return count;
}

export function redactUrl(url: string, r: Redactor): { url: string; count: number } {
  const u = safeUrl(url);
  if (!u) {
    const s = r.redactString(url);
    return { url: s.value, count: s.count };
  }
  let count = redactParams(u.searchParams, r);
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    count++;
  }
  // Fragments can carry OAuth tokens (#access_token=...).
  if (u.hash.includes('=')) {
    const hashParams = new URLSearchParams(u.hash.slice(1));
    const c = redactParams(hashParams, r);
    if (c) {
      u.hash = hashParams.toString();
      count += c;
    }
  }
  return { url: count ? u.href : url, count };
}

// URLs embedded in free text (stack frames, console messages, route-change details).
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;
// Trailing stack-frame location (":12:5") or closing parenthesis, kept outside the URL.
const URL_TEXT_PARTS = /^(.*?)((?::\d+){1,2}\)?|\))?$/s;

/** Applies URL redaction (query/fragment parameters, user-info) to every URL found in text. */
export function redactUrlsInText(text: string, r: Redactor): { text: string; count: number } {
  let count = 0;
  const out = text.replace(URL_IN_TEXT, (match) => {
    const [, url = match, suffix = ''] = URL_TEXT_PARTS.exec(match) ?? [];
    if (!/[?#@]/.test(url)) return match;
    const res = redactUrl(url, r);
    if (!res.count) return match;
    count += res.count;
    return res.url + suffix;
  });
  return { text: out, count };
}

export function redactJsonValue(value: unknown, r: Redactor): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = r.redactString(v);
      count += s.count;
      return s.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (r.isSensitiveKey(k) && child !== null && child !== '' && child !== REDACTED) {
          out[k] = REDACTED;
          count++;
        } else out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  const result = walk(value);
  return { value: result, count };
}

const JSONISH_PAIR = /"((?:[^"\\]|\\.){1,200})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false)/g;

/** Redacts body text according to its kind; falls back to pattern-based redaction. */
export function redactBodyText(
  text: string,
  kind: CapturedBody['kind'],
  r: Redactor,
): { text: string; count: number } {
  if (kind === 'json') {
    const parsed = tryParseJson(text);
    if (parsed.ok) {
      const res = redactJsonValue(parsed.value, r);
      if (!res.count) return { text, count: 0 };
      // Keep compact form if the original was compact.
      const pretty = /\n\s/.test(text);
      return { text: JSON.stringify(res.value, null, pretty ? 2 : undefined), count: res.count };
    }
  }
  if (kind === 'form') {
    const params = new URLSearchParams(text);
    const count = redactParams(params, r);
    return count ? { text: params.toString(), count } : { text, count: 0 };
  }
  // Text, or JSON that could not be parsed (e.g. truncated): pattern-based fallback.
  let count = 0;
  let out = text.replace(JSONISH_PAIR, (match, key: string, sep: string) => {
    if (!r.isSensitiveKey(key)) return match;
    count++;
    return `"${key}"${sep}"${REDACTED}"`;
  });
  const s = r.redactString(out);
  out = s.value;
  count += s.count;
  return { text: out, count };
}

export function redactBody(
  body: CapturedBody | undefined,
  r: Redactor,
): { body: CapturedBody | undefined; count: number } {
  if (!body?.text) return { body, count: 0 };
  const res = redactBodyText(body.text, body.kind, r);
  return res.count ? { body: { ...body, text: res.text }, count: res.count } : { body, count: 0 };
}

/** Returns redacted copies of an entry and its bodies plus the number of values removed. */
export function redactEntry(
  entry: NetworkEntry,
  bodies: EntryBodies | undefined,
  rules: RedactionRules,
): { entry: NetworkEntry; bodies: EntryBodies | undefined; count: number } {
  const r = createRedactor(rules);
  const url = redactUrl(entry.url, r);
  const finalUrl = entry.finalUrl ? redactUrl(entry.finalUrl, r) : undefined;
  const pageUrl = redactUrl(entry.pageUrl, r);
  const reqH = redactHeaders(entry.requestHeaders, r);
  const resH = redactHeaders(entry.responseHeaders, r);
  const reqB = redactBody(bodies?.request, r);
  const resB = redactBody(bodies?.response, r);
  // Stack frames carry the document URL (e.g. an OAuth callback with ?access_token=...).
  const stack = entry.initiatorStack ? redactText(entry.initiatorStack, r) : undefined;
  const error = entry.errorMessage ? redactText(entry.errorMessage, r) : undefined;
  const count =
    url.count +
    (finalUrl?.count ?? 0) +
    pageUrl.count +
    reqH.count +
    resH.count +
    reqB.count +
    resB.count +
    (stack?.count ?? 0) +
    (error?.count ?? 0);
  if (!count) return { entry, bodies, count: 0 };
  return {
    entry: {
      ...entry,
      url: url.url,
      finalUrl: finalUrl?.url,
      pageUrl: pageUrl.url,
      requestHeaders: reqH.headers,
      responseHeaders: resH.headers,
      initiatorStack: stack?.text,
      errorMessage: error?.text,
      redactions: entry.redactions + count,
    },
    bodies: bodies ? { id: bodies.id, request: reqB.body, response: resB.body } : undefined,
    count,
  };
}

/** Free-text redaction: URLs in the text, then key/value patterns. */
function redactText(text: string, r: Redactor): { text: string; count: number } {
  const urls = redactUrlsInText(text, r);
  const rest = redactBodyText(urls.text, 'text', r);
  return { text: rest.text, count: urls.count + rest.count };
}

/** Redacts free text such as console messages, timeline details and page URLs. */
export function redactFreeText(text: string, rules: RedactionRules): string {
  return redactText(text, createRedactor(rules)).text;
}
