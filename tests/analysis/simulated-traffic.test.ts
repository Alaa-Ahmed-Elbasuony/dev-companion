// Simulated requests stay visible but never feed conclusions about the real
// backend: backend findings use only responses the server actually returned
// (never simulated timing), baselines, session comparison, server links and
// backend statistics use real traffic; findings about how the page reacted keep
// simulated requests and label them, as do investigations, comparisons and
// exports. Entries without the marker are real traffic.
import { describe, expect, it } from 'vitest';
import { inferShape } from '../../src/analysis/contracts';
import { detectIssues } from '../../src/analysis/error-detector';
import type { DetectorInput } from '../../src/analysis/error-detector';
import { buildInvestigation, computeLinks } from '../../src/analysis/investigation';
import type { InvestigationData } from '../../src/analysis/investigation';
import { investigatorFindings } from '../../src/analysis/investigator-rules';
import { buildPlaywrightDraft } from '../../src/analysis/playwright';
import { EMPTY_FILTER, filterEntries, isFailure } from '../../src/analysis/filter';
import type { RequestFilter } from '../../src/analysis/filter';
import { compareEntries } from '../../src/analysis/request-diff';
import {
  describeSimulated,
  forBackendAnalysis,
  isBackendFailure,
  isSimulated,
  isSimulatedFailure,
  reachedNetwork,
  realTraffic,
  responseOrigin,
  simulationLabel,
} from '../../src/analysis/simulated-traffic';
import { buildUnifiedTimeline, filterUnified } from '../../src/analysis/unified-timeline';
import { buildBugReportJson, buildBugReportMarkdown } from '../../src/io/bug-report';
import { buildHar, buildJsonExport } from '../../src/io/export';
import { parseImport } from '../../src/io/import';
import { DEFAULT_REDACTION, DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { SimulatedInfo } from '../../src/shared/simulation';
import type { ContractBaseline, EntryBodies, NetworkEntry, ServerSpan } from '../../src/shared/types';
import { endpointKey } from '../../src/shared/util';
import { entry, jsonBodies, timelineEvent } from '../helpers/entries';

const ORDERS = 'https://app.test/api/orders';
const sim = (o: Partial<SimulatedInfo> = {}): SimulatedInfo => ({
  ruleId: 'r1',
  ruleName: 'Orders fail',
  action: 'mock',
  delayMs: 0,
  sent: false,
  ...o,
});
const MOCK = sim();
const DELAY = sim({ ruleId: 'r2', ruleName: 'Slow orders', action: 'delay', delayMs: 6000, sent: true });
/** A delayed request the server answered: the lifecycle shows the delay, then a response. */
const answered = (o: Partial<NetworkEntry> = {}) => {
  const startedAt = o.startedAt ?? 2_000_000;
  return entry({
    url: ORDERS,
    status: 200,
    startedAt,
    responseAt: startedAt + 6050,
    endedAt: startedAt + 6100,
    duration: 6100,
    simulated: DELAY,
    ...o,
  });
};
const base: Omit<DetectorInput, 'entries'> = { timeline: [], slowRequestMs: 2000 };
const kinds = (findings: { kind: string }[]) => findings.map((f) => f.kind);

describe('simulated-traffic predicates', () => {
  it('treats a missing marker as real traffic (records from before simulation existed)', () => {
    const old = entry({ status: 500 });
    const undefinedMarker = entry({ simulated: undefined });
    expect(isSimulated(old)).toBe(false);
    expect(isSimulated(undefinedMarker)).toBe(false);
    expect(reachedNetwork(old)).toBe(true);
    const list = [old, undefinedMarker];
    // Nothing to remove: the same array and the same input object, so existing behavior is untouched.
    expect(realTraffic(list)).toBe(list);
    const input = { ...base, entries: list, baselineEntries: list };
    expect(forBackendAnalysis(input)).toBe(input);
  });

  it('removes simulated entries from the session and its baseline session, not from the original lists', () => {
    const real = entry();
    const mocked = entry({ simulated: MOCK });
    const entries = [real, mocked];
    const baselineEntries = [entry({ simulated: DELAY }), entry()];
    const out = forBackendAnalysis({ ...base, entries, baselineEntries });
    expect(out.entries).toEqual([real]);
    expect(out.baselineEntries).toEqual([baselineEntries[1]]);
    expect(entries).toHaveLength(2);
    expect(baselineEntries).toHaveLength(2);
  });

  it('knows whether the request reached the network', () => {
    expect(reachedNetwork(entry({ simulated: MOCK }))).toBe(false);
    expect(reachedNetwork(answered())).toBe(true);
    // `sent` is set when the delay rule decides: a request that ended during the delay never left.
    const cancelled = entry({
      state: 'aborted',
      status: undefined,
      startedAt: 0,
      endedAt: 300,
      simulated: DELAY,
    });
    expect(reachedNetwork(cancelled)).toBe(false);
    expect(describeSimulated(DELAY, cancelled)).toContain(
      'the request ended during the delay and was not sent',
    );
    expect(responseOrigin(DELAY, cancelled)).toBe('rule "Slow orders" (ended during the delay; never sent)');
    expect(describeSimulated(MOCK)).toBe(
      'Simulated by rule "Orders fail": mocked response; the request was not sent',
    );
    expect(describeSimulated(DELAY)).toContain('delayed 6000 ms, then sent to the network');
    // Released: the switch went off while held, so the real request went out unchanged.
    expect(describeSimulated(sim({ sent: true }))).toContain('sent to the network unchanged');
    expect(responseOrigin(undefined)).toBe('server');
    expect(responseOrigin(MOCK)).toBe('rule "Orders fail" (no server response)');
    expect(responseOrigin(DELAY)).toContain('server, with timing changed');
  });
});

describe('real backend analysis excludes simulated traffic', () => {
  it('simulated failures do not inflate backend error findings', () => {
    const real500 = entry({ id: 'real', url: ORDERS, status: 500 });
    const findings = detectIssues({
      ...base,
      entries: [
        real500,
        entry({ id: 'm1', url: ORDERS, status: 500, simulated: MOCK }),
        entry({ id: 'm2', url: ORDERS, status: 500, simulated: MOCK }),
        entry({
          id: 'neterr',
          url: `${ORDERS}/x`,
          state: 'error',
          status: undefined,
          simulated: sim({ action: 'network-error' }),
        }),
        entry({
          id: 'to',
          url: `${ORDERS}/y`,
          state: 'timeout',
          status: undefined,
          simulated: sim({ action: 'timeout' }),
        }),
      ],
    });
    const http = findings.filter((f) => f.kind === 'http-error');
    expect(http).toHaveLength(1);
    expect(http[0]!.entryIds).toEqual(['real']);
    expect(http[0]!.observed).toMatch(/^1 request\(s\) returned HTTP 500/);
    expect(kinds(findings)).not.toContain('network-failure');
  });

  it('simulated authentication failures and hanging requests are not reported as backend problems', () => {
    const now = 10_000_000;
    const simulatedOnly = investigatorFindings({
      ...base,
      now,
      entries: [
        entry({ url: ORDERS, status: 401, simulated: MOCK }),
        entry({
          url: `${ORDERS}/2`,
          state: 'pending',
          status: undefined,
          startedAt: 0,
          simulated: sim({ action: 'hang' }),
        }),
      ],
    });
    expect(simulatedOnly).toEqual([]);
    // The same requests without the marker are reported: the exclusion is what made the difference.
    const real = investigatorFindings({
      ...base,
      now,
      entries: [
        entry({ url: ORDERS, status: 401 }),
        entry({ url: `${ORDERS}/2`, state: 'pending', status: undefined, startedAt: 0 }),
      ],
    });
    expect(kinds(real)).toEqual(expect.arrayContaining(['auth', 'pending-forever']));
  });

  it('simulated latency does not produce slow-request conclusions', () => {
    const delayed = entry({
      id: 'delayed',
      url: ORDERS,
      duration: 7000,
      endedAt: undefined,
      simulated: DELAY,
    });
    expect(kinds(detectIssues({ ...base, entries: [delayed] }))).not.toContain('slow');
    const realSlow = entry({ id: 'slow', url: ORDERS, duration: 7000 });
    const slow = detectIssues({ ...base, entries: [realSlow, delayed] }).filter((f) => f.kind === 'slow');
    expect(slow).toHaveLength(1);
    expect(slow[0]!.entryIds).toEqual(['slow']);
  });

  it('simulated responses are not checked against, or counted as, the real API contract', () => {
    const key = endpointKey('GET', ORDERS);
    const contract: ContractBaseline = {
      endpointKey: key,
      kind: 'inferred',
      schema: inferShape({ id: 1, total: 5 }),
      createdAt: 0,
    };
    const mocked = entry({ id: 'mocked', url: ORDERS, status: 200, simulated: MOCK });
    const bodies = new Map([['mocked', jsonBodies('mocked', { mocked: true })]]);
    const input = { ...base, contracts: [contract], bodies };
    expect(kinds(detectIssues({ ...input, entries: [mocked] }))).not.toContain('contract');
    // Control: the same response captured from the server is a contract difference.
    const unmarked = { ...mocked, simulated: undefined };
    expect(kinds(detectIssues({ ...input, entries: [unmarked] }))).toContain('contract');
  });

  it('simulated requests do not affect the previous-session baseline or the comparison with it', () => {
    const prevReal = entry({ id: 'prev', url: ORDERS, status: 200, startedAt: 100 });
    const prevSimulated = entry({
      id: 'prev-sim',
      url: ORDERS,
      status: 500,
      startedAt: 200,
      simulated: MOCK,
    });
    const current = entry({ id: 'cur', url: ORDERS, status: 200, startedAt: 300 });
    const bodies = new Map<string, EntryBodies>([
      ['prev', jsonBodies('prev', { id: 1 })],
      ['cur', jsonBodies('cur', { id: 1 })],
    ]);
    const session = (entries: NetworkEntry[], baselineEntries: NetworkEntry[]) =>
      kinds(detectIssues({ ...base, entries, baselineEntries, bodies, baselineBodies: bodies }));
    // The latest previous request was simulated: the real one is the baseline.
    expect(session([current], [prevReal, prevSimulated])).not.toContain('session-diff');
    // A simulated failure in this session is not a change since the previous session.
    const curSimulated = entry({ id: 'cur-sim', url: ORDERS, status: 500, startedAt: 400, simulated: MOCK });
    expect(session([current, curSimulated], [prevReal])).not.toContain('session-diff');
    // Control: without the marker the same data is reported as a change.
    expect(session([current], [prevReal, { ...prevSimulated, simulated: undefined }])).toContain(
      'session-diff',
    );
  });

  it('real requests keep exactly their existing findings when unrelated simulated traffic is added', () => {
    const real = [
      entry({ id: 'r500', url: ORDERS, status: 500 }),
      entry({ id: 'rslow', url: `${ORDERS}/slow`, duration: 9000 }),
      entry({ id: 'r401', url: `${ORDERS}/me`, status: 401 }),
      entry({ id: 'rerr', url: `${ORDERS}/x`, state: 'error', status: undefined }),
    ];
    const timeline = [timelineEvent({ kind: 'console-error', timestamp: real[0]!.endedAt! + 100 })];
    // Later in the session, so no page-behavior finding links them to the real requests.
    const later = 9_000_000;
    const simulated = [
      entry({ url: ORDERS, status: 503, startedAt: later, simulated: MOCK }),
      answered({ url: `${ORDERS}/slow`, startedAt: later + 10_000 }),
      entry({ url: `${ORDERS}/me`, status: 403, startedAt: later + 20_000, simulated: MOCK }),
      entry({
        startedAt: later + 30_000,
        url: `${ORDERS}/other`,
        state: 'timeout',
        status: undefined,
        simulated: sim({ action: 'timeout' }),
      }),
    ];
    const input = (entries: NetworkEntry[]) => ({ ...base, timeline, entries, now: 2_000_000 });
    expect(detectIssues(input([...real, ...simulated]))).toEqual(detectIssues(input(real)));
    expect(investigatorFindings(input([...real, ...simulated]))).toEqual(investigatorFindings(input(real)));
    expect(detectIssues(input(real)).length).toBeGreaterThan(3);
  });
});

describe('investigations keep simulated requests and label them', () => {
  const data = (o: Partial<InvestigationData>): InvestigationData => ({
    entries: [],
    timeline: [],
    connections: [],
    messages: [],
    spans: [],
    findings: [],
    serverTracingConfigured: true,
    adaptersEnabled: false,
    advancedCapture: false,
    ...o,
  });

  it('distinguishes real and simulated requests in a mixed investigation', () => {
    const realFail = entry({ id: 'real', url: ORDERS, status: 500, startedAt: 5000, endedAt: 5100 });
    const simFail = entry({
      id: 'sim',
      url: `${ORDERS}/2`,
      status: 500,
      startedAt: 5200,
      endedAt: 5300,
      simulated: MOCK,
    });
    const error = timelineEvent({ id: 'err', kind: 'console-error', timestamp: 5400, message: 'boom' });
    const d = data({ entries: [realFail, simFail], timeline: [error] });
    d.findings = detectIssues({ ...base, entries: d.entries, timeline: d.timeline });
    const inv = buildInvestigation({ type: 'timeline', id: 'err' }, d)!;
    const byId = new Map(inv.related.map((r) => [r.ref.id, r]));
    expect(byId.get('real')!.title).toBe('GET /api/orders → 500');
    expect(byId.get('real')!.simulated).toBeUndefined();
    expect(byId.get('sim')!.title).toBe('GET /api/orders/2 → 500 (simulated)');
    expect(byId.get('sim')!.simulated).toEqual(MOCK);
    expect(inv.whatHappened).toContain('1 related request(s) were simulated');
    // Backend findings cover the real failure only.
    const backend = inv.findings.filter((f) => f.basis === 'backend');
    expect(backend.map((f) => [f.kind, f.entryIds])).toEqual([['http-error', ['real']]]);
    expect(backend.every((f) => !f.simulation)).toBe(true);
    // The page's reaction (a console error after both failures) is kept and says which one was simulated.
    const page = inv.findings.find((f) => f.kind === 'console-near-failure')!;
    expect(page.basis).toBe('frontend');
    expect(page.entryIds.sort()).toEqual(['real', 'sim']);
    expect(page.simulation).toEqual({
      entryIds: ['sim'],
      ruleNames: ['Orders fail'],
      outcomeFromServer: false,
    });
    expect(page.title).toBe('Console error after failed request · simulated by rule "Orders fail"');
    // Causes carry the basis of their finding.
    const causeBases = new Set(inv.causes.map((c) => `${c.basis}:${c.simulated ?? false}`));
    expect(causeBases).toEqual(new Set(['backend:false', 'frontend:true']));
  });

  it('a simulated anchor says where its outcome came from and asks for no server evidence', () => {
    const post = entry({
      id: 'post',
      method: 'POST',
      url: ORDERS,
      status: 500,
      startedAt: 9000,
      simulated: MOCK,
    });
    const d = data({ entries: [post] });
    const inv = buildInvestigation({ type: 'request', id: 'post' }, d)!;
    expect(inv.title).toContain('(simulated)');
    expect(inv.whatHappened).toContain(describeSimulated(MOCK));
    expect(inv.divergence!.why).toContain('the failure did not come from the server');
    expect(inv.missingEvidence.join('\n')).not.toContain('No server span is linked');
    expect(inv.reproduction.join('\n')).toContain(
      'SIMULATED by rule "Orders fail": not sent, the server never received it',
    );
    expect(inv.reproduction.join('\n')).not.toContain('MUTATION');

    // The same request from the server still asks for its server span.
    const real = buildInvestigation(
      { type: 'request', id: 'post' },
      data({ entries: [{ ...post, simulated: undefined }] }),
    )!;
    expect(real.missingEvidence.join('\n')).toContain('No server span is linked');
    expect(real.reproduction.join('\n')).toContain('MUTATION: creates or changes server data)');
    expect(real.whatHappened).not.toContain('Simulated');
  });

  it('never links a request that was not sent to server spans; a delayed, sent one keeps its link', () => {
    const TRACE = 'a'.repeat(32);
    const traceparent = [{ name: 'traceparent', value: `00-${TRACE}-${'b'.repeat(16)}-01` }];
    const span: ServerSpan = {
      id: `${TRACE}:span`,
      traceId: TRACE,
      spanId: 'c'.repeat(16),
      name: 'GET /api/orders',
      kind: 'server',
      startTime: 1000,
      endTime: 1200,
      status: 'unset',
      outbound: false,
      attributes: {},
      events: [],
      source: 'next-adapter',
      sessionId: 's-1',
      origin: 'https://app.test',
      redactions: 0,
    };
    const toTrace = (entries: NetworkEntry[]) =>
      computeLinks(data({ entries, spans: [span] }))
        .filter((l) => l.to.type === 'trace')
        .map((l) => l.from.id);
    expect(toTrace([entry({ id: 'mocked', requestHeaders: traceparent, simulated: MOCK })])).toEqual([]);
    expect(toTrace([answered({ id: 'delayed', requestHeaders: traceparent })])).toEqual(['delayed']);
    expect(toTrace([entry({ id: 'real', requestHeaders: traceparent })])).toEqual(['real']);
  });
});

describe('explicit comparisons', () => {
  it('can still compare a simulated request with a real one, and says which is which', () => {
    const real = entry({ id: 'a', url: ORDERS, status: 200 });
    const mocked = entry({ id: 'b', url: ORDERS, status: 500, simulated: MOCK });
    const c = compareEntries(real, jsonBodies('a', { id: 1 }), mocked, jsonBodies('b', { error: 'x' }));
    expect(c.simulated).toEqual({ a: undefined, b: MOCK, mixed: true });
    expect(c.status).toEqual({ a: 200, b: 500, same: false });
    expect(c.responseBody.mode).toBe('json');
    const bothReal = compareEntries(real, undefined, { ...mocked, simulated: undefined }, undefined);
    expect(bothReal.simulated).toEqual({ a: undefined, b: undefined, mixed: false });
    expect(compareEntries(mocked, undefined, mocked, undefined).simulated.mixed).toBe(false);
  });
});

describe('generated tests', () => {
  it('a Playwright draft marks a recorded outcome that a rule produced', () => {
    const target = entry({ url: ORDERS, status: 500, startedAt: 5000, simulated: MOCK });
    const draft = buildPlaywrightDraft({ target, timeline: [], entries: [target], until: 6000 });
    expect(draft).toContain(
      `// SIMULATED: ${describeSimulated(MOCK)}. The recorded outcome is not the server's.`,
    );
    const real = buildPlaywrightDraft({
      target: { ...target, simulated: undefined },
      timeline: [],
      entries: [],
      until: 6000,
    });
    expect(real).not.toContain('SIMULATED');
  });
});

describe('exports keep simulation identity', () => {
  const real = entry({ id: 'real', url: ORDERS, status: 200 });
  const mocked = entry({ id: 'mocked', url: `${ORDERS}/1`, status: 500, simulated: MOCK });
  const delayed = answered({ id: 'delayed', url: `${ORDERS}/2` });
  const bodies = new Map<string, EntryBodies>([
    ['real', jsonBodies('real', { id: 1 })],
    ['mocked', jsonBodies('mocked', { error: 'mocked' })],
  ]);

  it('HAR: standard comment plus a custom field; the recorded response itself is kept', () => {
    const har = buildHar([real, mocked, delayed], bodies, DEFAULT_REDACTION, '1.0.0');
    const [r, m, dl] = har.log.entries;
    expect(m!.response.status).toBe(500);
    expect(m!.response.content.text).toBe('{"error":"mocked"}');
    expect(m!.response.comment).toBe(
      `${describeSimulated(MOCK)}. Synthetic: produced by Dev Companion, not returned by a server.`,
    );
    expect(m!._devCompanion.simulated).toEqual(MOCK);
    expect(dl!.response.comment).toContain('Server response; timings include time added by the rule.');
    expect(dl!._devCompanion.simulated).toEqual(DELAY);
    // Real entries are exported exactly as before.
    expect('comment' in r!.response).toBe(false);
    expect(JSON.parse(JSON.stringify(r!._devCompanion))).not.toHaveProperty('simulated');
  });

  it('HAR and JSON exports import back with the marker; a forged marker is dropped', () => {
    const har = buildHar([real, mocked], bodies, DEFAULT_REDACTION, '1.0.0');
    const fromHar = parseImport(JSON.stringify(har), 'a.har', DEFAULT_SETTINGS).entries;
    expect(fromHar.map((e) => e.entry.simulated)).toEqual([undefined, MOCK]);

    const bundle = buildJsonExport([], [real, mocked], bodies, [], DEFAULT_REDACTION);
    expect(bundle.entries[1]!.simulated).toEqual(MOCK);
    const fromJson = parseImport(JSON.stringify(bundle), 'a.json', DEFAULT_SETTINGS).entries;
    expect(fromJson.map((e) => e.entry.simulated)).toEqual([undefined, MOCK]);

    const forged = JSON.parse(JSON.stringify(har));
    forged.log.entries[1]._devCompanion.simulated = { ruleId: 7, action: 'explode' };
    expect(
      parseImport(JSON.stringify(forged), 'b.har', DEFAULT_SETTINGS).entries[1]!.entry.simulated,
    ).toBeUndefined();
  });

  it('bug reports list simulated requests separately and mark them in the request details', () => {
    const error = timelineEvent({ id: 'err', kind: 'console-error', timestamp: mocked.endedAt! + 100 });
    const d: InvestigationData = {
      entries: [real, mocked],
      timeline: [error],
      connections: [],
      messages: [],
      spans: [],
      findings: [],
      serverTracingConfigured: false,
      adaptersEnabled: false,
      advancedCapture: false,
    };
    const input = {
      investigation: buildInvestigation({ type: 'request', id: 'mocked' }, d)!,
      title: 'Orders page crashes',
      environment: {
        extensionVersion: '1.0.0',
        userAgent: 'test',
        origin: 'https://app.test',
        serverTracing: 'none',
        capturedAt: 0,
      },
      entries: d.entries,
      bodies,
      timeline: d.timeline,
      redaction: DEFAULT_REDACTION,
    };
    const md = buildBugReportMarkdown(input);
    expect(md).toContain('## Simulated requests');
    expect(md).toContain(`- GET /api/orders/1 → 500 (simulated): ${describeSimulated(MOCK)}`);
    expect(md).toContain('do not report them as backend behavior');
    expect(md).toMatch(/### GET \/api\/orders\/1 → 500\n\n[^#]*- Simulated by rule "Orders fail"/);

    const json = JSON.parse(buildBugReportJson(input));
    expect(json.simulatedRequests).toEqual([{ id: 'mocked', description: describeSimulated(MOCK) }]);
    expect(json.related.find((r: { ref: { id: string } }) => r.ref.id === 'mocked').simulated).toEqual(MOCK);

    // A report without simulated requests has no simulation section.
    const realOnly = buildBugReportMarkdown({
      ...input,
      investigation: buildInvestigation({ type: 'request', id: 'real' }, { ...d, entries: [real] })!,
    });
    expect(realOnly).not.toContain('Simulated');
    expect(
      JSON.parse(
        buildBugReportJson({
          ...input,
          investigation: buildInvestigation({ type: 'request', id: 'real' }, { ...d, entries: [real] })!,
        }),
      ).simulatedRequests,
    ).toEqual([]);
  });
});

describe('backend findings versus findings about the page', () => {
  const at = 3_000_000;
  const consoleError = (timestamp: number, message = 'Could not load orders') =>
    timelineEvent({ id: `err-${timestamp}`, kind: 'console-error', timestamp, message });

  it('a simulated 500 is no backend failure, but the console error it caused is kept and labeled', () => {
    const mocked = entry({
      id: 'mocked',
      url: ORDERS,
      status: 500,
      startedAt: at,
      endedAt: at + 50,
      simulated: MOCK,
    });
    const timeline = [consoleError(at + 200)];
    const findings = detectIssues({ ...base, entries: [mocked], timeline });
    expect(kinds(findings)).toEqual(['console-near-failure']);
    expect(findings[0]).toMatchObject({
      basis: 'frontend',
      entryIds: ['mocked'],
      simulation: { entryIds: ['mocked'], ruleNames: ['Orders fail'], outcomeFromServer: false },
    });
    expect(findings[0]!.title).toBe('Console error after failed request · simulated by rule "Orders fail"');
    expect(findings[0]!.limitations[0]).toContain('not a backend failure');

    // Control: the same failure from the server is also a backend finding, and nothing is labeled.
    const real = detectIssues({ ...base, entries: [{ ...mocked, simulated: undefined }], timeline });
    expect(kinds(real).sort()).toEqual(['console-near-failure', 'http-error']);
    expect(real.find((f) => f.kind === 'console-near-failure')!.title).toBe(
      'Console error after failed request',
    );
    expect(real.every((f) => !f.simulation)).toBe(true);
  });

  it('a mocked error body the page used as data is kept as a labeled page-behavior finding', () => {
    const mocked = entry({
      id: 'mocked',
      url: ORDERS,
      status: 500,
      startedAt: at,
      endedAt: at + 50,
      responseBodyKind: 'json',
      simulated: MOCK,
    });
    const input = {
      ...base,
      entries: [mocked],
      bodies: new Map([['mocked', jsonBodies('mocked', { error: 'boom' })]]),
      timeline: [
        timelineEvent({
          kind: 'js-error',
          timestamp: at + 100,
          message: "TypeError: Cannot read properties of undefined (reading 'items')",
        }),
      ],
      now: at + 1000,
    };
    const mapping = investigatorFindings(input).filter((f) => f.kind === 'response-mapping');
    expect(mapping).toHaveLength(1);
    expect(mapping[0]).toMatchObject({
      basis: 'frontend',
      entryIds: ['mocked'],
      simulation: { outcomeFromServer: false },
    });
    expect(mapping[0]!.title).toBe(
      '"items" accessed on undefined shortly after GET /api/orders returned 500 · simulated by rule "Orders fail"',
    );
    expect(kinds(detectIssues(input))).not.toContain('http-error');

    // Control: from a real response the finding is the same, unlabeled.
    const real = investigatorFindings({ ...input, entries: [{ ...mocked, simulated: undefined }] }).filter(
      (f) => f.kind === 'response-mapping',
    );
    expect(real).toHaveLength(1);
    expect(real[0]!.title).toBe('"items" accessed on undefined shortly after GET /api/orders returned 500');
    expect(real[0]!.simulation).toBeUndefined();
  });

  it('a simulated hang is not a backend failure', () => {
    const hung = entry({
      url: ORDERS,
      state: 'pending',
      status: undefined,
      startedAt: 0,
      endedAt: undefined,
      duration: undefined,
      simulated: sim({ action: 'hang' }),
    });
    const input = { ...base, entries: [hung], now: 10_000_000 };
    expect([...detectIssues(input), ...investigatorFindings(input)]).toEqual([]);
    // Control: a real request that never finished is reported.
    expect(kinds(investigatorFindings({ ...input, entries: [{ ...hung, simulated: undefined }] }))).toEqual([
      'pending-forever',
    ]);
  });

  it('an artificial delay is not backend latency', () => {
    const delayed = answered({ startedAt: at });
    expect(detectIssues({ ...base, entries: [delayed] })).toEqual([]);
    // Control: the same duration from the server is a slow request.
    expect(kinds(detectIssues({ ...base, entries: [{ ...delayed, simulated: undefined }] }))).toEqual([
      'slow',
    ]);
  });

  it('a 500 the server returned to a delayed request is a backend finding, labeled as delayed', () => {
    const delayed = answered({ id: 'delayed', status: 500, startedAt: at });
    const findings = detectIssues({ ...base, entries: [delayed] });
    expect(kinds(findings)).toEqual(['http-error']);
    expect(findings[0]).toMatchObject({
      basis: 'backend',
      entryIds: ['delayed'],
      simulation: { ruleNames: ['Slow orders'], outcomeFromServer: true },
    });
    expect(findings[0]!.title).toBe(`500 from ${endpointKey('GET', ORDERS)} · delayed by rule "Slow orders"`);
    expect(findings[0]!.limitations[0]).toContain('The response came from the server');
    // `sent` alone is no evidence: without a recorded response there is no backend finding.
    expect(detectIssues({ ...base, entries: [{ ...delayed, responseAt: undefined }] })).toEqual([]);
  });

  it('a client timeout caused by an artificial delay is not a backend timeout', () => {
    const timedOut = (o: Partial<NetworkEntry>) =>
      entry({ state: 'timeout', status: undefined, errorName: 'TimeoutError', simulated: DELAY, ...o });
    // During the delay: never sent. After it, while the real request was in flight: no response.
    const during = timedOut({ id: 'during', url: ORDERS, startedAt: at, endedAt: at + 300, duration: 300 });
    const after = timedOut({
      id: 'after',
      url: `${ORDERS}/2`,
      startedAt: at,
      endedAt: at + 6500,
      duration: 6500,
    });
    const input = { ...base, entries: [during, after], timeline: [consoleError(at + 6600, 'Timed out')] };
    const findings = [...detectIssues(input), ...investigatorFindings({ ...input, now: at + 100_000 })];
    // Only the page's reaction remains, as a simulated outcome.
    expect(kinds(findings)).toEqual(['console-near-failure']);
    expect(findings[0]).toMatchObject({ entryIds: ['after'], simulation: { outcomeFromServer: false } });
    expect(reachedNetwork(during)).toBe(false);
    expect(reachedNetwork(after)).toBe(true);
    expect(responseOrigin(DELAY, after)).toBe(
      'no response: sent after rule "Slow orders" delayed it, then ended without one',
    );
    // Control: a real timeout is reported as one.
    const real = detectIssues({ ...base, entries: [{ ...after, simulated: undefined }] });
    expect(real.map((f) => f.title)).toContain(`Timeout: ${endpointKey('GET', `${ORDERS}/2`)}`);
  });

  it('names only the rules that produced an outcome when a finding also involves an answered delay', () => {
    const mocked = entry({
      id: 'm',
      url: ORDERS,
      status: 500,
      startedAt: at,
      endedAt: at + 50,
      simulated: MOCK,
    });
    const delayed = answered({ id: 'd', url: `${ORDERS}/2`, status: 500, startedAt: at - 6000 });
    const findings = detectIssues({
      ...base,
      entries: [mocked, delayed],
      timeline: [consoleError(at + 200)],
    });
    const page = findings.find((f) => f.kind === 'console-near-failure')!;
    expect(page.title).toBe('Console error after failed request · simulated by rule "Orders fail"');
    expect(page.simulation).toEqual({
      entryIds: ['m', 'd'],
      ruleNames: ['Orders fail', 'Slow orders'],
      outcomeFromServer: false,
    });
    expect(page.limitations[0]).toMatch(
      /^The outcome of a request here was produced by simulation rule "Orders fail"/,
    );
    // The delayed request's real 500 is still a backend finding of its own.
    expect(findings.find((f) => f.kind === 'http-error')!.entryIds).toEqual(['d']);
  });

  it('labels a bug report cause that comes from a page-behavior finding about simulated traffic', () => {
    const mocked = entry({
      id: 'm',
      url: ORDERS,
      status: 500,
      startedAt: at,
      endedAt: at + 50,
      simulated: MOCK,
    });
    const error = consoleError(at + 200);
    const d: InvestigationData = {
      entries: [mocked],
      timeline: [error],
      connections: [],
      messages: [],
      spans: [],
      findings: detectIssues({ ...base, entries: [mocked], timeline: [error] }),
      serverTracingConfigured: false,
      adaptersEnabled: false,
      advancedCapture: false,
    };
    const input = {
      investigation: buildInvestigation({ type: 'timeline', id: error.id }, d)!,
      title: 'Orders page',
      environment: {
        extensionVersion: '1',
        userAgent: 't',
        origin: 'https://app.test',
        serverTracing: 'none',
        capturedAt: 0,
      },
      entries: d.entries,
      bodies: new Map<string, EntryBodies>(),
      timeline: d.timeline,
      redaction: DEFAULT_REDACTION,
    };
    expect(buildBugReportMarkdown(input)).toContain(
      '_(from a finding about the page reacting to simulated traffic)_',
    );
    const causes = JSON.parse(buildBugReportJson(input)).causes as { basis: string; simulated: boolean }[];
    expect(causes.length).toBeGreaterThan(0);
    expect(causes.every((c) => c.basis === 'frontend' && c.simulated === true)).toBe(true);
  });
});

describe('labels, timeline, filter and counts', () => {
  const at = 4_000_000;
  const mocked = entry({ id: 'mocked', url: ORDERS, status: 500, startedAt: at, simulated: MOCK });
  // Timed out during the delay: never sent.
  const unsent = entry({
    id: 'unsent',
    url: `${ORDERS}/2`,
    state: 'timeout',
    status: undefined,
    startedAt: at,
    endedAt: at + 300,
    duration: 300,
    simulated: DELAY,
  });
  const answered500 = answered({ id: 'answered', url: `${ORDERS}/3`, status: 500, startedAt: at });
  const real500 = entry({ id: 'real', url: `${ORDERS}/4`, status: 500, startedAt: at });
  const real200 = entry({ id: 'ok', url: `${ORDERS}/5`, status: 200, startedAt: at });
  const all = [mocked, unsent, answered500, real500, real200];

  it('labels a delayed request as server-answered only when its response is confirmed', () => {
    expect(all.map((e) => simulationLabel(e))).toEqual([
      'simulated',
      'simulated',
      'delayed by simulation',
      undefined,
      undefined,
    ]);
    // Still waiting for the delay or the response: not (yet) the server's.
    const inFlight = entry({ state: 'pending', status: undefined, endedAt: undefined, simulated: DELAY });
    expect(simulationLabel(inFlight)).toBe('simulated');
  });

  it('marks timeline requests the same way, and finds them by their label', () => {
    const items = buildUnifiedTimeline({
      entries: all,
      timeline: [],
      connections: [],
      messages: [],
      spans: [],
    });
    const byId = new Map(items.map((i) => [i.ref.id, i]));
    expect(byId.get('mocked')!.simulation).toEqual({
      label: 'simulated',
      description: describeSimulated(MOCK, mocked),
    });
    expect(byId.get('unsent')!.simulation!.description).toContain('ended during the delay and was not sent');
    expect(byId.get('answered')!.simulation!.label).toBe('delayed by simulation');
    expect(byId.get('real')!.simulation).toBeUndefined();
    // Titles are unchanged; the label is separate.
    expect(byId.get('mocked')!.title).toBe('GET /api/orders → 500');
    expect(filterUnified(items, { text: 'delayed by simulation' }).map((i) => i.ref.id)).toEqual([
      'answered',
    ]);
    expect(
      filterUnified(items, { text: 'simulated' })
        .map((i) => i.ref.id)
        .sort(),
    ).toEqual(['answered', 'mocked', 'unsent']);
  });

  it('the simulated-only filter composes with search, status, method, source and duration', () => {
    const f = (o: Partial<RequestFilter>) =>
      filterEntries(all, { ...EMPTY_FILTER, simulated: true, ...o }).map((e) => e.id);
    expect(f({})).toEqual(['mocked', 'unsent', 'answered']);
    expect(f({ status: 'server-error' })).toEqual(['mocked', 'answered']);
    expect(f({ status: 'failed' })).toEqual(['unsent']);
    expect(f({ text: '/api/orders/3' })).toEqual(['answered']);
    expect(f({ methods: ['POST'] })).toEqual([]);
    expect(f({ sources: ['xhr'] })).toEqual([]);
    expect(f({ minDurationMs: 1000 })).toEqual(['answered']);
    expect(f({ codes: '500' })).toEqual(['mocked', 'answered']);
    // Off (the default): every request, as before.
    expect(filterEntries(all, EMPTY_FILTER)).toHaveLength(5);
  });

  it("counts a failure as the backend's only when the server returned it", () => {
    expect(all.filter(isBackendFailure).map((e) => e.id)).toEqual(['answered', 'real']);
    expect(all.filter(isSimulatedFailure).map((e) => e.id)).toEqual(['mocked', 'unsent']);
    // Real traffic is counted exactly as before.
    const realOnly = [real500, real200, entry({ state: 'error', status: undefined })];
    expect(realOnly.filter(isBackendFailure)).toEqual(realOnly.filter(isFailure));
  });
});
