// Converts a sanitized draft into a persisted entry: applies redaction (values
// are removed before storage) and computes approximate storage size.
import { redactEntry } from '../analysis/redaction';
import type { EntryBodies, NetworkDraft, NetworkEntry, Settings } from '../shared/types';
import { headerValue } from '../shared/util';

export interface EntryOwner {
  sessionId: string;
  tabId: number;
  origin: string;
}

export function estimateBytes(entry: NetworkEntry, bodies: EntryBodies | undefined): number {
  const summary = JSON.stringify({ ...entry, bytes: 0 }).length;
  return summary + (bodies?.request?.text?.length ?? 0) + (bodies?.response?.text?.length ?? 0) + 64;
}

export function buildEntry(
  draft: NetworkDraft,
  owner: EntryOwner,
  settings: Settings,
  extra: Partial<Pick<NetworkEntry, 'replayOf'>> = {},
): { entry: NetworkEntry; bodies: EntryBodies | undefined } {
  const warnings = [...draft.warnings];
  const req = draft.requestBody;
  const res = draft.responseBody;
  if (req?.truncated && !warnings.some((w) => w.includes('equest body')))
    warnings.push('Request body truncated');
  if (res?.truncated && !warnings.some((w) => /truncated|incomplete/i.test(w))) {
    warnings.push(res.note ?? 'Response body truncated');
  }
  if (res && (res.kind === 'stream' || res.kind === 'unreadable') && res.note) warnings.push(res.note);

  const entry: NetworkEntry = {
    id: draft.id,
    sessionId: owner.sessionId,
    tabId: owner.tabId,
    pageId: draft.pageId,
    pageUrl: draft.pageUrl,
    origin: owner.origin,
    source: draft.source,
    method: draft.method,
    url: draft.url,
    finalUrl: draft.finalUrl,
    redirected: draft.redirected,
    state: draft.state,
    status: draft.status,
    statusText: draft.statusText,
    requestHeaders: draft.requestHeaders,
    responseHeaders: draft.responseHeaders,
    requestContentType: req?.contentType ?? headerValue(draft.requestHeaders, 'content-type'),
    responseContentType: res?.contentType ?? headerValue(draft.responseHeaders, 'content-type'),
    requestBodySize: req?.size,
    responseBodySize: res?.size,
    requestBodyKind: req?.kind,
    responseBodyKind: res?.kind,
    startedAt: draft.startedAt,
    responseAt: draft.responseAt,
    endedAt: draft.endedAt,
    duration: draft.endedAt !== undefined ? Math.max(0, draft.endedAt - draft.startedAt) : undefined,
    errorName: draft.errorName,
    errorMessage: draft.errorMessage,
    initiatorStack: draft.initiatorStack,
    warnings: [...new Set(warnings)],
    redactions: 0,
    replayOf: extra.replayOf,
    bytes: 0,
  };
  const bodies: EntryBodies | undefined =
    req || res ? { id: draft.id, request: req, response: res } : undefined;
  const redacted = redactEntry(entry, bodies, settings.redaction);
  redacted.entry.bytes = estimateBytes(redacted.entry, redacted.bodies);
  return { entry: redacted.entry, bodies: redacted.bodies };
}
