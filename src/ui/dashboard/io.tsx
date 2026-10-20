import { useState } from 'react';
import type {
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  ServerSpan,
  Session,
  Settings,
  TimelineEvent,
} from '../../shared/types';
import { buildHar, buildJsonExport } from '../../io/export';
import { MAX_IMPORT_BYTES, parseImport } from '../../io/import';
import { Modal, Notice } from '../components/common';
import { downloadText, getStore, notifyDataChanged } from '../lib/extension';

export async function importFile(
  file: File,
  settings: Settings,
): Promise<{ sessionId: string; entries: number; skipped: number }> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('File is larger than 50 MB.');
  const result = parseImport(await file.text(), file.name, settings);
  const store = await getStore();
  await store.putSession(result.session);
  for (const { entry, bodies } of result.entries) await store.upsertEntry(entry, bodies, 'replace');
  for (const event of result.timeline) await store.putTimeline(event);
  for (const c of result.connections) await store.putConnection(c);
  for (const m of result.messages) await store.addMessage(m);
  await store.putSpans(result.spans);
  await store.enforceRetention({
    maxEntries: settings.maxEntries,
    maxBytes: settings.maxStorageMB * 1024 * 1024,
  });
  notifyDataChanged();
  return { sessionId: result.session.id, entries: result.entries.length, skipped: result.skipped };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function ExportDialog({
  entries,
  scopeLabel,
  sessions,
  timeline,
  connections = [],
  spans = [],
  settings,
  onClose,
}: {
  entries: NetworkEntry[];
  scopeLabel: string;
  sessions: Session[];
  timeline: TimelineEvent[];
  connections?: RealtimeConnection[];
  spans?: ServerSpan[];
  settings: Settings;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<'json' | 'har'>('json');
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const [includeRealtime, setIncludeRealtime] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const store = await getStore();
      const bodies = await store.getBodiesFor(entries.map((e) => e.id));
      const ordered = [...entries].sort((a, b) => a.startedAt - b.startedAt);
      if (format === 'har') {
        const har = buildHar(ordered, bodies, settings.redaction, chrome.runtime.getManifest().version);
        downloadText(`dev-companion-${stamp()}.har`, JSON.stringify(har, null, 2));
      } else {
        const sessionIds = new Set(ordered.map((e) => e.sessionId));
        let messages: RealtimeMessage[] = [];
        const conns = includeRealtime ? connections.filter((c) => sessionIds.has(c.sessionId)) : [];
        if (conns.length) {
          for (const id of sessionIds)
            messages = messages.concat(await store.listSessionMessages(id, 100_000));
        }
        const bundle = buildJsonExport(
          sessions.filter((s) => sessionIds.has(s.id)),
          ordered,
          bodies,
          includeTimeline ? timeline.filter((t) => sessionIds.has(t.sessionId)) : [],
          settings.redaction,
          {
            connections: conns,
            messages,
            spans: includeRealtime ? spans.filter((s) => sessionIds.has(s.sessionId)) : [],
          },
        );
        downloadText(`dev-companion-${stamp()}.json`, JSON.stringify(bundle, null, 2));
      }
      onClose();
    } catch (err) {
      setError(
        `Export failed: ${err instanceof Error ? err.message : String(err)}. Nothing was downloaded; try exporting fewer requests.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export requests" onClose={onClose}>
      <p>
        Exporting <strong>{scopeLabel}</strong>.
      </p>
      <fieldset className="radio-group">
        <label>
          <input type="radio" checked={format === 'json'} onChange={() => setFormat('json')} /> Dev Companion
          JSON (can be re-imported; includes timeline)
        </label>
        <label>
          <input type="radio" checked={format === 'har'} onChange={() => setFormat('har')} /> HAR 1.2 (for
          other tools)
        </label>
      </fieldset>
      {format === 'json' && (
        <label className="check">
          <input
            type="checkbox"
            checked={includeTimeline}
            onChange={(e) => setIncludeTimeline(e.target.checked)}
          />{' '}
          Include timeline events (console errors, route changes, markers)
        </label>
      )}
      {format === 'json' && (connections.length > 0 || spans.length > 0) && (
        <label className="check">
          <input
            type="checkbox"
            checked={includeRealtime}
            onChange={(e) => setIncludeRealtime(e.target.checked)}
          />{' '}
          Include realtime connections/messages ({connections.length}) and server spans ({spans.length})
        </label>
      )}
      {format === 'har' && (connections.length > 0 || spans.length > 0) && (
        <Notice kind="info">
          HAR contains HTTP requests only; realtime messages and server spans are not included.
        </Notice>
      )}
      <Notice kind="warning">
        Your redaction rules are applied to the export (headers, query parameters, known secret fields, tokens
        and card numbers). Bodies can still contain personal or business data — review the file before sharing
        it, and share it only through an approved channel.
      </Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !entries.length} onClick={run}>
          Download
        </button>
      </div>
    </Modal>
  );
}
