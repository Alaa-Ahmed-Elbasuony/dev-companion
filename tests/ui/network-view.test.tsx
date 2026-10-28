// @vitest-environment jsdom
// Request explorer: filters, sorting, empty states, keyboard navigation, the
// confirm dialog's focus handling and virtualization of very large sessions.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { NetworkEntry } from '../../src/shared/types';
import type { ViewProps } from '../../src/ui/dashboard/context';
import { NetworkView } from '../../src/ui/dashboard/NetworkView';
import type * as Extension from '../../src/ui/lib/extension';
import type { SessionData } from '../../src/ui/lib/session-data';
import { installDomStubs, scrollTo } from '../helpers/dom';
import { entry } from '../helpers/entries';

const store = {
  getBodies: vi.fn(async () => undefined),
  searchBodies: vi.fn(async () => new Set<string>()),
  deleteEntries: vi.fn(async () => undefined),
  clearSession: vi.fn(async () => undefined),
};
vi.mock('../../src/ui/lib/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof Extension>()),
  getStore: async () => store,
  notifyDataChanged: () => undefined,
}));

function sessionData(entries: NetworkEntry[]): SessionData {
  return {
    sessions: [],
    sessionId: 's-1',
    session: undefined,
    entries,
    timeline: [],
    contracts: [],
    connections: [],
    spans: [],
    investigations: [],
    usage: { entryCount: entries.length, totalBytes: 0 },
    messageCount: 0,
    recording: null,
    storageStatus: null,
    traceStatus: {},
    loading: false,
    error: null,
  };
}

/** Holds route params in state, as the dashboard shell does. */
function Harness({
  entries,
  initial = {},
  spy,
}: {
  entries: NetworkEntry[];
  initial?: Record<string, string>;
  spy?: (p: Record<string, string>) => void;
}) {
  const [params, setParams] = useState(initial);
  const props: ViewProps = {
    data: sessionData(entries),
    settings: DEFAULT_SETTINGS,
    analysis: null,
    params,
    setParams: (p) => {
      spy?.(p);
      setParams(p);
    },
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
  return <NetworkView {...props} />;
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.request-list [role="row"]')];
const paths = () => rows().map((r) => r.querySelector('.url-path')?.textContent);

const sample = () => [
  entry({
    id: 'a',
    method: 'GET',
    url: 'https://app.test/api/a',
    status: 200,
    startedAt: 1000,
    duration: 50,
  }),
  entry({
    id: 'b',
    method: 'POST',
    url: 'https://app.test/api/b',
    status: 500,
    startedAt: 2000,
    duration: 900,
  }),
  entry({
    id: 'c',
    method: 'DELETE',
    url: 'https://app.test/api/c',
    status: 404,
    startedAt: 3000,
    duration: 300,
  }),
  entry({
    id: 'd',
    method: 'GET',
    url: 'https://app.test/api/d',
    state: 'pending',
    status: undefined,
    startedAt: 4000,
    duration: undefined,
  }),
];

beforeEach(installDomStubs);
afterEach(cleanup);

describe('NetworkView empty states', () => {
  it('explains how to start when nothing was captured', () => {
    render(<Harness entries={[]} />);
    expect(screen.getByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('No requests captured in this view yet.'),
    );
    expect(screen.getByRole('button', { name: 'Export…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear session' })).toHaveProperty('disabled', true);
  });

  it('distinguishes "no matches" from "no data" and offers to clear filters', () => {
    const spy = vi.fn();
    render(<Harness entries={sample()} initial={{ methods: 'PUT' }} spy={spy} />);
    const empty = screen.getByRole('status');
    expect(empty.textContent).toContain('No requests match the current filters.');
    fireEvent.click(within(empty).getByRole('button', { name: 'Clear all filters' }));
    expect(spy).toHaveBeenLastCalledWith({});
    expect(paths()).toHaveLength(4);
  });
});

describe('NetworkView filters', () => {
  it('filters by method chip, shows an active-filter chip and a count, and removes it', () => {
    render(<Harness entries={sample()} />);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Method filter' })).getByRole('button', { name: 'GET' }),
    );
    expect(paths()).toEqual(['/api/d', '/api/a']);
    expect(document.querySelector('.active-filters .count')?.textContent).toBe('2 of 4 requests');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter GET' }));
    expect(paths()).toHaveLength(4);
  });

  it('applies status, preset and minimum-duration filters from the URL', () => {
    const { unmount } = render(<Harness entries={sample()} initial={{ status: 'server-error' }} />);
    expect(paths()).toEqual(['/api/b']);
    unmount();
    render(<Harness entries={sample()} initial={{ preset: 'failed' }} />);
    expect(paths()).toEqual(['/api/c', '/api/b']);
    expect(screen.getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Minimum duration in milliseconds'), { target: { value: '500' } });
    expect(paths()).toEqual(['/api/b']);
  });

  it('ignores negative or non-numeric minimum durations', () => {
    render(<Harness entries={sample()} />);
    fireEvent.change(screen.getByLabelText('Minimum duration in milliseconds'), { target: { value: '-5' } });
    expect(paths()).toHaveLength(4);
    expect(document.querySelectorAll('.filter-chip')).toHaveLength(0);
  });

  it('debounces the text filter', () => {
    vi.useFakeTimers();
    try {
      render(<Harness entries={sample()} />);
      fireEvent.change(screen.getByLabelText('Search requests'), { target: { value: '/api/c' } });
      expect(paths()).toHaveLength(4);
      act(() => vi.advanceTimersByTime(250));
      expect(paths()).toEqual(['/api/c']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NetworkView sorting', () => {
  it.each([
    ['newest', ['/api/d', '/api/c', '/api/b', '/api/a']],
    ['oldest', ['/api/a', '/api/b', '/api/c', '/api/d']],
    ['slowest', ['/api/b', '/api/c', '/api/a', '/api/d']],
    ['status', ['/api/b', '/api/c', '/api/a', '/api/d']],
    ['method', ['/api/c', '/api/d', '/api/a', '/api/b']],
  ])('sorts by %s', (sort, expected) => {
    render(<Harness entries={sample()} />);
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: sort } });
    expect(paths()).toEqual(expected);
  });

  it('falls back to newest first for an unknown sort parameter', () => {
    render(<Harness entries={sample()} initial={{ sort: 'bogus' }} />);
    expect(paths()[0]).toBe('/api/d');
  });
});

describe('NetworkView keyboard navigation', () => {
  it('moves the selection with j / k, clamps at the ends and closes with Escape', () => {
    const spy = vi.fn();
    render(<Harness entries={sample()} spy={spy} />);
    const selected = () =>
      document.querySelector('.request-list [aria-selected="true"] .url-path')?.textContent;
    fireEvent.keyDown(window, { key: 'j' });
    expect(selected()).toBe('/api/d');
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(selected()).toBe('/api/a');
    fireEvent.keyDown(window, { key: 'k' });
    expect(selected()).toBe('/api/b');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(selected()).toBeUndefined();
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ id: '' }));
  });

  it('ignores single-key shortcuts while typing in the search field, and "/" focuses it', () => {
    render(<Harness entries={sample()} />);
    const search = screen.getByLabelText('Search requests');
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'j' });
    expect(document.querySelector('.request-list [aria-selected="true"]')).toBeNull();
  });
});

describe('NetworkView confirm dialog', () => {
  it('moves focus into the dialog, traps Tab, closes on Escape and restores focus', () => {
    render(<Harness entries={sample()} />);
    fireEvent.click(within(rows()[0]!).getByLabelText('Select request'));
    const opener = screen.getByRole('button', { name: 'Delete selected' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Delete selected requests?' });
    expect(document.activeElement).toBe(dialog);
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete 1' });

    confirm.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(store.deleteEntries).not.toHaveBeenCalled();
  });

  it('deletes only after confirmation', async () => {
    render(<Harness entries={sample()} />);
    fireEvent.click(within(rows()[1]!).getByLabelText('Select request'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete 1' })));
    expect(store.deleteEntries).toHaveBeenCalledWith(['c']);
    expect(screen.getByText('Deleted 1 request(s).')).toBeTruthy();
  });
});

describe('NetworkView with 50,000 requests', () => {
  const big = Array.from({ length: 50_000 }, (_, i) =>
    entry({
      id: `r${i}`,
      url: `https://app.test/api/r/${i}`,
      startedAt: 1_000_000 + i,
      status: i % 10 ? 200 : 500,
    }),
  );

  it('renders a bounded window of rows and follows scrolling', () => {
    // jsdom has no layout; give the list a realistic 600px viewport (20 rows).
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    onTestFinished(() => height.mockRestore());
    const t0 = performance.now();
    render(<Harness entries={big} />);
    const elapsed = performance.now() - t0;
    console.log(JSON.stringify({ render50k: Math.round(elapsed) }));
    expect(elapsed).toBeLessThan(1000);

    const list = document.querySelector('.request-list')!;
    expect(rows().length).toBeLessThan(40);
    expect((list.firstElementChild as HTMLElement).style.height).toBe(`${50_000 * 30}px`);
    expect(paths()[0]).toBe('/api/r/49999');

    act(() => scrollTo(list, 50_000 * 30 - 600));
    expect(rows().length).toBeLessThan(40);
    expect(paths()).toContain('/api/r/0');
  });

  it('filters 50,000 rows to the matching subset', () => {
    render(<Harness entries={big} initial={{ status: 'server-error' }} />);
    expect(document.querySelector('.active-filters .count')?.textContent).toBe('5000 of 50000 requests');
    expect(rows().length).toBeLessThan(40);
  });
});
