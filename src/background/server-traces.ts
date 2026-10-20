// Pulls server spans from configured local collectors (packages/server-tracer)
// into the recording session of the matching application origin.
//
// There is no long-lived connection: the worker pulls shortly after page
// activity of a mapped origin (navigation, completed requests) and when a UI
// page asks. The collector keeps spans in a bounded buffer, so nothing is lost
// between pulls unless the server restarts or the buffer overflows; both are
// detected and reported.
import { createRedactor, redactBodyText, redactFreeText, redactUrl } from '../analysis/redaction';
import { sanitizeSpan } from '../shared/sanitize';
import type { RecordingState, ServerIntegration, ServerSpan, Settings } from '../shared/types';
import { createId } from '../shared/util';
import type { EntryStore } from '../storage/database';

export const TOKENS_KEY = 'integrationTokens';
const CURSORS_KEY = 'traceCursors';
export const TRACE_STATUS_KEY = 'traceStatus';
const MAX_PAGES = 10;
/** Spans that started this long before recording began are ignored (same-machine clock skew allowance). */
const START_GRACE_MS = 2000;

export interface TraceStatus {
  ok: boolean;
  message: string;
  at: number;
  lastSpanCount?: number;
  service?: string;
}

interface CursorState {
  instance: string;
  cursor: number;
  dropped: number;
}

export interface TraceSyncDeps {
  store: EntryStore;
  settings: () => Promise<Settings>;
  recordings: () => Promise<RecordingState[]>;
  fetch?: typeof fetch;
  onStored: () => void;
}

export class TraceSync {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: TraceSyncDeps) {}

  /** Debounced pull after page activity; a second pull catches spans that end after the response. */
  schedule(origin: string) {
    for (const [key, delay] of [
      [`${origin}|1`, 800],
      [`${origin}|2`, 3000],
    ] as const) {
      if (this.timers.has(key)) continue;
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          void this.syncOrigin(origin).catch(() => undefined);
        }, delay),
      );
    }
  }

  async syncAll(): Promise<Record<string, TraceStatus>> {
    const settings = await this.deps.settings();
    for (const integration of settings.serverIntegrations) {
      if (integration.enabled) await this.syncIntegration(integration, settings).catch(() => undefined);
    }
    return getTraceStatus();
  }

  async syncOrigin(origin: string) {
    const settings = await this.deps.settings();
    for (const integration of settings.serverIntegrations) {
      if (integration.enabled && integration.appOrigin === origin)
        await this.syncIntegration(integration, settings);
    }
  }

  private async syncIntegration(integration: ServerIntegration, settings: Settings): Promise<void> {
    const recordings = (await this.deps.recordings())
      .filter((r) => r.origin === integration.appOrigin && !r.paused)
      .sort((a, b) => b.startedAt - a.startedAt);
    const rec = recordings[0];
    if (!rec) return; // traces are only collected while the application is being recorded
    const tokens = ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Record<string, string>;
    const token = tokens[integration.id];
    if (!token) {
      await setStatus(integration.id, {
        ok: false,
        message: 'No collector token configured',
        at: Date.now(),
      });
      return;
    }
    const cursors = ((await chrome.storage.session.get(CURSORS_KEY))[CURSORS_KEY] ?? {}) as Record<
      string,
      CursorState
    >;
    let state = cursors[integration.id];
    const doFetch = this.deps.fetch ?? fetch;
    let stored = 0;
    let service: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      let response: Response;
      try {
        response = await doFetch(
          `${integration.collectorUrl}/v1/spans?after=${state?.cursor ?? 0}&limit=500`,
          {
            headers: { authorization: `Bearer ${token}` },
            cache: 'no-store',
            credentials: 'omit',
          },
        );
      } catch (err) {
        await setStatus(integration.id, {
          ok: false,
          message: `Collector unreachable at ${integration.collectorUrl} (${String(err instanceof Error ? err.message : err)}). Is the dev server running with DEV_COMPANION_TRACING=1?`,
          at: Date.now(),
        });
        return;
      }
      if (response.status === 401) {
        await setStatus(integration.id, {
          ok: false,
          message: 'The collector rejected the token',
          at: Date.now(),
        });
        return;
      }
      if (!response.ok) {
        await setStatus(integration.id, {
          ok: false,
          message: `Collector answered HTTP ${response.status}`,
          at: Date.now(),
        });
        return;
      }
      let body: {
        instance?: unknown;
        cursor?: unknown;
        spans?: unknown;
        dropped?: unknown;
        more?: unknown;
        service?: unknown;
      };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        await setStatus(integration.id, {
          ok: false,
          message: 'Collector returned invalid JSON',
          at: Date.now(),
        });
        return;
      }
      const instance = typeof body.instance === 'string' ? body.instance : '';
      service = typeof body.service === 'string' ? body.service : service;
      if (state && state.instance !== instance) {
        await this.note(
          rec,
          'The server tracing collector restarted; spans not pulled before the restart are lost',
        );
        state = undefined;
        continue; // re-read from the beginning of the new instance
      }
      const dropped = typeof body.dropped === 'number' ? body.dropped : 0;
      if (state && dropped > state.dropped && Array.isArray(body.spans) && body.spans.length >= 500) {
        await this.note(
          rec,
          'The collector buffer overflowed between pulls; some server spans were not captured',
        );
      }
      const spans = Array.isArray(body.spans) ? body.spans : [];
      const accepted = spans
        .map((s) =>
          sanitizeSpan(s, { sessionId: rec.sessionId, origin: rec.origin }, settings.maxBodyKB * 1024),
        )
        .filter((s): s is ServerSpan => !!s && s.startTime >= rec.startedAt - START_GRACE_MS)
        .map((s) => redactSpan(s, settings));
      stored += await this.deps.store.putSpans(accepted);
      state = {
        instance,
        cursor: typeof body.cursor === 'number' ? body.cursor : (state?.cursor ?? 0),
        dropped,
      };
      if (body.more !== true) break;
    }
    if (state) {
      cursors[integration.id] = state;
      await chrome.storage.session.set({ [CURSORS_KEY]: cursors });
    }
    if (stored) {
      await this.deps.store.enforceSpanRetention(settings.maxSpans);
      this.deps.onStored();
    }
    await setStatus(integration.id, {
      ok: true,
      message: stored ? `Pulled ${stored} span(s)` : 'Connected; no new spans',
      at: Date.now(),
      lastSpanCount: stored,
      service,
    });
  }

  private async note(rec: RecordingState, message: string) {
    await this.deps.store.putTimeline({
      id: createId(),
      sessionId: rec.sessionId,
      tabId: rec.tabId,
      origin: rec.origin,
      pageId: '',
      pageUrl: '',
      kind: 'capture',
      timestamp: Date.now(),
      message,
    });
  }
}

/** Second redaction pass with the extension's own (user-configurable) rules. */
export function redactSpan(span: ServerSpan, settings: Settings): ServerSpan {
  const r = createRedactor(settings.redaction);
  let count = 0;
  const text = (t: string) => {
    const out = redactFreeText(t, settings.redaction);
    if (out !== t) count++;
    return out;
  };
  const attributes: ServerSpan['attributes'] = {};
  for (const [k, v] of Object.entries(span.attributes)) {
    const header = /^http\.(request|response)\.header\.(.+)$/.exec(k);
    if ((header && r.isSensitiveHeader(header[2]!)) || r.isSensitiveKey(k.split('.').pop() ?? k)) {
      attributes[k] = '[REDACTED]';
      if (v !== '[REDACTED]') count++;
    } else attributes[k] = typeof v === 'string' ? text(v) : v;
  }
  const url = span.httpUrl ? redactUrl(span.httpUrl, r) : undefined;
  count += url?.count ?? 0;
  const body = (t: string | undefined) => {
    if (t === undefined) return undefined;
    const res = redactBodyText(t, /^\s*[{[]/.test(t) ? 'json' : 'text', r);
    count += res.count;
    return res.text;
  };
  return {
    ...span,
    name: text(span.name),
    statusMessage: span.statusMessage ? text(span.statusMessage) : undefined,
    httpUrl: url?.url,
    attributes,
    events: span.events.map((e) => ({
      ...e,
      attributes: e.attributes
        ? Object.fromEntries(
            Object.entries(e.attributes).map(([k, v]) => [k, typeof v === 'string' ? text(v) : v]),
          )
        : undefined,
    })),
    requestBody: body(span.requestBody),
    responseBody: body(span.responseBody),
    redactions: span.redactions + count,
  };
}

async function setStatus(id: string, status: TraceStatus) {
  const all = await getTraceStatus();
  all[id] = status;
  await chrome.storage.session.set({ [TRACE_STATUS_KEY]: all });
}

export async function getTraceStatus(): Promise<Record<string, TraceStatus>> {
  return ((await chrome.storage.session.get(TRACE_STATUS_KEY))[TRACE_STATUS_KEY] ?? {}) as Record<
    string,
    TraceStatus
  >;
}
