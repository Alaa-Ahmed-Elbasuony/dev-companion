// Replay and the request playground send from the extension page with its own
// fetch, so simulation rules active in the recorded page never apply to them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessReplay } from '../../src/analysis/replay-safety';
import { realTraffic } from '../../src/analysis/simulated-traffic';
import { installFetchRecorder } from '../../src/capture/fetch-recorder';
import { DEFAULT_REDACTION, DEFAULT_SETTINGS } from '../../src/shared/settings';
import { SIMULATION_LEASE_MS, normalizeSimulationRules } from '../../src/shared/simulation';
import type { NetworkEntry } from '../../src/shared/types';
import { executeReplay } from '../../src/ui/lib/replay';
import { entry } from '../helpers/entries';
import { makeContext } from '../helpers/recorder';

const stored: NetworkEntry[] = [];
vi.mock('../../src/ui/lib/extension', () => ({
  getStore: async () => ({ upsertEntry: async (e: NetworkEntry) => void stored.push(e) }),
  notifyDataChanged: () => undefined,
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  stored.length = 0;
});

describe('replay isolation', () => {
  it('replays reach the network even while the page simulates every request', async () => {
    // The recorded page: a catch-all mock rule is active.
    const pageFetch = vi.fn(async () => new Response('page'));
    const page = { fetch: pageFetch as unknown as typeof fetch };
    const rules = normalizeSimulationRules([
      {
        id: 'all',
        enabled: true,
        allowSensitive: true,
        match: { methods: [], urlPattern: '*' },
        action: { kind: 'mock', status: 500, body: '{"mocked":true}' },
      },
    ]);
    const t = makeContext({ simulation: { rules, leaseUntil: Date.now() + SIMULATION_LEASE_MS } });
    installFetchRecorder(page, t.ctx);
    const pageResponse = await page.fetch('/api/orders');
    expect(pageResponse.status).toBe(500);

    // The extension page's own fetch.
    const extensionFetch = vi.fn(async () => new Response('{"real":true}', { status: 201 }));
    globalThis.fetch = extensionFetch as unknown as typeof fetch;

    const original = entry({ method: 'POST', url: 'https://app.test/api/orders' });
    const draft = {
      method: 'POST',
      url: 'https://app.test/api/orders',
      headers: [],
      body: '{"q":1}',
      includeCredentials: false,
    };
    const result = await executeReplay(
      original,
      draft,
      assessReplay(draft, original.url, DEFAULT_REDACTION),
      DEFAULT_SETTINGS,
    );

    expect(extensionFetch).toHaveBeenCalledTimes(1);
    expect(pageFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'replay', status: 201, state: 'complete' });
    expect(result.simulated).toBeUndefined();
    expect(stored[0]!.simulated).toBeUndefined();
  });

  it('replaying (or editing in the playground) a simulated request sends it for real', async () => {
    const extensionFetch = vi.fn(async () => new Response('{"real":true}', { status: 200 }));
    globalThis.fetch = extensionFetch as unknown as typeof fetch;
    const original = entry({
      url: 'https://app.test/api/orders',
      status: 500,
      simulated: { ruleId: 'r', ruleName: 'Orders fail', action: 'mock', delayMs: 0, sent: false },
    });
    const draft = {
      method: 'GET',
      url: original.url,
      headers: [],
      body: '',
      includeCredentials: false,
    };
    const result = await executeReplay(
      original,
      draft,
      assessReplay(draft, original.url, DEFAULT_REDACTION),
      DEFAULT_SETTINGS,
    );
    expect(extensionFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ source: 'replay', replayOf: original.id, status: 200 });
    // The original stays simulated; the replay is real traffic and counts as such.
    expect(result.simulated).toBeUndefined();
    expect(realTraffic([original, result])).toEqual([result]);
  });
});
