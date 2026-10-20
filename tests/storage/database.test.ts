import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryStore } from '../../src/storage/database';
import { planEviction } from '../../src/storage/retention';
import { entry } from '../helpers/entries';

let dbIndex = 0;
const stores: EntryStore[] = [];
async function openStore(name = `test-db-${++dbIndex}`) {
  const store = await EntryStore.open(name);
  stores.push(store);
  return { store, name };
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});

describe('EntryStore', () => {
  it('merges start and end events and tracks usage', async () => {
    const { store } = await openStore();
    const pending = entry({ id: 'r1', state: 'pending', status: undefined, bytes: 100 });
    expect(await store.upsertEntry(pending, undefined, 'start')).toBe(true);
    expect(await store.getUsage()).toEqual({ entryCount: 1, totalBytes: 100 });

    const done = { ...pending, state: 'complete' as const, status: 201, bytes: 300 };
    expect(await store.upsertEntry(done, { id: 'r1', response: { kind: 'json', text: '{}' } }, 'end')).toBe(
      true,
    );
    expect(await store.getEntry('r1')).toMatchObject({ state: 'complete', status: 201 });
    expect(await store.getBodies('r1')).toMatchObject({ response: { text: '{}' } });
    expect(await store.getUsage()).toEqual({ entryCount: 1, totalBytes: 300 });
  });

  it('never downgrades a completed entry when a late start arrives', async () => {
    const { store } = await openStore();
    const done = entry({ id: 'r1', state: 'complete' });
    await store.upsertEntry(done, undefined, 'end');
    expect(await store.upsertEntry({ ...done, state: 'pending' }, undefined, 'start')).toBe(false);
    expect(await store.upsertEntry({ ...done, state: 'pending' }, undefined, 'end')).toBe(false);
    expect((await store.getEntry('r1'))!.state).toBe('complete');
  });

  it('ignores end events whose id belongs to another session', async () => {
    const { store } = await openStore();
    await store.upsertEntry(
      entry({ id: 'r1', sessionId: 'a', url: 'https://app.test/real' }),
      undefined,
      'end',
    );
    expect(
      await store.upsertEntry(
        entry({ id: 'r1', sessionId: 'b', url: 'https://evil.test' }),
        undefined,
        'end',
      ),
    ).toBe(false);
    expect((await store.getEntry('r1'))!.url).toBe('https://app.test/real');
  });

  it('persists across reopen (survives service worker restarts and page reloads)', async () => {
    const { store, name } = await openStore();
    await store.upsertEntry(
      entry({ id: 'keep', method: 'POST', url: 'https://app.test/api/orders' }),
      undefined,
      'end',
    );
    store.close();
    const { store: reopened } = await openStore(name);
    expect(await reopened.getEntry('keep')).toMatchObject({
      method: 'POST',
      url: 'https://app.test/api/orders',
    });
    expect((await reopened.getUsage()).entryCount).toBe(1);
  });

  it('enforces retention by entry count, evicting the oldest first', async () => {
    const { store } = await openStore();
    for (let i = 0; i < 20; i++) {
      await store.upsertEntry(
        entry({ id: `r${i}`, startedAt: 1000 + i, bytes: 10 }),
        { id: `r${i}`, response: { kind: 'text', text: 'x' } },
        'end',
      );
    }
    const evicted = await store.enforceRetention({ maxEntries: 10, maxBytes: 1_000_000 });
    expect(evicted).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']);
    const remaining = await store.listEntries();
    expect(remaining.map((e) => e.id)).toEqual([
      'r11',
      'r12',
      'r13',
      'r14',
      'r15',
      'r16',
      'r17',
      'r18',
      'r19',
    ]);
    expect(await store.getBodies('r0')).toBeUndefined();
    expect(await store.getUsage()).toEqual({ entryCount: 9, totalBytes: 90 });
  });

  it('enforces retention by approximate size', async () => {
    const { store } = await openStore();
    for (let i = 0; i < 5; i++)
      await store.upsertEntry(entry({ id: `r${i}`, startedAt: i, bytes: 1000 }), undefined, 'end');
    await store.enforceRetention({ maxEntries: 100, maxBytes: 2500 });
    const usage = await store.getUsage();
    expect(usage.totalBytes).toBeLessThanOrEqual(2250);
    expect((await store.listEntries()).map((e) => e.id)).toEqual(['r3', 'r4']);
  });

  it('deletes entries, clears sessions and clears everything', async () => {
    const { store } = await openStore();
    await store.upsertEntry(entry({ id: 'a', sessionId: 's1' }), undefined, 'end');
    await store.upsertEntry(entry({ id: 'b', sessionId: 's1' }), undefined, 'end');
    await store.upsertEntry(entry({ id: 'c', sessionId: 's2' }), undefined, 'end');
    expect(await store.deleteEntries(['a'])).toBe(1);
    await store.clearSession('s1');
    expect((await store.listEntries()).map((e) => e.id)).toEqual(['c']);
    await store.clearAll();
    expect(await store.listEntries()).toEqual([]);
    expect(await store.getUsage()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it('marks pending entries from a previous document as incomplete', async () => {
    const { store } = await openStore();
    await store.upsertEntry(entry({ id: 'old', pageId: 'p1', state: 'pending' }), undefined, 'start');
    await store.upsertEntry(entry({ id: 'cur', pageId: 'p2', state: 'pending' }), undefined, 'start');
    await store.upsertEntry(
      entry({ id: 'other-tab', tabId: 9, pageId: 'p1', state: 'pending' }),
      undefined,
      'start',
    );
    expect(await store.markIncomplete(1, 'p2', 'navigated')).toBe(1);
    expect((await store.getEntry('old'))!.state).toBe('incomplete');
    expect((await store.getEntry('old'))!.warnings).toContain('navigated');
    expect((await store.getEntry('cur'))!.state).toBe('pending');
    expect((await store.getEntry('other-tab'))!.state).toBe('pending');
  });

  it('searches captured body text', async () => {
    const { store } = await openStore();
    await store.upsertEntry(
      entry({ id: 'a' }),
      { id: 'a', response: { kind: 'json', text: '{"code":"OUT_OF_STOCK"}' } },
      'end',
    );
    await store.upsertEntry(
      entry({ id: 'b' }),
      { id: 'b', request: { kind: 'json', text: '{"q":"other"}' } },
      'end',
    );
    expect([...(await store.searchBodies(new Set(['a', 'b']), 'out_of_stock'))]).toEqual(['a']);
  });

  it('caps timeline events', async () => {
    const { store } = await openStore();
    for (let i = 0; i < 120; i++) {
      await store.putTimeline({
        id: `t${i}`,
        sessionId: 's',
        tabId: 1,
        origin: 'o',
        pageId: '',
        pageUrl: '',
        kind: 'click',
        timestamp: i,
        message: '',
      });
    }
    await store.enforceTimelineRetention(100);
    const list = await store.listTimeline();
    expect(list.length).toBe(90);
    expect(list[0]!.id).toBe('t30');
  });
});

describe('planEviction', () => {
  it('returns nothing when under limits', () => {
    expect(
      planEviction(
        [{ id: 'a', bytes: 1 }],
        { entryCount: 1, totalBytes: 1 },
        { maxEntries: 10, maxBytes: 10 },
      ),
    ).toEqual([]);
  });
});
