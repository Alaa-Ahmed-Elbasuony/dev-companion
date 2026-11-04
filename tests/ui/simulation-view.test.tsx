// @vitest-environment jsdom
// Simulation view against a fake worker that uses the real change logic
// (applySimulationRuleChange), the real per-tab status (pageSimulationStatus) and
// the real delivery state (simulationDelivery) for a page that applies the rules
// it is sent, stays silent, or is not connected.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySimulationRuleChange } from '../../src/background/simulation';
import type { SimulationStateResponse, WorkerRequest } from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import {
  normalizeSimulationRules,
  pageSimulationStatus,
  simulationDelivery,
  simulationRevision,
} from '../../src/shared/simulation';
import type { SimulationRule } from '../../src/shared/simulation';
import type { Settings } from '../../src/shared/types';
import { SimulationView } from '../../src/ui/dashboard/SimulationView';
import { installDomStubs } from '../helpers/dom';

const ORIGIN = 'http://localhost:3000';
const TAB = 7;

interface World {
  armed: boolean;
  rules: SimulationRule[];
  settings: Settings;
  rec: { origin: string; paused?: boolean } | null;
  tabOrigin: string | undefined;
  clock: number;
  /** What the tab's page does with rules: applies them, never confirms, or has no bridge. */
  page: 'applies' | 'silent' | 'disconnected';
  /** When the worker sent the current rules to the tab. */
  sentAt: number;
  /** Throws instead of answering, once. */
  failNext?: Error;
}
let world: World;
let sendMessage: ReturnType<typeof vi.fn>;
let storageListeners: ((changes: Record<string, unknown>, area: string) => void)[];
let runtimeListeners: ((message: unknown) => void)[];

const RULES = () =>
  normalizeSimulationRules([
    {
      id: 'r1',
      name: 'Orders down',
      enabled: true,
      match: { methods: ['GET'], urlPattern: '/api/orders', query: 'exact' },
      action: { kind: 'mock', status: 503, headers: [], body: '{"error":"down"}', bodyKind: 'json' },
      createdFrom: { entryId: 'e1', endpointKey: 'GET /api/orders' },
      updatedAt: 100,
    },
    {
      id: 'r2',
      name: 'Slow items',
      enabled: false,
      match: { methods: [], urlPattern: '/api/items/*' },
      action: { kind: 'delay' },
      delayMs: 500,
      updatedAt: 100,
    },
  ]);

function status(tabId?: number): SimulationStateResponse {
  const sim = { armed: world.armed, rules: world.rules };
  return {
    armed: world.armed,
    enabledRules: world.rules.filter((r) => r.enabled).length,
    origins: world.settings.simulationOrigins,
    rules: structuredClone(world.rules),
    page: tabId === undefined ? undefined : pageStatus(sim),
  };
}

function pageStatus(sim: { armed: boolean; rules: SimulationRule[] }) {
  const now = Date.now();
  const page = pageSimulationStatus(world.settings, sim, world.rec, world.tabOrigin, now);
  if (!page.active) return page;
  const enabled = sim.rules.filter((r) => r.enabled);
  const revision = simulationRevision(enabled);
  const ack =
    world.page === 'disconnected'
      ? undefined
      : world.page === 'silent'
        ? null
        : { revision, leaseUntil: now + 60_000, rules: enabled.length };
  return { ...page, ...simulationDelivery(revision, { revision, sentAt: world.sentAt }, ack, now) };
}

async function worker(message: WorkerRequest) {
  if (world.failNext) {
    const err = world.failNext;
    world.failNext = undefined;
    throw err;
  }
  switch (message.type) {
    case 'get-simulation-state':
      return status(message.tabId);
    case 'set-simulation-armed':
      world.armed = message.armed;
      return status();
    case 'update-simulation-rules': {
      const result = applySimulationRuleChange(world.rules, structuredClone(message.change), ++world.clock);
      if (result.ok) world.rules = result.rules;
      const { rules: _rules, ...rest } = result as typeof result & { rules?: unknown };
      return { ...rest, state: status() };
    }
  }
  return { ok: false, reason: 'unknown-message' };
}

beforeEach(() => {
  installDomStubs();
  world = {
    armed: false,
    rules: RULES(),
    settings: { ...DEFAULT_SETTINGS, simulationOrigins: [] },
    rec: { origin: ORIGIN },
    tabOrigin: ORIGIN,
    clock: 1000,
    page: 'applies',
    sentAt: Date.now(),
  };
  storageListeners = [];
  runtimeListeners = [];
  sendMessage = vi.fn((m: WorkerRequest) => worker(m));
  const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
  c.runtime!.sendMessage = sendMessage;
  c.runtime!.onMessage = {
    addListener: (fn: (typeof runtimeListeners)[number]) => runtimeListeners.push(fn),
    removeListener: (fn: (typeof runtimeListeners)[number]) =>
      (runtimeListeners = runtimeListeners.filter((l) => l !== fn)),
  };
  c.storage = {
    onChanged: {
      addListener: (fn: (typeof storageListeners)[number]) => storageListeners.push(fn),
      removeListener: (fn: (typeof storageListeners)[number]) =>
        (storageListeners = storageListeners.filter((l) => l !== fn)),
    },
    local: {
      get: vi.fn(async () => ({ settings: structuredClone(world.settings) })),
      set: vi.fn(async (items: { settings?: Settings }) => {
        if (items.settings) world.settings = structuredClone(items.settings);
      }),
    },
  };
});
afterEach(cleanup);

const renderView = () => render(<SimulationView tabId={TAB} version={0} />);
const loaded = () => screen.findByRole('heading', { name: 'Simulation' });
const statusInput = (dialog: HTMLElement) => dialog.querySelector<HTMLInputElement>('input[max="599"]')!;
const ruleRows = () => [...document.querySelectorAll('.sim-rules tbody tr')] as HTMLElement[];
const rowText = () => ruleRows().map((r) => r.textContent ?? '');
const updates = () =>
  sendMessage.mock.calls
    .map(([m]) => m as WorkerRequest)
    .filter(
      (m): m is Extract<WorkerRequest, { type: 'update-simulation-rules' }> =>
        m.type === 'update-simulation-rules',
    );
/** A change made by another window, as the worker would announce it. */
async function changedElsewhere(mutate: () => void) {
  mutate();
  await act(async () => storageListeners.forEach((l) => l({ simulationRules: {} }, 'local')));
}

describe('SimulationView: overview', () => {
  it('starts off and explains every reason simulation cannot run', async () => {
    renderView();
    await loaded();
    expect(screen.getByText('Not running on this tab')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn simulation on' })).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Simulation is turned off.');
    expect(status.textContent).toContain(`${ORIGIN} is not on the allowlist.`);
    expect(screen.getByRole('table', { name: 'Simulation status' }).textContent).toContain('1 of 2');
    expect(screen.getByText('No origins are allowlisted, so no page can be simulated.')).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-simulation-state', tabId: TAB });
  });

  it('does not claim to be active just because the switch is on', async () => {
    world.armed = true;
    renderView();
    await loaded();
    expect(screen.getByText('Not running on this tab')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('is not on the allowlist');
    expect(screen.getByRole('button', { name: 'Turn simulation off' })).toBeTruthy();
  });

  it('reports paused and not-recording tabs', async () => {
    world.armed = true;
    world.settings.simulationOrigins = [ORIGIN];
    world.rec = { origin: ORIGIN, paused: true };
    renderView();
    await loaded();
    expect(screen.getByRole('status').textContent).toContain(
      'Recording is paused, so simulation is paused too.',
    );
    cleanup();
    world.rec = null;
    renderView();
    await loaded();
    expect(screen.getByRole('status').textContent).toContain(`This tab is not recording ${ORIGIN}.`);
  });

  it('shows the active state only when the worker says the tab receives rules', async () => {
    world.armed = true;
    world.settings.simulationOrigins = [ORIGIN];
    renderView();
    await loaded();
    expect(screen.getByText('Active on this tab')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).toContain('1 enabled rule can change');
  });

  it('asks for a tab when none is selected', async () => {
    render(<SimulationView tabId={undefined} version={0} />);
    await loaded();
    expect(screen.getByRole('status').textContent).toContain('No tab is selected');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-simulation-state', tabId: undefined });
  });
});

describe('SimulationView: page confirmation', () => {
  const armedTab = () => {
    world.armed = true;
    world.settings.simulationOrigins = [ORIGIN];
  };
  const badge = () => document.querySelector('.sim-switch .badge')!.textContent;

  it('never shows the rules as active before the page confirms them', async () => {
    armedTab();
    world.page = 'silent';
    renderView();
    await loaded();
    expect(badge()).toContain('Sent to this tab, not confirmed yet');
    expect(document.body.textContent).not.toContain('Active on this tab');
    expect(document.body.textContent).toContain('it has not confirmed that it applies them yet');
  });

  it('reports a page that did not confirm in time, looking again when the wait ends', async () => {
    armedTab();
    world.page = 'silent';
    world.sentAt = Date.now() - 4800; // the wait ends in 200 ms
    renderView();
    await loaded();
    expect(badge()).toContain('Sent to this tab, not confirmed yet');
    await waitFor(() => expect(badge()).toContain('Not confirmed by this tab'), { timeout: 2000 });
    expect(document.body.textContent).toContain('the page did not confirm them');
  });

  it('reports a page that is not connected', async () => {
    armedTab();
    world.page = 'disconnected';
    renderView();
    await loaded();
    expect(badge()).toContain('Page not connected');
    expect(document.body.textContent).toContain('Reload the page to connect it.');
  });

  it('shows the confirmation when the worker relays that this tab applied the rules', async () => {
    armedTab();
    world.page = 'silent';
    renderView();
    await loaded();
    const asked = () => sendMessage.mock.calls.filter(([m]) => m.type === 'get-simulation-state').length;
    const before = asked();
    world.page = 'applies';
    // Another tab's page changed: not this view's concern.
    act(() => runtimeListeners.forEach((l) => l({ type: 'simulation-page-changed', tabId: TAB + 1 })));
    expect(asked()).toBe(before);
    act(() => runtimeListeners.forEach((l) => l({ type: 'simulation-page-changed', tabId: TAB })));
    await waitFor(() => expect(badge()).toContain('Active on this tab'));
  });
});

describe('SimulationView: kill switch', () => {
  it('turns simulation on and off through the worker, keeping the rules', async () => {
    world.settings.simulationOrigins = [ORIGIN];
    renderView();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Turn simulation on' }));
    await screen.findByText('Active on this tab');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'set-simulation-armed', armed: true });
    expect(world.armed).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Turn simulation off' }));
    await screen.findByText('Not running on this tab');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'set-simulation-armed', armed: false });
    expect(world.rules.map((r) => [r.id, r.enabled])).toEqual([
      ['r1', true],
      ['r2', false],
    ]);
    expect(updates()).toEqual([]);
    expect(document.body.textContent).toContain('Your rules are kept.');
  });

  it('reports a failed switch instead of a success message', async () => {
    renderView();
    await loaded();
    world.failNext = new Error('Extension context invalidated.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn simulation on' }));
    await screen.findByText('The extension was reloaded or updated. Reload this page to continue.');
    expect(world.armed).toBe(false);
    expect(document.body.textContent).not.toContain('Simulation is on.');
  });
});

describe('SimulationView: allowlist', () => {
  it('adds and removes origins explicitly, never on its own', async () => {
    renderView();
    await loaded();
    expect(world.settings.simulationOrigins).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: `Add ${ORIGIN}` }));
    await screen.findByText(
      `Allowlisted ${ORIGIN}. Simulation is still off; nothing runs until you turn it on.`,
    );
    expect(world.settings.simulationOrigins).toEqual([ORIGIN]);
    expect(world.armed).toBe(false);

    fireEvent.change(screen.getByLabelText('Origin to allowlist'), {
      target: { value: 'http://127.0.0.1:5173/app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add origin' }));
    await screen.findByText('http://127.0.0.1:5173');
    expect(world.settings.simulationOrigins).toEqual([ORIGIN, 'http://127.0.0.1:5173']);

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(world.settings.simulationOrigins).toEqual(['http://127.0.0.1:5173']));
  });

  it('rejects origins that are not http(s)', async () => {
    renderView();
    await loaded();
    for (const bad of ['ftp://files.test', 'not a url', 'chrome://extensions']) {
      fireEvent.change(screen.getByLabelText('Origin to allowlist'), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Add origin' }));
      await screen.findByText(`“${bad}” is not an http:// or https:// origin.`);
    }
    expect(world.settings.simulationOrigins).toEqual([]);
  });

  it('keeps other settings and allowlist entries saved elsewhere', async () => {
    renderView();
    await loaded();
    // Saved by another window after this view loaded.
    world.settings = { ...world.settings, maxEntries: 1234, simulationOrigins: ['http://other.test'] };
    fireEvent.change(screen.getByLabelText('Origin to allowlist'), { target: { value: ORIGIN } });
    fireEvent.click(screen.getByRole('button', { name: 'Add origin' }));
    await waitFor(() => expect(world.settings.simulationOrigins).toEqual(['http://other.test', ORIGIN]));
    expect(world.settings.maxEntries).toBe(1234);
  });
});

describe('SimulationView: rules', () => {
  it('lists rules in priority order with type, methods and pattern', async () => {
    renderView();
    await loaded();
    expect(rowText()).toHaveLength(2);
    expect(rowText()[0]).toContain('Orders down');
    expect(rowText()[0]).toContain('Mock 503');
    expect(rowText()[0]).toContain('GET');
    expect(rowText()[0]).toContain('/api/orders');
    expect(rowText()[0]).toContain('exact query');
    expect(rowText()[1]).toContain('Delay 500 ms, then send');
    expect(rowText()[1]).toContain('Any');
    expect(document.body.textContent).toContain('first enabled rule that matches');
  });

  it('enables and disables a single rule', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Enable Slow items'));
    await screen.findByText('Enabled “Slow items”.');
    expect(world.rules.map((r) => r.enabled)).toEqual([true, true]);
    expect(updates()[0]!.change).toEqual({
      op: 'set-enabled',
      id: 'r2',
      enabled: true,
      expectedUpdatedAt: 100,
    });
    fireEvent.click(screen.getByLabelText('Enable Orders down'));
    await screen.findByText('Disabled “Orders down”.');
    expect(world.rules.map((r) => r.enabled)).toEqual([false, true]);
  });

  it('reorders rules and keeps the new order', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Move Slow items up'));
    await waitFor(() => expect(rowText()[0]).toContain('Slow items'));
    expect(world.rules.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((screen.getByLabelText('Move Slow items up') as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes a rule only after confirmation', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Delete Orders down'));
    const dialog = screen.getByRole('dialog', { name: 'Delete this rule?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(world.rules).toHaveLength(2);
    expect(updates()).toEqual([]);

    fireEvent.click(screen.getByLabelText('Delete Orders down'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete rule' }));
    await screen.findByText('Deleted “Orders down”.');
    expect(world.rules.map((r) => r.id)).toEqual(['r2']);
    expect(rowText()).toHaveLength(1);
  });

  it('creates a rule with the editor', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog', { name: 'New rule' });
    fireEvent.change(within(dialog).getByPlaceholderText('Orders API down'), { target: { value: 'Teapot' } });
    fireEvent.change(within(dialog).getByPlaceholderText('localhost:3000/api/orders/:id'), {
      target: { value: '/api/tea' },
    });
    fireEvent.change(within(dialog).getByPlaceholderText('GET, POST'), { target: { value: 'post, get' } });
    fireEvent.change(statusInput(dialog), { target: { value: '418' } });
    fireEvent.change(within(dialog).getByPlaceholderText('x-request-id: mock-1'), {
      target: { value: 'X-Brew: earl grey' },
    });
    fireEvent.change(within(dialog).getByLabelText('Body'), { target: { value: '{"short":"stout"}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    await screen.findByText('Rule created.');
    expect(screen.queryByRole('dialog')).toBeNull();
    const created = world.rules[2]!;
    expect(created).toMatchObject({
      name: 'Teapot',
      enabled: true,
      match: { methods: ['POST', 'GET'], urlPattern: '/api/tea', query: 'ignore' },
      action: {
        kind: 'mock',
        status: 418,
        headers: [{ name: 'x-brew', value: 'earl grey' }],
        body: '{"short":"stout"}',
      },
      allowSensitive: false,
    });
    expect(created.id).not.toBe('');
    expect(rowText()[2]).toContain('Teapot');
  });

  it('blocks invalid rules in the editor and sends nothing', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(statusInput(dialog), { target: { value: '700' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    expect(await within(dialog).findByText('Enter a URL pattern.')).toBeTruthy();
    expect(within(dialog).getByText(/Use a status from 200 to 599/)).toBeTruthy();
    expect(within(dialog).getByText('Fix the highlighted fields to save this rule.')).toBeTruthy();
    expect(statusInput(dialog).getAttribute('aria-invalid')).toBe('true');
    expect(updates()).toEqual([]);
  });

  it('shows the worker rejection when the worker refuses a rule', async () => {
    renderView();
    await loaded();
    // A worker that is stricter than this page (e.g. a newer extension build).
    sendMessage.mockImplementationOnce(async () => ({
      ok: false,
      reason: 'invalid',
      message: 'The rule was not saved: Methods are letters only, e.g. GET, POST.',
      problems: { methods: 'Methods are letters only, e.g. GET, POST.' },
      state: status(),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('localhost:3000/api/orders/:id'), {
      target: { value: '/api/x' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    expect(
      await within(dialog).findByText('The rule was not saved: Methods are letters only, e.g. GET, POST.'),
    ).toBeTruthy();
    expect(within(dialog).getByPlaceholderText('GET, POST').getAttribute('aria-invalid')).toBe('true');
    expect(world.rules).toHaveLength(2);
  });

  it('warns about sensitive endpoints and saves the explicit opt-in', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('localhost:3000/api/orders/:id'), {
      target: { value: '/api/auth/login' },
    });
    expect(within(dialog).getByText(/targets authentication endpoints/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/Allow this rule to simulate authentication and payment/));
    expect(within(dialog).queryByText(/targets authentication endpoints/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    await screen.findByText('Rule created.');
    expect(world.rules[2]!.allowSensitive).toBe(true);
    expect(rowText()[2]).toContain('auth/payment allowed');
  });

  it('edits a rule without dropping fields the editor does not show', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Edit Orders down'));
    const dialog = screen.getByRole('dialog', { name: 'Edit rule' });
    fireEvent.change(within(dialog).getByPlaceholderText('Orders API down'), {
      target: { value: 'Orders flaky' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await screen.findByText('Saved “Orders flaky”.');
    const saved = world.rules[0]!;
    expect(saved).toMatchObject({
      id: 'r1',
      name: 'Orders flaky',
      match: { methods: ['GET'], urlPattern: '/api/orders', query: 'exact' },
      action: { kind: 'mock', status: 503, body: '{"error":"down"}' },
      createdFrom: { entryId: 'e1', endpointKey: 'GET /api/orders' },
    });
    expect(saved.updatedAt).toBeGreaterThan(100);
    expect(world.rules.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('SimulationView: stale state', () => {
  it('refreshes when rules change in another window', async () => {
    renderView();
    await loaded();
    await changedElsewhere(() => {
      world.rules = world.rules.slice(1);
    });
    await waitFor(() => expect(rowText()).toHaveLength(1));
  });

  it('rejects a toggle made from a stale copy and shows the latest rules', async () => {
    renderView();
    await loaded();
    // Another window renames r1 without this view hearing about it yet.
    world.rules = world.rules.map((r) =>
      r.id === 'r1' ? { ...r, name: 'Renamed elsewhere', updatedAt: 200 } : r,
    );
    fireEvent.click(screen.getByLabelText('Enable Orders down'));
    await screen.findByText(/changed in another window or tab/);
    expect(world.rules[0]!.enabled).toBe(true);
    expect(world.rules[0]!.name).toBe('Renamed elsewhere');
    await waitFor(() => expect(rowText()[0]).toContain('Renamed elsewhere'));
  });

  it('never overwrites a newer version from the editor without asking', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Edit Orders down'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(statusInput(dialog), { target: { value: '500' } });
    world.rules = world.rules.map((r) => (r.id === 'r1' ? { ...r, delayMs: 50, updatedAt: 300 } : r));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await within(dialog).findByText(/changed in another window or tab/);
    expect(world.rules[0]).toMatchObject({ delayMs: 50, updatedAt: 300 });
    expect((world.rules[0]!.action as { status: number }).status).toBe(503);

    // Keeping the edits re-bases them on the newest copy; saving then succeeds.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite with my version' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await screen.findByText('Saved “Orders down”.');
    expect((world.rules[0]!.action as { status: number }).status).toBe(500);
    expect(world.rules[0]!.createdFrom).toEqual({ entryId: 'e1', endpointKey: 'GET /api/orders' });
  });

  it('offers to save a rule deleted elsewhere as a new one', async () => {
    renderView();
    await loaded();
    fireEvent.click(screen.getByLabelText('Edit Orders down'));
    const dialog = screen.getByRole('dialog');
    world.rules = world.rules.filter((r) => r.id !== 'r1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await within(dialog).findByText(/no longer exists/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as a new rule' }));
    await screen.findByText('Rule created.');
    expect(world.rules.map((r) => r.name)).toEqual(['Slow items', 'Orders down']);
    expect(world.rules[1]!.id).not.toBe('r1');
  });

  it('ignores an older state answer that arrives after a newer one', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const stale = status(TAB);
    sendMessage.mockImplementationOnce(async () => {
      await first;
      return stale;
    });
    renderView();
    // A newer refresh (another window deleted r1) answers first.
    world.rules = world.rules.slice(1);
    await act(async () => storageListeners.forEach((l) => l({ simulationRules: {} }, 'local')));
    await waitFor(() => expect(rowText()).toHaveLength(1));
    await act(async () => {
      releaseFirst();
      await first;
    });
    expect(rowText()).toHaveLength(1);
  });
});

describe('SimulationView: worker failures', () => {
  it('shows an error with a retry when the first load fails', async () => {
    world.failNext = new Error('Could not establish connection. Receiving end does not exist.');
    renderView();
    await screen.findByText(/The extension did not respond/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
  });

  it('reports a failed change and keeps the stored rules unchanged', async () => {
    renderView();
    await loaded();
    world.failNext = new Error('Extension context invalidated.');
    fireEvent.click(screen.getByLabelText('Enable Slow items'));
    await screen.findByText('The extension was reloaded or updated. Reload this page to continue.');
    expect(world.rules[1]!.enabled).toBe(false);
    expect((screen.getByLabelText('Enable Slow items') as HTMLInputElement).checked).toBe(false);
  });

  it('treats a refused message as a failure', async () => {
    renderView();
    await loaded();
    sendMessage.mockImplementationOnce(async () => ({ ok: false, reason: 'forbidden' }));
    fireEvent.click(screen.getByLabelText('Enable Slow items'));
    await screen.findByText('The extension did not respond: forbidden');
  });
});
