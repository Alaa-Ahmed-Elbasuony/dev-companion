// Safeguards for replaying captured requests. Pure logic, so it can be tested
// independently of the UI that enforces it.
import { REDACTED } from '../shared/settings';
import type { HeaderPair, RedactionRules } from '../shared/types';
import { MUTATING_METHODS, safeUrl } from '../shared/util';
import { createRedactor } from './redaction';

/** Headers the browser controls; fetch() silently drops them. */
const FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

export const isForbiddenHeader = (name: string) => {
  const n = name.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith('proxy-') || n.startsWith('sec-');
};

const RISKY_PATH =
  /(order|payment|pay|checkout|charge|purchase|refund|transfer|delete|remove|destroy|cancel|subscribe|invoice|withdraw)/i;

export interface ReplayDraft {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
  includeCredentials: boolean;
}

export interface ReplayAssessment {
  valid: boolean;
  errors: string[];
  targetOrigin: string;
  /** Target origin differs from the original request's origin. */
  originChanged: boolean;
  isMutation: boolean;
  mutationReasons: string[];
  headersToSend: HeaderPair[];
  dropped: { name: string; reason: string }[];
  warnings: string[];
  requiresAcknowledgement: boolean;
}

export function parseHeaderLines(text: string): { headers: HeaderPair[]; errors: string[] } {
  const headers: HeaderPair[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const idx = line.indexOf(':');
    const name = idx > 0 ? line.slice(0, idx).trim() : '';
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      errors.push(`Line ${i + 1}: expected "Name: value"`);
      return;
    }
    headers.push({ name, value: line.slice(idx + 1).trim() });
  });
  return { headers, errors };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function formatHeaderLines(headers: HeaderPair[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join('\n');
}

export function assessReplay(
  draft: ReplayDraft,
  originalUrl: string,
  rules: RedactionRules,
): ReplayAssessment {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const method = draft.method.trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) errors.push('Invalid HTTP method.');
  if (['CONNECT', 'TRACE', 'TRACK'].includes(method)) errors.push(`${method} cannot be sent by the browser.`);
  const target = safeUrl(draft.url);
  if (!target) errors.push('Invalid URL.');
  else if (target.protocol !== 'http:' && target.protocol !== 'https:')
    errors.push('Only http and https URLs can be replayed.');
  const hasBody = draft.body !== undefined && draft.body !== '';
  if (hasBody && (method === 'GET' || method === 'HEAD'))
    errors.push(`${method} requests cannot have a body.`);

  const original = safeUrl(originalUrl);
  const targetOrigin = target?.origin ?? '';
  const originChanged = !!target && !!original && target.origin !== original.origin;
  const redactor = createRedactor(rules);

  const headersToSend: HeaderPair[] = [];
  for (const h of draft.headers) {
    if (h.value.includes(REDACTED)) {
      dropped.push({ name: h.name, reason: 'Value was redacted at capture time; it is not sent.' });
    } else if (isForbiddenHeader(h.name)) {
      dropped.push({ name: h.name, reason: 'Controlled by the browser; fetch() cannot set it.' });
    } else if (redactor.isSensitiveHeader(h.name) && originChanged) {
      dropped.push({
        name: h.name,
        reason: 'Credential header not sent to an origin different from the original request.',
      });
    } else {
      headersToSend.push(h);
      if (redactor.isSensitiveHeader(h.name))
        warnings.push(`You are sending a credential header (${h.name}).`);
    }
  }

  const mutationReasons: string[] = [];
  if (MUTATING_METHODS.has(method)) mutationReasons.push(`${method} requests usually change server state.`);
  if (target && RISKY_PATH.test(target.pathname)) {
    mutationReasons.push(
      `The path "${target.pathname}" suggests an order, payment, deletion or similar action.`,
    );
  }
  if (originChanged)
    warnings.push(`Target origin (${targetOrigin}) differs from the original request (${original?.origin}).`);
  // Placeholders cannot be dropped from a URL or body the way headers are; they would be sent literally.
  const placeholderIn = [
    target && decodeURIComponentSafe(target.href).includes(REDACTED) ? 'URL' : '',
    hasBody && draft.body!.includes(REDACTED) ? 'body' : '',
  ].filter(Boolean);
  if (placeholderIn.length)
    warnings.push(
      `The ${placeholderIn.join(' and ')} still contain${placeholderIn.length > 1 ? '' : 's'} ${REDACTED} placeholders, which would be sent literally. Replace them with real values first.`,
    );
  if (draft.includeCredentials)
    warnings.push(`Browser cookies for ${targetOrigin || 'the target'} will be sent with this request.`);
  warnings.push(
    'The replay is sent from the extension, not the page: the Origin header, cookies, CORS behavior and authentication may differ from the original request.',
  );

  return {
    valid: errors.length === 0,
    errors,
    targetOrigin,
    originChanged,
    isMutation: mutationReasons.length > 0,
    mutationReasons,
    headersToSend,
    dropped,
    warnings,
    requiresAcknowledgement: mutationReasons.length > 0 || draft.includeCredentials || originChanged,
  };
}
