// Entry point injected into the page's MAIN world at document_start.
// Installs the recorders exactly once per document.
import { DEFAULT_CAPTURE_CONFIG } from '../shared/settings';
import { createId } from '../shared/util';
import { installAppAdapters } from './app-adapters';
import { installBeaconRecorder } from './beacon-recorder';
import { installEventSourceRecorder } from './eventsource-recorder';
import { createPageChannel } from './channel';
import type { RecorderContext } from './context';
import { installDocumentRecorder } from './document-recorder';
import { installFetchRecorder } from './fetch-recorder';
import { installPageEventsRecorder } from './page-events-recorder';
import { installWebSocketRecorder } from './websocket-recorder';
import { installXhrRecorder } from './xhr-recorder';

export const INSTALL_MARKER = Symbol.for('dev-companion.recorder-installed');

export function installRecorder(win: Window & typeof globalThis): boolean {
  const flagged = win as unknown as Record<symbol, unknown>;
  if (flagged[INSTALL_MARKER]) return false;
  Object.defineProperty(win, INSTALL_MARKER, { value: true, enumerable: false });

  const pageId = createId();
  const channel = createPageChannel(win.document, DEFAULT_CAPTURE_CONFIG);
  const ctx: RecorderContext = {
    pageId,
    emit: channel.emit,
    config: channel.config,
    onConfig: channel.onConfig,
    pageUrl: () => win.location.href,
    now: () => Date.now(),
    newId: createId,
  };
  installFetchRecorder(win, ctx);
  installXhrRecorder(win, ctx);
  installBeaconRecorder(win.navigator, ctx);
  installWebSocketRecorder(win, ctx);
  installEventSourceRecorder(win, ctx);
  // Registered scripts run while the document is still loading. A late injection
  // (recording started on an open page) leaves console alone until the next load.
  installPageEventsRecorder(win, ctx, { wrapConsole: win.document.readyState === 'loading' });
  installDocumentRecorder(win, ctx);
  installAppAdapters(win, ctx);
  ctx.emit({ type: 'hello', pageId, url: win.location.href, at: ctx.now() });
  return true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    installRecorder(window);
  } catch {
    /* never break the page */
  }
}
