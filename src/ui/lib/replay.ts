// Sends a user-confirmed replay from the extension page and stores the result
// as a "replay" entry linked to the original request.
import { readResponseBody } from '../../capture/body';
import { headersToPairs } from '../../capture/context';
import type { ReplayAssessment, ReplayDraft } from '../../analysis/replay-safety';
import type { NetworkDraft, NetworkEntry, Settings } from '../../shared/types';
import { createId, headerValue } from '../../shared/util';
import { buildEntry } from '../../storage/entry-builder';
import { getStore, notifyDataChanged } from './extension';

export async function executeReplay(
  original: NetworkEntry,
  draft: ReplayDraft,
  assessment: ReplayAssessment,
  settings: Settings,
): Promise<NetworkEntry> {
  const method = draft.method.trim().toUpperCase();
  const body = draft.body === '' ? undefined : draft.body;
  const contentType = headerValue(assessment.headersToSend, 'content-type');
  const result: NetworkDraft = {
    id: createId(),
    pageId: 'replay',
    pageUrl: original.pageUrl,
    source: 'replay',
    method,
    url: draft.url,
    state: 'pending',
    requestHeaders: assessment.headersToSend,
    responseHeaders: [],
    startedAt: Date.now(),
    warnings: [
      'Replayed from the extension; cookies, Origin and CORS behavior may differ from the original request',
    ],
    requestBody:
      body !== undefined
        ? { kind: contentType && /json/i.test(contentType) ? 'json' : 'text', text: body, contentType }
        : undefined,
  };
  const headers = new Headers();
  for (const h of assessment.headersToSend) {
    try {
      headers.append(h.name, h.value);
    } catch {
      result.warnings.push(`Header "${h.name}" was rejected by the browser`);
    }
  }
  try {
    const response = await fetch(draft.url, {
      method,
      headers,
      body,
      credentials: draft.includeCredentials ? 'include' : 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    result.responseAt = Date.now();
    result.status = response.status;
    result.statusText = response.statusText;
    result.responseHeaders = headersToPairs(response.headers);
    if (response.redirected) {
      result.redirected = true;
      result.finalUrl = response.url;
    }
    result.responseBody = await readResponseBody(response, {
      maxBytes: settings.maxBodyKB * 1024,
      timeoutMs: 30_000,
      method,
    });
    result.state = 'complete';
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    result.state = name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted' : 'error';
    result.errorName = name;
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }
  result.endedAt = Date.now();
  const { entry, bodies } = buildEntry(
    result,
    { sessionId: original.sessionId, tabId: original.tabId, origin: original.origin },
    settings,
    { replayOf: original.id },
  );
  await (await getStore()).upsertEntry(entry, bodies, 'replace');
  notifyDataChanged();
  return entry;
}
