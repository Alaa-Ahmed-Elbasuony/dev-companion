// Browser-observable document diagnostics, emitted once per document as a
// "navigation" timeline event: Navigation Timing (type, redirects, sizes,
// server wait), Server-Timing entries, a server-provided trace context
// (<meta name="traceparent">) and framework markers (Next.js router type).
//
// This is what the browser exposes about the document response. It says
// nothing about requests the server made while rendering; that needs the
// optional server integration.
import { clip } from '../shared/util';
import type { RecorderContext } from './context';

interface DocumentHost {
  document?: Document;
  performance?: Performance;
  addEventListener: Window['addEventListener'];
  setTimeout: typeof setTimeout;
}

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i;

export function parseTraceparent(
  value: string | null | undefined,
): { traceId: string; spanId: string } | null {
  const m = value ? TRACEPARENT.exec(value.trim()) : null;
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!.toLowerCase(), spanId: m[2]!.toLowerCase() };
}

type Data = Record<string, string | number | boolean>;

export function collectDocumentDiagnostics(host: DocumentHost): Data {
  const data: Data = {};
  const nav = host.performance?.getEntriesByType?.('navigation')?.[0] as
    PerformanceNavigationTiming | undefined;
  if (nav) {
    data.navigationType = nav.type;
    data.redirectCount = nav.redirectCount;
    data.transferSize = nav.transferSize;
    data.encodedBodySize = nav.encodedBodySize;
    data.decodedBodySize = nav.decodedBodySize;
    if (nav.nextHopProtocol) data.protocol = nav.nextHopProtocol;
    const status = (nav as PerformanceNavigationTiming & { responseStatus?: number }).responseStatus;
    if (typeof status === 'number' && status > 0) data.status = status;
    // Time from request start to the first response byte: server processing plus network.
    if (nav.responseStart > 0 && nav.requestStart > 0) {
      data.serverWaitMs = Math.round(nav.responseStart - nav.requestStart);
    }
    if (nav.responseEnd > 0) data.responseEndMs = Math.round(nav.responseEnd);
    if (nav.domContentLoadedEventEnd > 0) data.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
    if (nav.loadEventEnd > 0) data.loadMs = Math.round(nav.loadEventEnd);
    // A 0-byte transfer with a body means the document came from a cache.
    if (nav.transferSize === 0 && nav.decodedBodySize > 0) data.fromCache = true;
    for (const st of (nav.serverTiming ?? []).slice(0, 20)) {
      data[`server-timing.${clip(st.name, 60)}`] =
        `${st.duration}ms${st.description ? ` ${clip(st.description, 100)}` : ''}`;
    }
  }
  const doc = host.document;
  const meta = doc?.querySelector?.('meta[name="traceparent"]')?.getAttribute('content');
  const trace = parseTraceparent(meta);
  if (trace) {
    data.traceparent = meta!.trim();
    data.traceId = trace.traceId;
    data.serverSpanId = trace.spanId;
  }
  const win = host as unknown as Record<string, unknown>;
  const nextData = win.__NEXT_DATA__ as Record<string, unknown> | undefined;
  if (nextData && typeof nextData === 'object') {
    data['next.router'] = 'pages';
    if (typeof nextData.buildId === 'string') data['next.buildId'] = clip(nextData.buildId, 80);
    if (typeof nextData.page === 'string') data['next.page'] = clip(nextData.page, 200);
    // Reported by Next.js itself: which data-fetching method produced the page.
    if (nextData.gssp === true) data['next.rendering'] = 'getServerSideProps (rendered per request)';
    else if (nextData.gsp === true) data['next.rendering'] = 'getStaticProps (static or ISR)';
    else if (nextData.autoExport === true) data['next.rendering'] = 'automatic static optimization';
    if (nextData.isFallback === true) data['next.isFallback'] = true;
  } else if (Array.isArray(win.__next_f)) {
    data['next.router'] = 'app';
  }
  const hydration = host.performance?.getEntriesByName?.('Next.js-hydration')?.[0];
  if (hydration) data['next.hydrationMs'] = Math.round(hydration.duration);
  return data;
}

export function installDocumentRecorder(host: DocumentHost, ctx: RecorderContext): () => void {
  let emitted = false;
  const emit = (lateNote?: string) => {
    if (emitted || !ctx.config().enabled) return;
    emitted = true;
    try {
      const data = collectDocumentDiagnostics(host);
      const status = data.status ? ` ${data.status}` : '';
      ctx.emit({
        type: 'timeline',
        event: {
          id: ctx.newId(),
          pageId: ctx.pageId,
          pageUrl: ctx.pageUrl(),
          kind: 'navigation',
          timestamp: ctx.now(),
          message: `Document loaded${status}${data.traceId ? ' · server trace context present' : ''}`,
          detail:
            lateNote ??
            'Browser-observable document metadata (Navigation Timing); server-side requests are not visible here',
          data,
        },
      });
    } catch {
      /* never break the page */
    }
  };
  const onLoad = () => host.setTimeout(() => emit(), 1000);
  const doc = host.document;
  if (doc?.readyState === 'complete') emit('Recorder installed after the page loaded');
  else host.addEventListener('load', onLoad, { once: true });
  // Recording may start later in this document.
  ctx.onConfig?.((cfg) => {
    if (cfg.enabled && doc?.readyState === 'complete') emit('Recording started after the page loaded');
  });
  return () => (host as unknown as Window).removeEventListener?.('load', onLoad);
}
