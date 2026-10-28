// @vitest-environment jsdom
// Request comparison as reached from Investigations → Compare: loading both
// sides from the store, the summary/body/header diffs, and swap/clear.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { EntryBodies, NetworkEntry } from '../../src/shared/types';
import type { ViewProps } from '../../src/ui/dashboard/context';
import { InvestigationsView } from '../../src/ui/dashboard/InvestigationsView';
import type * as Extension from '../../src/ui/lib/extension';
import type { SessionData } from '../../src/ui/lib/session-data';
import { installDomStubs } from '../helpers/dom';
import { entry, jsonBodies } from '../helpers/entries';

const entries = new Map<string, NetworkEntry>();
const bodies = new Map<string, EntryBodies>();
const store = {
  getEntry: vi.fn(async (id: string) => entries.get(id)),
  getBodies: vi.fn(async (id: string) => bodies.get(id)),
};
vi.mock('../../src/ui/lib/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof Extension>()),
  getStore: async () => store,
  notifyDataChanged: () => undefined,
}));

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

function Harness({
  initial,
  openEntry = vi.fn(),
}: {
  initial: { a?: string; b?: string };
  openEntry?: (id: string) => void;
}) {
  const [compareIds, setCompareIds] = useState(initial);
  const props: ViewProps = {
    data: sessionData(),
    settings: DEFAULT_SETTINGS,
    analysis: null,
    params: { tab: 'compare' },
    setParams: vi.fn(),
    navigate: vi.fn(),
    investigate: vi.fn(),
    openEntry,
    reload: vi.fn(),
    onCompare: vi.fn(),
    onReplay: vi.fn(),
    onPlayground: vi.fn(),
    version: 0,
    setSession: vi.fn(),
  };
  return (
    <InvestigationsView {...props} compareIds={compareIds} setCompareIds={setCompareIds} contracts={[]} />
  );
}

const section = (title: string) =>
  screen.getByRole('heading', { name: new RegExp(`^${title}`) }).closest('section') as HTMLElement;
const cellTexts = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => td.textContent);
const summaryRow = (summary: HTMLElement, label: string) =>
  [...summary.querySelectorAll<HTMLElement>('tbody tr')].find(
    (r) => r.querySelector('th')?.textContent === label,
  )!;

beforeEach(() => {
  installDomStubs();
  entries.clear();
  bodies.clear();
  entries.set(
    'a',
    entry({
      id: 'a',
      url: 'https://app.test/api/orders/1',
      status: 200,
      duration: 100,
      requestHeaders: [{ name: 'Accept', value: 'application/json' }],
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Date', value: 'Mon' },
        { name: 'X-Old', value: '1' },
      ],
    }),
  );
  entries.set(
    'b',
    entry({
      id: 'b',
      url: 'https://app.test/api/orders/2',
      status: 500,
      duration: 350,
      requestHeaders: [{ name: 'accept', value: 'application/json' }],
      responseHeaders: [
        { name: 'content-type', value: 'text/plain' },
        { name: 'date', value: 'Tue' },
        { name: 'X-New', value: '2' },
      ],
    }),
  );
  bodies.set('a', jsonBodies('a', { id: 1, price: 10, items: [1, 2], gone: true }));
  bodies.set('b', jsonBodies('b', { id: '1', price: 12, items: [1], extra: null }));
});
afterEach(cleanup);

describe('Compare view', () => {
  it('asks for both sides until two requests are chosen', async () => {
    render(<Harness initial={{ a: 'a' }} />);
    expect(screen.getByRole('tab', { name: /^Compare \(1\/2\)/ })).toBeTruthy();
    await screen.findByText('https://app.test/api/orders/1');
    expect(screen.getByText(/Not set — choose a request, or use “Compare as B”/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
  });

  it('shows the summary, JSON body diff and header diff of two stored requests', async () => {
    render(<Harness initial={{ a: 'a', b: 'b' }} />);
    await screen.findByRole('heading', { name: 'Summary' });

    const summary = section('Summary');
    const rowOf = (label: string) => summaryRow(summary, label);
    expect(rowOf('Method').className).toBe('');
    expect(rowOf('URL').className).toBe('diff-changed');
    expect(cellTexts(rowOf('Status'))).toEqual(['200', '500']);
    expect(rowOf('Status').className).toBe('diff-changed');
    expect(rowOf('Duration').textContent).toContain('+');

    const body = section('Response body');
    const changes = [...body.querySelectorAll('tbody tr')].map((r) => [
      r.querySelector('code')?.textContent,
      r.className.split(' ')[0],
    ]);
    expect(changes).toEqual([
      ['$.id', 'diff-type-changed'],
      ['$.price', 'diff-value-changed'],
      ['$.items[1]', 'diff-removed'],
      ['$.gone', 'diff-removed'],
      ['$.extra', 'diff-added'],
    ]);
    expect(within(body).getByText(/number → string/)).toBeTruthy();
    expect(within(section('Request body')).getByText('Neither body was captured as text.')).toBeTruthy();

    const headers = section('Response headers');
    const names = () =>
      [...headers.querySelectorAll('tbody tr')].map((r) => cellTexts(r as HTMLElement).slice(0, 2));
    expect(names()).toEqual([
      ['x-new', 'added'],
      ['x-old', 'removed'],
      ['content-type', 'changed'],
    ]);
    fireEvent.click(within(headers).getByRole('checkbox'));
    expect(names()).toContainEqual(['date', 'changed']);
    // Header names compare case-insensitively, so the request headers match.
    expect(within(section('Request headers')).getByText('No differences.')).toBeTruthy();
  });

  it('falls back to text comparison and refuses truncated bodies', async () => {
    bodies.set('a', { id: 'a', response: { kind: 'text', text: 'ok' } });
    bodies.set('b', {
      id: 'b',
      response: { kind: 'text', text: 'ok' },
      request: { kind: 'text', text: 'x', truncated: true },
    });
    render(<Harness initial={{ a: 'a', b: 'b' }} />);
    await screen.findByRole('heading', { name: 'Summary' });
    expect(
      within(section('Response body')).getByText('Bodies are identical (text comparison).'),
    ).toBeTruthy();
    expect(within(section('Request body')).getByText(/truncated/)).toBeTruthy();
  });

  it('swaps and clears the two sides and opens a side in the request list', async () => {
    const openEntry = vi.fn();
    render(<Harness initial={{ a: 'a', b: 'b' }} openEntry={openEntry} />);
    await screen.findByRole('heading', { name: 'Summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(cellTexts(summaryRow(section('Summary'), 'Status'))).toEqual(['500', '200']));
    expect(within(section('Response body')).getByText('$.extra').closest('tr')!.className).toContain(
      'diff-removed',
    );

    // After the swap, request B's URL is the first (left) slot.
    fireEvent.click(screen.getByRole('button', { name: /api\/orders\/2/ }));
    expect(openEntry).toHaveBeenCalledWith('b');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull());
    expect(screen.getAllByText(/Not set/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Swap' })).toHaveProperty('disabled', true);
  });

  it('picks both sides from the session list, moving on to the empty side', async () => {
    entries.set(
      'c',
      entry({ id: 'c', method: 'POST', url: 'https://app.test/api/cart', startedAt: 9_000_000 }),
    );
    render(<Harness initial={{}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose request A' }));
    const filter = screen.getByRole('searchbox', { name: 'Filter requests' });
    expect(document.activeElement).toBe(filter);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.change(filter, { target: { value: 'orders 200' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    fireEvent.mouseDown(options[0]!);

    // A is set; the picker for B opens by itself, lists the same endpoint first and hides A.
    await screen.findByText('https://app.test/api/orders/1');
    const listB = screen.getByRole('listbox', { name: 'Requests' });
    const urls = within(listB)
      .getAllByRole('option')
      .map((o) => o.querySelector('.break')?.textContent);
    expect(urls).toEqual(['https://app.test/api/orders/2', 'https://app.test/api/cart']);
    expect(within(listB).getAllByText('same endpoint')).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    await screen.findByRole('heading', { name: 'Summary' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('tab', { name: /^Compare \(2\/2\)/ })).toBeTruthy();
  });

  it('changes one side with the keyboard and cancels with Escape', async () => {
    entries.set(
      'c',
      entry({ id: 'c', method: 'POST', url: 'https://app.test/api/cart', startedAt: 9_000_000 }),
    );
    render(<Harness initial={{ a: 'a', b: 'b' }} />);
    await screen.findByRole('heading', { name: 'Summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Change request B' }));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change request B' }));
    const filter = screen.getByRole('searchbox');
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(filter, { key: 'Enter' });
    await screen.findByRole('button', { name: /api\/cart/ });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('treats a request that no longer exists as unset', async () => {
    render(<Harness initial={{ a: 'a', b: 'deleted' }} />);
    await screen.findByText('https://app.test/api/orders/1');
    expect(screen.getByText(/Compare as B/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
  });
});
