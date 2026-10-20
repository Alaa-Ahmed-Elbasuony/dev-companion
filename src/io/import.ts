// Import of Dev Companion JSON exports and HAR files. Imported data is
// untrusted: every record is validated, size-limited, re-identified and
// redacted, and stored in a new session marked as imported.
import { decodeMessage, dedupKey, detectProtocol, refineProtocol } from '../analysis/realtime/decode';
import { createRedactor, redactBodyText, redactFreeText, redactUrl } from '../analysis/redaction';
import { redactDecoded } from '../background/realtime-ingest';
import { redactSpan } from '../background/server-traces';
import {
  sanitizeConnectionDraft,
  sanitizeDraft,
  sanitizeMessageDraft,
  sanitizeSpan,
  sanitizeTimelineDraft,
} from '../shared/sanitize';
import type {
  CapturedBody,
  EntryBodies,
  NetworkDraft,
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  ServerSpan,
  Session,
  Settings,
  TimelineEvent,
} from '../shared/types';
import { createId, isJsonContentType, safeUrl } from '../shared/util';
import { buildEntry } from '../storage/entry-builder';
import { EXPORT_FORMAT } from './export';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 10_000;

export class ImportError extends Error {}

export interface ImportResult {
  session: Session;
  entries: { entry: NetworkEntry; bodies: EntryBodies | undefined }[];
  timeline: TimelineEvent[];
  connections: RealtimeConnection[];
  messages: RealtimeMessage[];
  spans: ServerSpan[];
  skipped: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function harEntryToDraft(raw: unknown): unknown {
  if (!isObj(raw) || !isObj(raw.request) || !isObj(raw.response)) return null;
  const req = raw.request;
  const res = raw.response;
  const started = Date.parse(String(raw.startedDateTime));
  const time = typeof raw.time === 'number' ? raw.time : 0;
  const content = isObj(res.content) ? res.content : {};
  const postData = isObj(req.postData) ? req.postData : undefined;
  const status = typeof res.status === 'number' ? res.status : 0;
  const mime = typeof content.mimeType === 'string' ? content.mimeType : undefined;
  let responseBody: CapturedBody | undefined;
  if (typeof content.text === 'string') {
    responseBody =
      content.encoding === 'base64'
        ? {
            kind: 'binary',
            size: typeof content.size === 'number' ? content.size : undefined,
            contentType: mime,
            note: 'Base64 body from HAR not stored',
          }
        : { kind: isJsonContentType(mime) ? 'json' : 'text', text: content.text, contentType: mime };
  }
  const requestBody: CapturedBody | undefined =
    postData && typeof postData.text === 'string'
      ? {
          kind: isJsonContentType(String(postData.mimeType)) ? 'json' : 'text',
          text: postData.text,
          contentType: typeof postData.mimeType === 'string' ? postData.mimeType : undefined,
        }
      : undefined;
  const ext = isObj(raw._devCompanion) ? raw._devCompanion : {};
  return {
    id: 'har',
    pageId: '',
    pageUrl: typeof ext.pageUrl === 'string' ? ext.pageUrl : '',
    source: 'import',
    method: req.method,
    url: req.url,
    state: status > 0 ? 'complete' : 'error',
    status: status > 0 ? status : undefined,
    statusText: res.statusText,
    requestHeaders: req.headers,
    responseHeaders: res.headers,
    startedAt: Number.isFinite(started) ? started : 0,
    endedAt: Number.isFinite(started) ? started + Math.max(0, time) : undefined,
    warnings: ['Imported from HAR'],
    requestBody,
    responseBody,
  };
}

export function parseImport(text: string, fileName: string, settings: Settings): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('File is too large to import (limit 50 MB).');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('File is not valid JSON.');
  }
  if (!isObj(data)) throw new ImportError('Unrecognized file format.');

  let rawDrafts: unknown[];
  let rawTimeline: unknown[] = [];
  if (data.format === EXPORT_FORMAT) {
    if (data.version !== 1 && data.version !== 2) {
      throw new ImportError(`Unsupported export version: ${String(data.version)}`);
    }
    rawDrafts = Array.isArray(data.entries)
      ? data.entries.map((e) => {
          if (!isObj(e)) return null;
          const bodies = isObj(e.bodies) ? e.bodies : {};
          return { ...e, requestBody: bodies.request, responseBody: bodies.response };
        })
      : [];
    rawTimeline = Array.isArray(data.timeline) ? data.timeline : [];
  } else if (isObj(data.log) && Array.isArray(data.log.entries)) {
    rawDrafts = data.log.entries.map(harEntryToDraft);
  } else {
    throw new ImportError('Unrecognized file format. Expected a Dev Companion export or a HAR file.');
  }

  const maxBody = settings.maxBodyKB * 1024;
  const drafts: NetworkDraft[] = [];
  let skipped = 0;
  for (const raw of rawDrafts.slice(0, MAX_IMPORT_ENTRIES)) {
    const draft = sanitizeDraft(raw, maxBody);
    if (!draft || !safeUrl(draft.url)) {
      skipped++;
      continue;
    }
    // Never trust imported "pending" state or ids.
    drafts.push({ ...draft, id: createId(), state: draft.state === 'pending' ? 'incomplete' : draft.state });
  }
  skipped += Math.max(0, rawDrafts.length - MAX_IMPORT_ENTRIES);

  const startedAt = drafts.length ? Math.min(...drafts.map((d) => d.startedAt)) : Date.now();
  const firstOrigin = safeUrl(drafts[0]?.pageUrl || drafts[0]?.url || '')?.origin ?? 'imported';
  const session: Session = {
    id: createId(),
    tabId: -1,
    origin: firstOrigin,
    startedAt,
    endedAt: drafts.length ? Math.max(...drafts.map((d) => d.endedAt ?? d.startedAt)) : startedAt,
    label: `Imported: ${fileName.slice(0, 80)}`,
    imported: true,
  };
  const owner = { sessionId: session.id, tabId: -1, origin: firstOrigin };
  const entries = drafts.map((d) =>
    buildEntry({ ...d, warnings: [...d.warnings, 'Imported data (untrusted)'] }, owner, settings),
  );

  const timeline: TimelineEvent[] = [];
  for (const raw of rawTimeline.slice(0, 20_000)) {
    const t = sanitizeTimelineDraft(raw);
    if (!t) continue;
    timeline.push({
      ...t,
      id: createId(),
      message: redactFreeText(t.message, settings.redaction),
      detail: t.detail ? redactFreeText(t.detail, settings.redaction) : undefined,
      stack: t.stack ? redactFreeText(t.stack, settings.redaction) : undefined,
      pageUrl: redactFreeText(t.pageUrl, settings.redaction),
      sessionId: session.id,
      tabId: -1,
      origin: firstOrigin,
    });
  }
  const realtime = importRealtime(data, session, firstOrigin, settings);
  const spans: ServerSpan[] = [];
  if (data.format === EXPORT_FORMAT && Array.isArray(data.spans)) {
    for (const raw of data.spans.slice(0, 50_000)) {
      const s = sanitizeSpan(raw, { sessionId: session.id, origin: firstOrigin }, maxBody);
      if (s) spans.push(redactSpan(s, settings));
      else skipped++;
    }
  }
  return { session, entries, timeline, ...realtime, spans, skipped: skipped + realtime.skipped };
}

/** Realtime records of a v2 export: validated, re-identified, decoded and redacted again. */
function importRealtime(data: Obj, session: Session, origin: string, settings: Settings) {
  const connections: RealtimeConnection[] = [];
  const messages: RealtimeMessage[] = [];
  let skipped = 0;
  if (data.format !== EXPORT_FORMAT || !Array.isArray(data.connections))
    return { connections, messages, skipped };
  const r = createRedactor(settings.redaction);
  const ids = new Map<string, string>();
  for (const raw of data.connections.slice(0, 10_000)) {
    const d = sanitizeConnectionDraft(raw);
    if (!d) {
      skipped++;
      continue;
    }
    const id = createId();
    ids.set(d.id, id);
    const protocol =
      isObj(raw) && ['raw', 'socket.io', 'signalr', 'sse'].includes(String(raw.protocol))
        ? (raw.protocol as RealtimeConnection['protocol'])
        : detectProtocol(d);
    connections.push({
      ...d,
      id,
      url: redactUrl(d.url, r).url,
      pageUrl: redactUrl(d.pageUrl, r).url,
      state:
        d.state === 'open' || d.state === 'connecting' || d.state === 'reconnecting' ? 'closed' : d.state,
      warnings: [...d.warnings, 'Imported data (untrusted)'],
      source: 'import',
      sessionId: session.id,
      tabId: -1,
      origin,
      protocol,
      sources: ['import'],
      attempt: isObj(raw) && typeof raw.attempt === 'number' ? Math.max(0, Math.round(raw.attempt)) : 0,
      inCount: 0,
      outCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      redactions: 0,
    });
  }
  const byId = new Map(connections.map((c) => [c.id, c]));
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  for (const raw of rawMessages.slice(0, 200_000)) {
    const d = sanitizeMessageDraft(raw, settings.maxFrameKB * 1024);
    const connectionId = d ? ids.get(d.connectionId) : undefined;
    const conn = connectionId ? byId.get(connectionId) : undefined;
    if (!d || !conn) {
      skipped++;
      continue;
    }
    conn.protocol = refineProtocol(conn.protocol, d);
    const decoded = decodeMessage(conn.protocol, d, conn.url);
    const text =
      d.text !== undefined
        ? redactBodyText(d.text, /^\s*[{[]/.test(d.text) ? 'json' : 'text', r).text
        : undefined;
    const size = d.size;
    if (d.opcode !== 'lifecycle') {
      if (d.direction === 'in') {
        conn.inCount++;
        conn.bytesIn += size ?? 0;
      } else if (d.direction === 'out') {
        conn.outCount++;
        conn.bytesOut += size ?? 0;
      }
    }
    messages.push({
      ...d,
      id: createId(),
      connectionId: conn.id,
      text,
      source: 'import',
      sessionId: session.id,
      tabId: -1,
      decoded: decoded.decoded ? redactDecoded(decoded.decoded, r).decoded : undefined,
      parseError: decoded.parseError,
      decodeNote: decoded.decodeNote,
      sources: ['import'],
      dedupKey: dedupKey(conn.id, d.direction, d.opcode, size, d.text),
      redactions: 0,
      note: d.note ? redactFreeText(d.note, settings.redaction) : undefined,
    });
  }
  return { connections, messages, skipped };
}
