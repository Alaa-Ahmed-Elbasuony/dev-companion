// Advanced capture (chrome.debugger / CDP) E2E checks in a real Chrome:
// deduplication against main-world capture, SSE events the page does not
// subscribe to, document navigation metadata, and clean detach.
//
//   npm run build:e2e && node tests/e2e/run-e2e-cdp.mjs
import { startMockServer } from '../../test-page/mock-server.mjs';
import {
  assert,
  createReporter,
  launchWithExtension,
  readDb,
  sleep,
  tabRequest,
  waitForDb,
  watchdog,
} from './harness.mjs';

watchdog(240_000, 'CDP E2E');
const { check, summary } = createReporter();
const STORES = ['entries', 'timeline', 'sessions', 'rt-connections', 'rt-messages'];

const server = await startMockServer(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const { browser, extId } = await launchWithExtension('user-data-cdp');
const pageErrors = [];
try {
  const app = await browser.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${origin}/realtime`);
  const ext = await browser.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`extension page: ${e.message}`));
  await ext.goto(`chrome-extension://${extId}/dashboard.html`);
  await app.bringToFront();
  const click = async (id, wait = 300) => {
    await app.$eval(`#${id}`, (el) => el.click());
    await sleep(wait);
  };
  const db = () => readDb(ext, STORES);
  const waitDb = (predicate, label, timeout) => waitForDb(ext, STORES, predicate, label, timeout);
  let sessionId;

  await check('Advanced capture is refused unless the tab is recording', async () => {
    const r = await tabRequest(ext, 'http://127.0.0.1', 'set-advanced-capture', { enabled: true });
    assert(r && !r.ok && r.reason === 'not-recording', JSON.stringify(r));
  });

  await check('Advanced capture attaches to a recording tab', async () => {
    const start = await tabRequest(ext, 'http://127.0.0.1', 'start-recording');
    assert(start.ok, JSON.stringify(start));
    sessionId = start.session.id;
    const r = await tabRequest(ext, 'http://127.0.0.1', 'set-advanced-capture', { enabled: true });
    assert(r?.ok && r.attached, JSON.stringify(r));
    const state = await tabRequest(ext, 'http://127.0.0.1', 'get-tab-state');
    assert(state.recording.advanced === true, 'advanced flag not set');
  });

  await check('Document navigation metadata (status, headers, timing) comes from CDP', async () => {
    await app.reload();
    await app.waitForFunction(() => typeof window.io === 'function');
    const { value } = await waitDb(
      (d) =>
        d.timeline.find((e) => e.kind === 'navigation' && e.source === 'cdp' && e.sessionId === sessionId),
      'navigation event',
    );
    assert(value.data.status === 200, JSON.stringify(value.data));
    assert(value.data['header.content-type']?.includes('text/html'), 'content-type header missing');
  });

  await check('Frames seen by both mechanisms are stored once, with both sources', async () => {
    await click('ws-connect', 600);
    await click('ws-send-json', 400);
    await click('ws-binary-out', 300);
    await click('ws-binary-in', 600);
    const { value } = await waitDb(
      (d) => {
        const conns = d['rt-connections'].filter((c) => c.sessionId === sessionId && c.url.endsWith('/ws'));
        if (conns.length !== 1) return null;
        const msgs = d['rt-messages'].filter(
          (m) => m.connectionId === conns[0].id && m.opcode !== 'lifecycle',
        );
        const merged = msgs.filter((m) => m.sources.includes('cdp') && m.sources.includes('main-world'));
        return merged.length >= 5 && { conn: conns[0], msgs, merged };
      },
      'merged frames',
      10_000,
    );
    assert(
      value.conn.sources.includes('cdp') && value.conn.sources.includes('main-world'),
      JSON.stringify(value.conn.sources),
    );
    assert(value.conn.aliases?.length === 1, `aliases ${JSON.stringify(value.conn.aliases)}`);
    // Every payload once: welcome, echo of JSON, binary out, binary echo, binary 16.
    const keys = value.msgs.map((m) => `${m.direction}|${m.opcode}|${m.size}|${m.text ?? ''}`);
    assert(new Set(keys).size === keys.length, `duplicate frames stored:\n${keys.join('\n')}`);
    assert(
      value.msgs.every((m) => m.sources.length === 2),
      value.msgs.map((m) => m.sources.join('+')).join(','),
    );
  });

  await check(
    'SSE events the page never subscribes to are visible only through advanced capture',
    async () => {
      await click('sse-open', 1500);
      await click('sse-close', 200);
      const { value } = await waitDb(
        (d) => {
          const conn = d['rt-connections'].find(
            (c) => c.sessionId === sessionId && c.transport === 'eventsource',
          );
          const msgs = conn && d['rt-messages'].filter((m) => m.connectionId === conn.id);
          const audit = msgs?.find((m) => m.sse?.type === 'audit');
          const hello = msgs?.find((m) => m.sse?.type === 'hello');
          return audit && hello && { audit, hello, conn };
        },
        'SSE audit event',
        8000,
      );
      assert(value.audit.sources.join() === 'cdp', `audit sources ${value.audit.sources}`);
      assert(
        value.hello.sources.includes('main-world') && value.hello.sources.includes('cdp'),
        'hello not merged',
      );
      assert(
        value.conn.sources.includes('cdp') && value.conn.sources.includes('main-world'),
        'SSE connection not merged',
      );
    },
  );

  await check(
    'Turning advanced capture off detaches and records it; main-world capture continues',
    async () => {
      const r = await tabRequest(ext, 'http://127.0.0.1', 'set-advanced-capture', { enabled: false });
      assert(r?.ok, JSON.stringify(r));
      const state = await tabRequest(ext, 'http://127.0.0.1', 'get-tab-state');
      assert(!state.recording.advanced, 'flag still set');
      const detachedAt = Date.now();
      await click('ws-send-json', 600);
      const d = await db();
      const fresh = d['rt-messages'].filter((m) => m.timestamp > detachedAt);
      assert(
        fresh.length > 0 && fresh.every((m) => m.sources.join() === 'main-world'),
        'unexpected sources after detach',
      );
      assert(
        d.timeline.some((e) => e.kind === 'capture' && /turned off/.test(e.message)),
        'detach not recorded',
      );
    },
  );

  await check('No uncaught errors in the app or extension pages', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

process.exit(summary('CDP E2E') ? 1 : 0);
