import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingController } from '../../src/background/recording';
import { checkRecordableUrl } from '../../src/background/url-policy';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { EntryStore } from '../../src/storage/database';
import { entry } from '../helpers/entries';
import { installFakeChrome } from '../helpers/fake-chrome';

let store: EntryStore;
let fake: ReturnType<typeof installFakeChrome>;
let controller: RecordingController;
let broadcasts = 0;
let n = 0;

beforeEach(async () => {
  fake = installFakeChrome({ grantedPatterns: ['http://localhost/*'] });
  store = await EntryStore.open(`rec-${++n}`);
  broadcasts = 0;
  controller = new RecordingController(
    store,
    async () => DEFAULT_SETTINGS,
    () => broadcasts++,
  );
});
afterEach(() => store.close());

describe('RecordingController', () => {
  it('starts recording: creates a session, registers early scripts, injects into the open page', async () => {
    const result = await controller.start(5, 'http://localhost:5173/shop');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session).toMatchObject({ tabId: 5, origin: 'http://localhost:5173' });
    expect(await controller.get(5)).toMatchObject({
      sessionId: result.session.id,
      origin: 'http://localhost:5173',
    });

    const main = fake.registered.get('dc-main-world')!;
    expect(main).toMatchObject({ world: 'MAIN', runAt: 'document_start', matches: ['http://localhost/*'] });
    expect(fake.registered.get('dc-bridge')).toMatchObject({ runAt: 'document_start' });
    expect(fake.executed.map((e) => e.files[0])).toEqual(['main-world.js', 'content-script.js']);
    expect(fake.badges.get(5)).toBe('REC');
    expect(fake.tabMessages[0]).toMatchObject({
      tabId: 5,
      message: { type: 'recording-state', recording: true },
    });
    expect(broadcasts).toBe(1);
  });

  it('refuses without host permission and on restricted pages', async () => {
    expect(await controller.start(1, 'https://example.com/')).toMatchObject({
      ok: false,
      reason: 'permission-required',
    });
    expect(await controller.start(1, 'chrome://extensions')).toMatchObject({
      ok: false,
      reason: 'restricted-url',
    });
    expect(await controller.start(1, 'https://chromewebstore.google.com/detail/x')).toMatchObject({
      ok: false,
      reason: 'restricted-url',
    });
    expect(fake.registered.size).toBe(0);
  });

  it('is idempotent for the same tab and origin', async () => {
    const a = await controller.start(5, 'http://localhost:5173/');
    const b = await controller.start(5, 'http://localhost:5173/other');
    expect(a.ok && b.ok && a.session.id === b.session.id).toBe(true);
  });

  it('stops recording: ends the session, marks pending requests incomplete, unregisters scripts', async () => {
    const started = await controller.start(5, 'http://localhost:5173/');
    if (!started.ok) throw new Error('start failed');
    await store.upsertEntry(
      entry({ id: 'p', sessionId: started.session.id, state: 'pending' }),
      undefined,
      'start',
    );
    await controller.stop(5);
    expect(await controller.get(5)).toBeNull();
    expect((await store.getSession(started.session.id))!.endedAt).toBeDefined();
    expect((await store.getEntry('p'))!.state).toBe('incomplete');
    expect(fake.registered.size).toBe(0);
    expect(fake.badges.get(5)).toBe('');
    expect(fake.tabMessages.at(-1)).toMatchObject({
      message: { recording: false, config: { enabled: false } },
    });
    const kinds = (await store.listTimeline({ sessionId: started.session.id })).map((t) => t.message);
    expect(kinds).toEqual(['Recording started', 'Recording stopped']);
  });

  it('keeps scripts registered while another tab still records the same host', async () => {
    await controller.start(1, 'http://localhost:3000/');
    await controller.start(2, 'http://localhost:3000/');
    await controller.stop(1);
    expect(fake.registered.get('dc-main-world')!.matches).toEqual(['http://localhost/*']);
  });
});

describe('url policy', () => {
  it('builds port-less match patterns', () => {
    expect(checkRecordableUrl('http://localhost:5173/a?b')).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
      pattern: 'http://localhost/*',
    });
    expect(checkRecordableUrl('file:///C:/x.html').ok).toBe(false);
    expect(checkRecordableUrl(undefined).ok).toBe(false);
  });
});
