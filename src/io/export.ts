// Export formats. Redaction rules are always applied to exported data, even
// if values were stored before a rule existed.
import {
  createRedactor,
  redactBodyText,
  redactEntry,
  redactFreeText,
  redactUrl,
} from '../analysis/redaction';
import { redactDecoded } from '../background/realtime-ingest';
import { redactSpan } from '../background/server-traces';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type {
  EntryBodies,
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  RedactionRules,
  ServerSpan,
  Session,
  TimelineEvent,
} from '../shared/types';
import { safeUrl } from '../shared/util';

export const EXPORT_FORMAT = 'dev-companion-session';
/** v2 adds realtime connections/messages and server spans. v1 files still import. */
export const EXPORT_VERSION = 2;

export interface ExportedEntry extends NetworkEntry {
  bodies?: EntryBodies;
}

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  notice: string;
  sessions: Session[];
  entries: ExportedEntry[];
  timeline: TimelineEvent[];
  connections?: RealtimeConnection[];
  messages?: RealtimeMessage[];
  spans?: ServerSpan[];
}

export interface ExportExtras {
  connections?: RealtimeConnection[];
  messages?: RealtimeMessage[];
  spans?: ServerSpan[];
}

const NOTICE =
  'Redaction rules were applied at export time. Request/response bodies may still contain personal or sensitive data: review before sharing.';

export function buildJsonExport(
  sessions: Session[],
  entries: NetworkEntry[],
  bodies: Map<string, EntryBodies>,
  timeline: TimelineEvent[],
  rules: RedactionRules,
  extras: ExportExtras = {},
): ExportBundle {
  const r = createRedactor(rules);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    notice: NOTICE,
    sessions,
    entries: entries.map((e) => {
      const r = redactEntry(e, bodies.get(e.id), rules);
      return r.bodies ? { ...r.entry, bodies: r.bodies } : r.entry;
    }),
    timeline: timeline.map((t) => ({
      ...t,
      message: redactFreeText(t.message, rules),
      detail: t.detail ? redactFreeText(t.detail, rules) : undefined,
      stack: t.stack ? redactFreeText(t.stack, rules) : undefined,
      pageUrl: redactFreeText(t.pageUrl, rules),
    })),
    connections: extras.connections?.map((c) => ({
      ...c,
      url: redactUrl(c.url, r).url,
      pageUrl: redactUrl(c.pageUrl, r).url,
      closeReason: c.closeReason ? redactFreeText(c.closeReason, rules) : undefined,
      errorMessage: c.errorMessage ? redactFreeText(c.errorMessage, rules) : undefined,
    })),
    messages: extras.messages?.map((m) => ({
      ...m,
      text:
        m.text !== undefined
          ? redactBodyText(m.text, /^\s*[{[]/.test(m.text) ? 'json' : 'text', r).text
          : undefined,
      decoded: m.decoded ? redactDecoded(m.decoded, r).decoded : undefined,
      note: m.note ? redactFreeText(m.note, rules) : undefined,
    })),
    spans: extras.spans?.map((s) => redactSpan(s, { ...DEFAULT_SETTINGS, redaction: rules })),
  };
}

interface HarHeader {
  name: string;
  value: string;
}

export function buildHar(
  entries: NetworkEntry[],
  bodies: Map<string, EntryBodies>,
  rules: RedactionRules,
  version: string,
) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Dev Companion', version },
      comment: NOTICE,
      entries: entries.map((original) => {
        const { entry: e, bodies: b } = redactEntry(original, bodies.get(original.id), rules);
        const url = safeUrl(e.url);
        const req = b?.request;
        const res = b?.response;
        const wait = e.responseAt !== undefined ? Math.max(0, e.responseAt - e.startedAt) : (e.duration ?? 0);
        const receive =
          e.responseAt !== undefined && e.endedAt !== undefined ? Math.max(0, e.endedAt - e.responseAt) : 0;
        const headers = (list: HarHeader[]) => list.map((h) => ({ name: h.name, value: h.value }));
        return {
          startedDateTime: new Date(e.startedAt).toISOString(),
          time: e.duration ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: 'unknown',
            cookies: [],
            headers: headers(e.requestHeaders),
            queryString: url ? [...url.searchParams.entries()].map(([name, value]) => ({ name, value })) : [],
            ...(req && req.kind !== 'none'
              ? {
                  postData: {
                    mimeType: req.contentType ?? e.requestContentType ?? '',
                    text: req.text ?? '',
                    ...(req.note ? { comment: req.note } : {}),
                  },
                }
              : {}),
            headersSize: -1,
            bodySize: e.requestBodySize ?? (req?.kind === 'none' || !req ? 0 : -1),
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? '',
            httpVersion: 'unknown',
            cookies: [],
            headers: headers(e.responseHeaders),
            content: {
              size: e.responseBodySize ?? -1,
              mimeType: e.responseContentType ?? '',
              ...(res?.text !== undefined ? { text: res.text } : {}),
              ...(res?.note ? { comment: res.note } : {}),
            },
            redirectURL: e.redirected && e.finalUrl ? e.finalUrl : '',
            headersSize: -1,
            bodySize: e.responseBodySize ?? -1,
          },
          cache: {},
          timings: { send: 0, wait, receive },
          _devCompanion: {
            id: e.id,
            state: e.state,
            source: e.source,
            pageUrl: e.pageUrl,
            warnings: e.warnings,
            error: e.errorMessage ? `${e.errorName ?? 'Error'}: ${e.errorMessage}` : undefined,
            initiator: e.initiatorStack,
          },
        };
      }),
    },
  };
}
