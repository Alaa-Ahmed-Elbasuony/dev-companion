// @vitest-environment jsdom
// Simulated requests in the dashboard: listed and labeled like any request,
// never a baseline, not counted in backend statistics, and named as simulated
// when compared with real traffic.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectIssues } from '../../src/analysis/error-detector';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { SimulatedInfo } from '../../src/shared/simulation';
import type { EntryBodies, NetworkEntry } from '../../src/shared/types';
import type { ViewProps } from '../../src/ui/dashboard/context';
import { InvestigationsView } from '../../src/ui/dashboard/InvestigationsView';
import { NetworkView } from '../../src/ui/dashboard/NetworkView';
import { OverviewView } from '../../src/ui/dashboard/OverviewView';
import { RequestDetails } from '../../src/ui/dashboard/RequestDetails';
import type { Analysis } from '../../src/ui/lib/analysis';
import type * as Extension from '../../src/ui/lib/extension';
import type { SessionData } from '../../src/ui/lib/session-data';
import { installDomStubs } from '../helpers/dom';
import { entry, jsonBodies, timelineEvent } from '../helpers/entries';

const entries = new Map<string, NetworkEntry>();
const bodies = new Map<string, EntryBodies>();
const store = {
  getEntry: vi.fn(async (id: string) => entries.get(id)),
  getBodies: vi.fn(async (id: string) => bodies.get(id)),
  searchBodies: vi.fn(async () => new Set<string>()),
};
vi.mock('../../src/ui/lib/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof Extension>()),
  getStore: async () => store,
  notifyDataChanged: () => undefined,
}));

const MOCK: SimulatedInfo = {
  ruleId: 'r1',
  ruleName: 'Orders fail',
  action: 'mock',
  delayMs: 0,
  sent: false,
};
const DELAY: SimulatedInfo = { ruleId: 'r2', ruleName: 'Slow', action: 'delay', delayMs: 2000, sent: true };
/** A delayed request whose 500 the server returned (a response was recorded after the delay). */
const delayed500 = () =>
  entry({
    id: 'delayed',
    url: 'https://app.test/api/orders/3',
    status: 500,
    startedAt: 5000,
    responseAt: 7100,
    endedAt: 7200,
    duration: 2200,
    simulated: DELAY,
  });

function sessionData(): SessionData {
  return {
    sessions: [],
    sessionId: 's-1',
    session: undefined,
    entries: [...entries.values()],
    timeline: [],
    contracts: [],
    connections: [],
    spans: [],
    investigations: [],
    usage: { entryCount: entries.size, totalBytes: 0 },
    messageCount: 0,
    recording: null,
    storageStatus: null,
    traceStatus: {},
    loading: false,
    error: null,
  };
}

function viewProps(params: Record<string, string> = {}): ViewProps {
  return {
    data: sessionData(),
    settings: DEFAULT_SETTINGS,
    analysis: null,
    params,
    setParams: vi.fn(),
    navigate: vi.fn(),
    investigate: vi.fn(),
    openEntry: vi.fn(),
    reload: vi.fn(),
    onCompare: vi.fn(),
    onReplay: vi.fn(),
    onPlayground: vi.fn(),
    version: 0,
    setSession: vi.fn(),
  };
}

function details(e: NetworkEntry) {
  return render(
    <RequestDetails
      entry={e}
      data={sessionData()}
      analysis={null}
      onClose={vi.fn()}
      onCompare={vi.fn()}
      onReplay={vi.fn()}
      onPlayground={vi.fn()}
      onChanged={vi.fn()}
      onInvestigate={vi.fn()}
      onOpenRef={vi.fn()}
    />,
  );
}

const tile = (label: string) => {
  const el = [...document.querySelectorAll('.metric')].find(
    (m) => m.querySelector('.metric-label')?.textContent === label,
  )!;
  return {
    value: el.querySelector('.metric-value')?.textContent,
    hint: el.querySelector('.metric-hint')?.textContent,
  };
};

beforeEach(() => {
  installDomStubs();
  entries.clear();
  bodies.clear();
  entries.set('real', entry({ id: 'real', url: 'https://app.test/api/orders', status: 500 }));
  entries.set(
    'mocked',
    entry({ id: 'mocked', url: 'https://app.test/api/orders/1', status: 500, simulated: MOCK }),
  );
  entries.set('ok', entry({ id: 'ok', url: 'https://app.test/api/orders/2', status: 200 }));
  bodies.set('mocked', jsonBodies('mocked', { error: 'mocked' }));
  bodies.set('ok', jsonBodies('ok', { id: 2 }));
});
afterEach(cleanup);

describe('request list', () => {
  it('lists simulated requests with real ones and labels them', () => {
    render(<NetworkView {...viewProps()} />);
    const rows = [...document.querySelectorAll<HTMLElement>('.request-list [role="row"]')];
    expect(rows).toHaveLength(3);
    const tagged = rows.filter((r) => r.querySelector('.tag')?.textContent === 'simulated');
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.querySelector('.url-path')!.textContent).toBe('/api/orders/1');
    expect(tagged[0]!.querySelector('.tag')!.getAttribute('title')).toBe(
      'Simulated by rule "Orders fail": mocked response; the request was not sent',
    );
  });

  it('the failed filter still shows simulated failures', () => {
    render(<NetworkView {...viewProps({ problems: '1' })} />);
    const paths = [...document.querySelectorAll('.request-list .url-path')].map((p) => p.textContent);
    expect(paths.sort()).toEqual(['/api/orders', '/api/orders/1']);
  });
});

describe('request list: simulated-only filter', () => {
  function Harness({ initial }: { initial: Record<string, string> }) {
    const [params, setParams] = useState(initial);
    return <NetworkView {...viewProps(params)} setParams={setParams} />;
  }
  const paths = () => [...document.querySelectorAll('.request-list .url-path')].map((p) => p.textContent);
  const preset = () => screen.queryByRole('button', { name: 'Simulated', pressed: false });

  it('is offered only in sessions with simulated requests', () => {
    entries.delete('mocked');
    render(<Harness initial={{}} />);
    expect(screen.queryByRole('button', { name: 'Simulated' })).toBeNull();
    expect(paths()).toHaveLength(2);
  });

  it('shows simulated requests only, tagged consistently, with a removable chip', () => {
    entries.set('delayed', delayed500());
    render(<Harness initial={{}} />);
    expect(paths()).toHaveLength(4);
    fireEvent.click(preset()!);
    expect(paths().sort()).toEqual(['/api/orders/1', '/api/orders/3']);
    const tags = [...document.querySelectorAll('.request-list [role="row"] .tag')].map((t) => t.textContent);
    expect(tags.sort()).toEqual(['delayed by simulation', 'simulated']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter simulated only' }));
    expect(paths()).toHaveLength(4);
  });

  it('composes with search and status filters, with a clear empty state', () => {
    entries.set('delayed', delayed500());
    render(<Harness initial={{ sim: '1', q: 'orders/3' }} />);
    expect(paths()).toEqual(['/api/orders/3']);
    cleanup();
    render(<Harness initial={{ sim: '1', status: 'success' }} />);
    expect(screen.getByText('No simulated requests match the current filters.')).toBeTruthy();
    cleanup();
    entries.delete('mocked');
    entries.delete('delayed');
    render(<Harness initial={{ sim: '1' }} />);
    expect(screen.getByText('This session has no simulated requests.')).toBeTruthy();
    // The preset stays visible while the filter is on, so it can be switched off.
    expect(screen.getByRole('button', { name: 'Simulated', pressed: true })).toBeTruthy();
  });
});

describe('request details', () => {
  it('says which rule produced the request, that it was not sent, and refuses it as a baseline', async () => {
    details(entries.get('mocked')!);
    expect(
      screen.getByText('Simulated by rule "Orders fail": mocked response; the request was not sent.'),
    ).toBeTruthy();
    expect(screen.getByText(/Outcome from: rule "Orders fail" \(no server response\)/)).toBeTruthy();
    // A 5xx is never a baseline; a simulated 2xx JSON response, loaded, is refused too.
    cleanup();
    const mocked200 = { ...entries.get('mocked')!, status: 200 };
    store.getBodies.mockClear();
    details(mocked200);
    await waitFor(() => expect(store.getBodies).toHaveBeenCalledWith('mocked'));
    // Let the loaded body reach the component's state.
    await act(async () => {
      await store.getBodies.mock.results[0]!.value;
    });
    const button = screen.getByRole('button', { name: 'Save as baseline' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('A simulated request cannot be a baseline of the real API');
  });

  it('a real 2xx JSON response can still become a baseline', async () => {
    details(entries.get('ok')!);
    const button = screen.getByRole('button', { name: 'Save as baseline' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.queryByText(/Simulated by rule/)).toBeNull();
  });
});

describe('overview statistics', () => {
  it('counts real failures only and reports simulated ones separately', () => {
    render(<OverviewView {...viewProps()} />);
    expect(tile('Requests')).toEqual({ value: '3', hint: 'including 1 simulated' });
    expect(tile('Failed requests')).toEqual({
      value: '1',
      hint: 'not counting 1 simulated failure(s), still in the list',
    });
  });

  it("counts a delayed request's real 500 as a failure, never a synthetic one or a timeout during the delay", () => {
    entries.set('delayed', delayed500());
    entries.set(
      'timedout',
      entry({
        id: 'timedout',
        url: 'https://app.test/api/orders/4',
        state: 'timeout',
        status: undefined,
        startedAt: 9000,
        endedAt: 9300,
        simulated: DELAY,
      }),
    );
    render(<OverviewView {...viewProps()} />);
    // real 500 + the delayed request's 500; not the mock or the timeout.
    expect(tile('Failed requests')).toEqual({
      value: '2',
      hint: 'including 1 returned by the server behind a simulated delay; not counting 2 simulated failure(s), still in the list',
    });
  });

  it('is unchanged for sessions without simulated requests', () => {
    entries.delete('mocked');
    render(<OverviewView {...viewProps()} />);
    expect(tile('Requests')).toEqual({ value: '2', hint: undefined });
    expect(tile('Failed requests')).toEqual({ value: '1', hint: undefined });
    expect(tile(`Slow (≥ ${DEFAULT_SETTINGS.slowRequestMs} ms)`).hint).toBeUndefined();
  });
});

describe('findings list', () => {
  it('tags findings as backend or page behavior, and those involving simulated requests', () => {
    const list = [...entries.values()];
    const timeline = [
      timelineEvent({ kind: 'console-error', timestamp: entries.get('mocked')!.endedAt! + 100 }),
    ];
    const findings = detectIssues({ entries: list, timeline, slowRequestMs: 2000 });
    const analysis: Analysis = {
      findings,
      bodies: new Map(),
      links: [],
      openApi: [],
      ready: true,
      data: {
        entries: list,
        timeline,
        connections: [],
        messages: [],
        spans: [],
        findings,
        serverTracingConfigured: false,
        adaptersEnabled: false,
        advancedCapture: false,
      },
    };
    render(
      <InvestigationsView
        {...viewProps()}
        analysis={analysis}
        compareIds={{}}
        setCompareIds={vi.fn()}
        contracts={[]}
      />,
    );
    const card = (title: string) =>
      [...document.querySelectorAll<HTMLElement>('article.finding')].find(
        (a) => a.querySelector('h3')?.textContent === title,
      );
    const tags = (a: HTMLElement | undefined) =>
      [...a!.querySelectorAll('header .tag')].map((t) => t.textContent);
    expect(tags(card('500 from GET app.test/api/orders'))).toEqual(['backend']);
    // No backend failure for the mocked 500.
    expect(card('500 from GET app.test/api/orders/1')).toBeUndefined();
    const page = card('Console error after failed request · simulated by rule "Orders fail"');
    expect(tags(page)).toEqual(['page behavior', 'simulated']);
    expect(
      screen.getByText(/findings about how the page reacted include them and are tagged simulated/),
    ).toBeTruthy();
  });
});

describe('explicit comparison', () => {
  const compare = (ids: { a?: string; b?: string }) =>
    render(
      <InvestigationsView
        {...viewProps({ tab: 'compare' })}
        compareIds={ids}
        setCompareIds={vi.fn()}
        contracts={[]}
      />,
    );
  const summaryRow = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('.cmp-section tbody tr')].find(
      (r) => r.querySelector('th')?.textContent === label,
    );

  it('compares a real and a simulated request and names the simulated side', async () => {
    compare({ a: 'real', b: 'mocked' });
    await screen.findByRole('heading', { name: 'Summary' });
    expect(
      screen.getByText(
        'Request B is simulated and request A is real: differences may come from the simulation rule, not from the backend.',
      ),
    ).toBeTruthy();
    const row = summaryRow('Outcome from')!;
    expect(row.className).toBe('diff-changed');
    expect([...row.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'server',
      'rule "Orders fail" (no server response)',
    ]);
    // The ordinary comparison is still there.
    expect(summaryRow('Status')).toBeTruthy();
  });

  it('a comparison of real requests looks as before', async () => {
    compare({ a: 'real', b: 'ok' });
    await screen.findByRole('heading', { name: 'Summary' });
    expect(summaryRow('Outcome from')).toBeUndefined();
    expect(screen.queryByText(/simulated/)).toBeNull();
  });
});
