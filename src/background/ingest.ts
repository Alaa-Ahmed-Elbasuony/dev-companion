// Turns batches of untrusted page events into persisted records.
import { redactFreeText } from '../analysis/redaction';
import type { RecordingState, Settings, TimelineEvent } from '../shared/types';
import {
  sanitizeConnectionDraft,
  sanitizeDraft,
  sanitizeMessageDraft,
  sanitizeTimelineDraft,
} from '../shared/sanitize';
import { createId } from '../shared/util';
import type { EntryBodies, NetworkEntry } from '../shared/types';
import type { EntryStore, UpsertMode } from '../storage/database';
import { isQuotaError } from '../storage/database';
import { buildEntry, estimateBytes } from '../storage/entry-builder';
import { RealtimeIngestor } from './realtime-ingest';
import { TransportDeriver, findNegotiate } from './transport-derivation';

export interface IngestDeps {
  store: EntryStore;
  settings: () => Promise<Settings>;
  recording: (tabId: number) => Promise<RecordingState | null>;
  onStorageError?: (message: string) => void;
}

export interface IngestResult {
  stored: number;
  dropped: number;
  /** A new document announced itself (used to refresh the badge). */
  sawHello: boolean;
}

export const NAVIGATED_WARNING = 'Page navigated or reloaded before this request completed';
export const CONNECTION_NAVIGATED_WARNING =
  'Page navigated or reloaded; the connection ended with the document';

const AGE_RETENTION_INTERVAL_MS = 10 * 60_000;

const isType = (event: unknown, type: string) => (event as { type?: unknown } | null)?.type === type;

export class Ingestor {
  readonly realtime: RealtimeIngestor;
  private readonly deriver: TransportDeriver;
  private lastAgeRetention = 0;

  constructor(private readonly deps: IngestDeps) {
    this.realtime = new RealtimeIngestor(deps.store, (sessionId, url, at) =>
      findNegotiate(deps.store, sessionId, url, at),
    );
    this.deriver = new TransportDeriver(deps.store, this.realtime);
  }

  /**
   * @param senderOrigin Origin of the sending document as reported by Chrome
   *   (trusted), used to ignore events from pages outside the recorded origin.
   */
  async ingestBatch(tabId: number, senderOrigin: string, events: unknown[]): Promise<IngestResult> {
    const rec = await this.deps.recording(tabId);
    if (!rec || rec.paused || rec.origin !== senderOrigin || !Array.isArray(events)) {
      return { stored: 0, dropped: Array.isArray(events) ? events.length : 0, sawHello: false };
    }
    return this.ingestEvents(rec, events);
  }

  /**
   * Events from a mechanism the worker trusts (CDP). The caller has already
   * checked that the tab is still on the recorded origin.
   */
  async ingestTrusted(tabId: number, events: unknown[]): Promise<IngestResult> {
    const rec = await this.deps.recording(tabId);
    if (!rec || rec.paused) return { stored: 0, dropped: events.length, sawHello: false };
    return this.ingestEvents(rec, events);
  }

  private async ingestEvents(rec: RecordingState, events: unknown[]): Promise<IngestResult> {
    const result: IngestResult = { stored: 0, dropped: 0, sawHello: false };
    const tabId = rec.tabId;
    const settings = await this.deps.settings();
    const maxBody = settings.maxBodyKB * 1024;
    const owner = { sessionId: rec.sessionId, tabId, origin: rec.origin };

    const list = events.slice(0, 500);
    for (let i = 0; i < list.length; i++) {
      if (settings.captureRealtime && isType(list[i], 'rt-message')) {
        // Consecutive frames are stored in one transaction, so a burst does not
        // hold up later events (navigation, requests) behind it.
        let end = i;
        while (end < list.length && isType(list[end], 'rt-message')) end++;
        const run = list
          .slice(i, end)
          .map((e) => sanitizeMessageDraft((e as { message?: unknown }).message, settings.maxFrameKB * 1024));
        i = end - 1;
        const drafts = run.filter((d): d is NonNullable<typeof d> => !!d);
        result.dropped += run.length - drafts.length;
        try {
          const stored = (await this.realtime.ingestMessages(drafts, owner, settings)).filter(Boolean).length;
          result.stored += stored;
          result.dropped += drafts.length - stored;
        } catch (err) {
          result.dropped += drafts.length;
          this.deps.onStorageError?.(`Failed to store captured events: ${String(err)}`);
        }
        continue;
      }
      const event = list[i] as {
        type?: unknown;
        draft?: unknown;
        event?: unknown;
        connection?: unknown;
        message?: unknown;
        count?: unknown;
        pageId?: unknown;
        url?: unknown;
        at?: unknown;
      };
      try {
        if (event?.type === 'hello' && typeof event.pageId === 'string') {
          result.sawHello = true;
          await this.deps.store.markIncomplete(tabId, event.pageId, NAVIGATED_WARNING);
          await this.deps.store.closeConnectionsOfOtherPages(
            tabId,
            event.pageId,
            CONNECTION_NAVIGATED_WARNING,
            typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now(),
          );
          await this.deps.store.putTimeline({
            id: createId(),
            sessionId: rec.sessionId,
            tabId,
            origin: rec.origin,
            pageId: event.pageId.slice(0, 100),
            pageUrl: redactFreeText(String(event.url ?? '').slice(0, 8192), settings.redaction),
            kind: 'page-load',
            timestamp: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now(),
            message: 'Page loaded; recorder installed',
          });
          result.stored++;
        } else if (event?.type === 'network-start' || event?.type === 'network-end') {
          const draft = sanitizeDraft(event.draft, maxBody);
          if (!draft) {
            result.dropped++;
            continue;
          }
          const { entry, bodies } = buildEntry(draft, owner, settings);
          const written = await this.persist(entry, bodies, event.type === 'network-start' ? 'start' : 'end');
          if (written) result.stored++;
          if (written && event.type === 'network-end' && settings.captureRealtime) {
            // Polling transports (Socket.IO, SignalR) also become realtime messages.
            result.stored += await this.deriver.derive({
              draft,
              bodies: { id: draft.id, request: draft.requestBody, response: draft.responseBody },
              owner,
              settings,
            });
          }
        } else if (event?.type === 'rt-connection' || event?.type === 'rt-message') {
          if (!settings.captureRealtime) {
            result.dropped++;
            continue;
          }
          let ok = false;
          if (event.type === 'rt-connection') {
            const conn = sanitizeConnectionDraft(event.connection);
            if (conn) ok = await this.realtime.ingestConnection(conn, owner, settings);
          } else {
            const msg = sanitizeMessageDraft(event.message, settings.maxFrameKB * 1024);
            if (msg) ok = await this.realtime.ingestMessage(msg, owner, settings);
          }
          if (ok) result.stored++;
          else result.dropped++;
        } else if (event?.type === 'capture-dropped') {
          const count = typeof event.count === 'number' && Number.isFinite(event.count) ? event.count : 0;
          if (count <= 0) continue;
          await this.deps.store.putTimeline({
            id: createId(),
            sessionId: rec.sessionId,
            tabId,
            origin: rec.origin,
            pageId: '',
            pageUrl: '',
            kind: 'capture',
            timestamp: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now(),
            message: `Capture incomplete: ${Math.round(count)} event(s) dropped by the page-to-extension rate limit`,
          });
          result.stored++;
        } else if (event?.type === 'timeline') {
          const draft = sanitizeTimelineDraft(event.event);
          if (!draft) {
            result.dropped++;
            continue;
          }
          const reserved = draft.kind === 'marker' || draft.kind === 'recording' || draft.kind === 'capture';
          const timelineEvent: TimelineEvent = {
            ...draft,
            // Recorder-reported "marker"/"recording"/"capture" kinds are reserved for the extension.
            kind: reserved ? 'console-warn' : draft.kind,
            data: draft.data ? redactRecord(draft.data, settings) : undefined,
            message: redactFreeText(draft.message, settings.redaction),
            detail: draft.detail ? redactFreeText(draft.detail, settings.redaction) : undefined,
            stack: draft.stack ? redactFreeText(draft.stack, settings.redaction) : undefined,
            pageUrl: redactFreeText(draft.pageUrl, settings.redaction),
            sessionId: rec.sessionId,
            tabId,
            origin: rec.origin,
          };
          await this.deps.store.putTimeline(timelineEvent);
          result.stored++;
        } else {
          result.dropped++;
        }
      } catch (err) {
        result.dropped++;
        this.deps.onStorageError?.(`Failed to store captured event: ${String(err)}`);
      }
    }

    await this.deps.store.enforceRetention({
      maxEntries: settings.maxEntries,
      maxBytes: settings.maxStorageMB * 1024 * 1024,
    });
    await this.deps.store.enforceTimelineRetention(settings.maxTimelineEvents);
    await this.deps.store.enforceRealtimeRetention(settings.maxRealtimeMessages);
    if (settings.retentionDays > 0 && Date.now() - this.lastAgeRetention > AGE_RETENTION_INTERVAL_MS) {
      this.lastAgeRetention = Date.now();
      await this.deps.store.deleteOlderThan(Date.now() - settings.retentionDays * 86_400_000);
    }
    return result;
  }

  /** Writes an entry; on quota errors evicts old data, then falls back to storing without bodies. */
  async persist(entry: NetworkEntry, bodies: EntryBodies | undefined, mode: UpsertMode): Promise<boolean> {
    const { store } = this.deps;
    try {
      return await store.upsertEntry(entry, bodies, mode);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }
    this.deps.onStorageError?.('Storage quota exceeded: evicted the oldest 25% of entries.');
    await store.evictOldestFraction(0.25);
    try {
      return await store.upsertEntry(entry, bodies, mode);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }
    const slim: NetworkEntry = {
      ...entry,
      warnings: [...entry.warnings, 'Bodies were not stored because the storage quota was exceeded'],
    };
    slim.bytes = estimateBytes(slim, undefined);
    this.deps.onStorageError?.('Storage quota exceeded: stored request without bodies.');
    return store.upsertEntry(slim, undefined, mode);
  }
}

function redactRecord(
  data: Record<string, string | number | boolean>,
  settings: Settings,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' ? redactFreeText(v, settings.redaction) : v;
  }
  return out;
}
