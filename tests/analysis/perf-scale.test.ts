// Guards against quadratic analysis on large sessions (the dashboard runs these
// on its main thread). Budgets are ~6-8x observed times (findings ~120ms, links
// ~65ms, timeline ~40ms, investigation ~15ms) so O(n²) regressions fail fast.
import { describe, expect, it } from 'vitest';
import { detectIssues } from '../../src/analysis/error-detector';
import { computeLinks, buildInvestigation } from '../../src/analysis/investigation';
import { investigatorFindings, withEvidenceLevels } from '../../src/analysis/investigator-rules';
import { buildUnifiedTimeline } from '../../src/analysis/unified-timeline';
import type { RealtimeConnection, RealtimeMessage, TimelineEvent } from '../../src/shared/types';
import { entry } from '../helpers/entries';

function session(nEntries: number, nConnections: number, nMessages: number) {
  const entries = Array.from({ length: nEntries }, (_, i) =>
    entry({
      id: `e${i}`,
      tabId: 1,
      method: i % 3 ? 'GET' : 'POST',
      url: `https://app.test/api/items/${i % 20}`,
      status: i % 7 ? 200 : 500,
      startedAt: 1_000_000 + i * 50,
      endedAt: 1_000_000 + i * 50 + 30,
      responseHeaders: [{ name: 'x-request-id', value: `req-${i}-abcdef` }],
    }),
  );
  const connections: RealtimeConnection[] = Array.from({ length: nConnections }, (_, i) => ({
    id: `c${i}`,
    pageId: 'p',
    pageUrl: '',
    transport: 'websocket',
    url: `wss://app.test/ws${i % 5}`,
    state: i % 4 ? 'closed' : 'open',
    createdAt: 1_000_000 + i * 1000,
    openedAt: 1_000_000 + i * 1000 + 5,
    closeCode: i % 4 ? 1006 : undefined,
    warnings: [],
    source: 'main-world',
    sessionId: 's',
    tabId: 1,
    origin: 'https://app.test',
    protocol: 'raw',
    sources: ['main-world'],
    attempt: i % 3,
    inCount: 0,
    outCount: 0,
    bytesIn: 0,
    bytesOut: 0,
    redactions: 0,
  }));
  const messages: RealtimeMessage[] = Array.from({ length: nMessages }, (_, i) => ({
    id: `m${i}`,
    connectionId: `c${i % nConnections}`,
    direction: 'in',
    timestamp: 1_000_000 + i * 3,
    opcode: 'text',
    text: JSON.stringify({
      type: i % 10 ? 'tick' : 'order.created',
      i,
      requestId: `req-${i % nEntries}-abcdef`,
    }),
    source: 'main-world',
    sessionId: 's',
    tabId: 1,
    sources: ['main-world'],
    dedupKey: `k${i}`,
    redactions: 0,
    decoded: [
      {
        protocol: 'raw',
        category: 'app',
        kind: 'json',
        name: i % 10 ? 'tick' : 'order.created',
        args: [{ i }],
      },
    ],
  }));
  const timeline: TimelineEvent[] = Array.from({ length: 300 }, (_, i) => ({
    id: `t${i}`,
    pageId: 'p',
    pageUrl: 'https://app.test/',
    kind: i % 3 ? 'click' : 'console-error',
    timestamp: 1_000_000 + i * 200,
    message: `event ${i}`,
    sessionId: 's',
    tabId: 1,
    origin: 'https://app.test',
  }));
  return { entries, connections, messages, timeline };
}

describe('analysis scales to large sessions', () => {
  it('finds, links and lays out 2,000 requests and 20,000 messages within budget', () => {
    const s = session(2000, 60, 20_000);
    const t0 = performance.now();
    const input = { ...s, timeline: s.timeline, spans: [], slowRequestMs: 2000, now: 9e12 };
    const findings = [...detectIssues(input), ...investigatorFindings(input)].map(withEvidenceLevels);
    const t1 = performance.now();
    const data = {
      ...s,
      spans: [],
      findings,
      serverTracingConfigured: false,
      adaptersEnabled: false,
      advancedCapture: false,
    };
    const links = computeLinks(data);
    const t2 = performance.now();
    buildUnifiedTimeline({ ...s, spans: [] });
    const t3 = performance.now();
    buildInvestigation({ type: 'request', id: 'e0' }, data, links);
    const t4 = performance.now();
    const times = { findings: t1 - t0, links: t2 - t1, timeline: t3 - t2, investigation: t4 - t3 };
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)]))),
    );
    expect(times.findings).toBeLessThan(800);
    expect(times.links).toBeLessThan(500);
    expect(times.timeline).toBeLessThan(300);
    expect(times.investigation).toBeLessThan(150);
  });
});
