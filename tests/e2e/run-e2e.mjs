// End-to-end verification in a real Chrome (Chrome for Testing via Puppeteer).
// Loads dist-e2e/ (built with `npm run build:e2e`, which pre-grants
// http://127.0.0.1/* so no permission prompt needs to be clicked), drives the
// local test page and reads what the extension persisted in IndexedDB.
//
//   npm run test:e2e            (headless)
//   HEADFUL=1 npm run test:e2e  (visible browser)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { startMockServer } from '../../test-page/mock-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const extensionPath = resolve(root, 'dist-e2e');
const artifacts = resolve(root, process.env.E2E_ARTIFACTS ?? '.e2e-profile/artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        ${err?.message ?? err}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Fail rather than hang if Chrome or a step stalls.
const watchdog = setTimeout(() => {
  console.log('E2E watchdog: suite exceeded 5 minutes');
  process.exit(3);
}, 300_000);
watchdog.unref();

const server = await startMockServer(0);
const origin = `http://127.0.0.1:${server.address().port}`;
await rm(resolve(root, '.e2e-profile/user-data'), { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const browser = await puppeteer.launch({
  // Defaults to Puppeteer's Chrome for Testing; set CHROME_PATH to use an installed Chrome.
  executablePath: process.env.CHROME_PATH || undefined,
  headless: !process.env.HEADFUL,
  pipe: true,
  protocolTimeout: 30_000,
  enableExtensions: [extensionPath],
  userDataDir: resolve(root, '.e2e-profile/user-data'),
  args: ['--no-first-run', '--no-default-browser-check'],
});

const pageErrors = [];
try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/service-worker.js'),
    {
      timeout: 15_000,
    },
  );
  const extId = new URL(swTarget.url()).host;
  console.log(`Extension loaded: ${extId}\nTest page: ${origin}/\n`);

  const app = await browser.newPage();
  // DOM click: works while the test page is a background tab (page.click waits for a frame).
  const click = (selector) => app.$eval(selector, (el) => el.click());
  await app.goto(`${origin}/`);
  await app.waitForFunction(() => document.getElementById('log').textContent.includes('init loaded'));

  const ext = await browser.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`extension page: ${e.message}`));
  await ext.goto(`chrome-extension://${extId}/dashboard.html`);

  const readDb = () =>
    ext.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('dev-companion');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = (name) =>
        new Promise((res) => {
          const r = db.transaction(name).objectStore(name).getAll();
          r.onsuccess = () => res(r.result);
        });
      const out = {
        entries: await all('entries'),
        bodies: await all('bodies'),
        timeline: await all('timeline'),
        sessions: await all('sessions'),
      };
      db.close();
      return out;
    });
  const waitForEntry = async (predicate, label, timeout = 8000) => {
    const start = Date.now();
    for (;;) {
      const db = await readDb();
      const found = db.entries.filter(predicate);
      if (found.length) return { entry: found.at(-1), all: found, db };
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
      await sleep(150);
    }
  };
  const bodyOf = (db, id) => db.bodies.find((b) => b.id === id);
  const tabRequest = (type, extra = {}) =>
    ext.evaluate(
      async (type, extra, prefix) => {
        const [tab] = await chrome.tabs.query({ url: `${prefix}/*` });
        return chrome.runtime.sendMessage({ type, tabId: tab.id, url: tab.url, ...extra });
      },
      type,
      extra,
      'http://127.0.0.1',
    );

  // --- Recording off: nothing is captured --------------------------------------
  await check('Nothing is captured before recording starts', async () => {
    await click('#products');
    await sleep(500);
    const db = await readDb();
    assert(db.entries.length === 0, `expected 0 entries, got ${db.entries.length}`);
  });

  let sessionId;
  await check('Recording starts for the tab (permission pre-granted in E2E build)', async () => {
    const result = await tabRequest('start-recording');
    assert(result?.ok, `start failed: ${JSON.stringify(result)}`);
    assert(result.injected, 'recorder was not injected into the open page');
    sessionId = result.session.id;
  });

  await check(
    'Late injection leaves console untouched (wrapping it would put the recorder above framework patches)',
    async () => {
      const native = await app.evaluate(
        () =>
          console.error.toString().includes('[native code]') &&
          console.warn.toString().includes('[native code]'),
      );
      assert(native, 'console was wrapped in an already-loaded page');
    },
  );

  await check('Short-lived POST /api/orders (422) is captured with payload and response', async () => {
    await click('#order-stock');
    const { entry, db } = await waitForEntry(
      (e) => e.method === 'POST' && e.url.endsWith('/api/orders') && e.state === 'complete',
      'order',
    );
    assert(entry.status === 422, `status ${entry.status}`);
    assert(entry.sessionId === sessionId, 'wrong session');
    assert(entry.duration >= 0, 'no duration');
    const b = bodyOf(db, entry.id);
    assert(b?.request?.text?.includes('"quantity":5'), 'request body missing');
    assert(b?.response?.text?.includes('OUT_OF_STOCK'), 'response body missing');
    assert(entry.initiatorStack?.length > 0, 'no initiator stack');
  });

  await check('XHR POST is captured', async () => {
    await click('#xhr-order');
    const { entry, db } = await waitForEntry((e) => e.source === 'xhr' && e.method === 'POST', 'xhr');
    assert(entry.status === 422, `status ${entry.status}`);
    assert(bodyOf(db, entry.id)?.request?.text?.includes('"quantity":9'), 'xhr body');
  });

  await check('XHR responseType=json and sendBeacon are captured', async () => {
    await click('#xhr-json');
    await click('#beacon');
    const { entry } = await waitForEntry((e) => e.source === 'xhr' && e.method === 'GET', 'xhr json');
    assert(entry.responseBodyKind === 'json', `kind ${entry.responseBodyKind}`);
    await waitForEntry((e) => e.source === 'beacon', 'beacon');
  });

  await check('HTTP 500, network failure, abort and timeout are recorded distinctly', async () => {
    await click('#error');
    await click('#drop');
    await click('#abort');
    await click('#timeout');
    await waitForEntry((e) => e.url.endsWith('/api/error') && e.status === 500, '500');
    await waitForEntry((e) => e.url.endsWith('/api/drop') && e.state === 'error', 'network error');
    await waitForEntry((e) => e.url.endsWith('/api/hang') && e.state === 'aborted', 'aborted');
    await waitForEntry((e) => e.url.endsWith('/api/hang?t') && e.state === 'timeout', 'timeout');
  });

  await check('Page behavior is preserved (page still reads full bodies, sees errors)', async () => {
    await click('#large');
    await click('#binary');
    await app.waitForFunction(() =>
      document.getElementById('log').textContent.includes('1572864 chars read by page'),
    );
    await app.waitForFunction(() => document.getElementById('log').textContent.includes('binary 8 bytes'));
    const log = await app.$eval('#log', (el) => el.textContent);
    assert(log.includes('AbortError'), 'page did not see AbortError');
    assert(log.includes('TypeError'), 'page did not see network TypeError');
  });

  await check('Large bodies are truncated with a warning; binary bodies are not stored', async () => {
    const large = await waitForEntry((e) => e.url.endsWith('/api/large') && e.state === 'complete', 'large');
    assert(
      large.entry.warnings.some((w) => /truncat/i.test(w)),
      'no truncation warning',
    );
    assert(bodyOf(large.db, large.entry.id).response.text.length <= 1024 * 1024, 'body not truncated');
    const bin = await waitForEntry((e) => e.url.endsWith('/api/binary') && e.state === 'complete', 'binary');
    assert(bodyOf(bin.db, bin.entry.id).response.kind === 'binary', 'binary kind');
  });

  await check('Redirects are recorded', async () => {
    await click('#redirect');
    const { entry } = await waitForEntry(
      (e) => e.url.endsWith('/api/redirect') && e.state === 'complete',
      'redirect',
    );
    assert(entry.redirected && entry.finalUrl.endsWith('/api/products'), JSON.stringify(entry.finalUrl));
  });

  await check('Secrets are removed before storage (headers, query, body, response token)', async () => {
    await click('#login');
    const { entry, db } = await waitForEntry((e) => e.url.includes('/api/login'), 'login');
    const raw = JSON.stringify([entry, bodyOf(db, entry.id)]);
    for (const secret of ['header-secret-789', 'key-secret-456', 'hunter2-body', 'tok-secret-123']) {
      assert(!raw.includes(secret), `${secret} was stored`);
    }
    assert(raw.includes('ada@example.com'), 'non-secret data missing');
    assert(entry.redactions >= 4, `redactions ${entry.redactions}`);
  });

  await check('Secrets in the page URL are not stored in initiator stacks or timeline events', async () => {
    // OAuth-style callback: the token appears in the document URL, which Chrome puts in stack frames.
    const secret = 'url-secret-555';
    await app.goto(`${origin}/?access_token=${secret}&state=1`);
    await app.waitForFunction(() => document.getElementById('log').textContent.includes('init loaded'));
    await app.evaluate(() => history.pushState({}, '', '/after-login'));
    const { db } = await waitForEntry(
      (e) => e.url.endsWith('/api/init') && e.pageUrl.includes('state=1'),
      '/api/init on callback page',
    );
    await sleep(800); // let the route-change timeline event arrive
    const after = await readDb();
    const raw = JSON.stringify([after.entries, after.timeline, after.bodies]);
    assert(
      db.entries.some((e) => e.initiatorStack?.includes('state=1')),
      'stack has no page URL (test is moot)',
    );
    assert(!raw.includes(secret), 'URL secret was stored');
    await app.goto(`${origin}/`);
    await app.waitForFunction(() => document.getElementById('log').textContent.includes('init loaded'));
  });

  await check(
    'Console errors, uncaught errors, rejections, route changes, clicks and form submits reach the timeline (no form values)',
    async () => {
      // Console capture is installed at document_start, so load the page with recording on.
      await app.reload();
      await app.waitForFunction(() => document.getElementById('log').textContent.includes('init loaded'));
      await click('#console-error');
      await click('#throw');
      await click('#reject');
      await click('#route');
      await click('#submit-form');
      await sleep(800);
      const db = await readDb();
      const kinds = new Set(db.timeline.map((t) => t.kind));
      for (const k of [
        'console-error',
        'js-error',
        'unhandled-rejection',
        'route-change',
        'click',
        'form-submit',
        'recording',
      ]) {
        assert(kinds.has(k), `missing timeline kind ${k}`);
      }
      assert(!JSON.stringify(db.timeline).includes('hunter2-form'), 'form value leaked into timeline');
      // #route pushed /orders/<n>; restore "/" so the reload below reloads the test page.
      await app.evaluate(() => history.replaceState({}, '', '/'));
    },
  );

  await check('Markers can be added', async () => {
    const res = await tabRequest('add-marker', { label: 'before reload' });
    assert(res.ok, JSON.stringify(res));
  });

  await check(
    'History persists across reload, and page-load requests are captured after reload',
    async () => {
      const before = (await readDb()).entries.length;
      const reloadedAt = Date.now();
      await app.reload();
      const { db } = await waitForEntry(
        (e) => e.url.endsWith('/api/init') && e.startedAt >= reloadedAt,
        '/api/init after reload',
      );
      assert(db.entries.length > before, 'no new entries after reload');
      assert(
        db.entries.some((e) => e.url.endsWith('/api/orders')),
        'earlier entries lost',
      );
      assert(
        db.timeline.some((t) => t.kind === 'page-load'),
        'no page-load event',
      );
    },
  );

  await check('In-flight requests are marked incomplete when the page navigates', async () => {
    await click('#slow');
    await sleep(300);
    await click('#nav');
    await app.waitForSelector('h1');
    const { entry } = await waitForEntry(
      (e) => e.url.endsWith('/api/slow') && e.state === 'incomplete',
      'incomplete slow request',
    );
    assert(
      entry.warnings.some((w) => /navigated/.test(w)),
      'no navigation warning',
    );
    await waitForEntry(
      (e) => e.pageUrl.endsWith('/page2') && e.url.endsWith('/api/products'),
      'page2 init request',
    );
    await app.goto(`${origin}/`);
  });

  await check('Starting again in the same document does not double-instrument', async () => {
    await tabRequest('start-recording'); // same tab/origin: idempotent, re-injection is guarded
    await app.evaluate(() => fetch('/api/products?dup-check=1'));
    await sleep(800);
    const db = await readDb();
    const n = db.entries.filter((e) => e.url.includes('dup-check=1')).length;
    assert(n === 1, `expected 1 entry, got ${n}`);
  });

  await check('Request explorer UI lists, searches (incl. body text) and shows details', async () => {
    await ext.bringToFront();
    await ext.goto(`chrome-extension://${extId}/dashboard.html?session=${sessionId}#network`);
    await ext.waitForSelector('.row');
    await ext.type('input.search', 'OUT_OF_STOCK');
    await ext.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.request-list .row')];
      return rows.length > 0 && rows.every((r) => r.textContent.includes('/api/orders'));
    });
    await ext.click('.request-list .row');
    await ext.waitForSelector('.details');
    const tabs = await ext.$$('.details .tab');
    for (const t of tabs) if ((await t.evaluate((el) => el.textContent)) === 'Response') await t.click();
    await ext.waitForFunction(() =>
      document.querySelector('.details .code')?.textContent.includes('OUT_OF_STOCK'),
    );
    await ext.screenshot({ path: resolve(artifacts, 'explorer.png') });
  });

  await check('Investigations → Findings renders evidence-based findings', async () => {
    const tabs = await ext.$$('.tabs > .tab');
    for (const t of tabs)
      if ((await t.evaluate((el) => el.textContent)) === 'Investigations') await t.click();
    await ext.waitForSelector('.finding');
    const text = await ext.$eval('.findings', (el) => el.textContent);
    assert(
      text.includes('422') && text.includes('Insufficient stock'),
      'missing 422 finding with server message',
    );
    assert(text.includes('Limitations'), 'no limitations section');
    assert(text.includes('Confirmed'), 'no evidence level shown');
    await ext.screenshot({ path: resolve(artifacts, 'detective.png'), fullPage: true });
  });

  await check('Timeline view renders correlated events', async () => {
    const tabs = await ext.$$('.tabs > .tab');
    for (const t of tabs) if ((await t.evaluate((el) => el.textContent)) === 'Timeline') await t.click();
    await ext.waitForSelector('.tl-row');
    await ext.screenshot({ path: resolve(artifacts, 'timeline.png') });
  });

  await check('JSON export downloads redacted data', async () => {
    const tabs = await ext.$$('.tabs > .tab');
    for (const t of tabs)
      if ((await t.evaluate((el) => el.textContent)).startsWith('Network')) await t.click();
    await ext.waitForSelector('.row');
    const client = await ext.createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts });
    const [exportBtn] = await ext.$$('xpath/.//button[contains(., "Export")]');
    await exportBtn.click();
    await ext.waitForSelector('.modal');
    const [download] = await ext.$$('xpath/.//button[contains(., "Download")]');
    await download.click();
    const { readdir, readFile } = await import('node:fs/promises');
    let file;
    for (let i = 0; i < 40 && !file; i++) {
      await sleep(150);
      file = (await readdir(artifacts)).find((f) => f.startsWith('dev-companion-') && f.endsWith('.json'));
    }
    assert(file, 'export file not downloaded');
    const text = await readFile(resolve(artifacts, file), 'utf8');
    const bundle = JSON.parse(text);
    assert(bundle.format === 'dev-companion-session' && bundle.entries.length > 5, 'unexpected export');
    for (const secret of [
      'header-secret-789',
      'key-secret-456',
      'hunter2-body',
      'tok-secret-123',
      'hunter2-form',
    ]) {
      assert(!text.includes(secret), `${secret} exported`);
    }
  });

  await check('Toolbar popup shows the recording tab and reports a failed marker as failed', async () => {
    await app.bringToFront();
    const extension = (await browser.extensions()).get(extId);
    await app.triggerExtensionAction(extension);
    const target = await browser.waitForTarget((t) => t.url().endsWith('/popup.html'), { timeout: 5000 });
    const popup = await target.asPage();
    popup.on('pageerror', (e) => pageErrors.push(`toolbar popup: ${e.message}`));
    await popup.waitForSelector('.rec-dot');
    const shown = await popup.$eval('.origin', (el) => el.textContent);
    assert(shown === origin, `popup shows ${shown}`);
    // Drop the recording state without a broadcast, so the popup still offers "Add marker".
    const saved = await ext.evaluate(() => chrome.storage.session.get('recordingTabs'));
    await ext.evaluate(() => chrome.storage.session.set({ recordingTabs: {} }));
    await popup.type('.marker-row input', 'should fail');
    await popup.click('.marker-row button');
    await popup.waitForSelector('.notice-error');
    const notices = await popup.$$eval('.notice', (els) => els.map((el) => el.textContent).join(' | '));
    await ext.evaluate((s) => chrome.storage.session.set(s), saved);
    await popup.close();
    await ext.bringToFront(); // later checks accept confirm() dialogs, which background tabs defer
    assert(/Marker not added/.test(notices) && !/Marker added/.test(notices), notices);
  });

  await check('Stopping recording stops capture; stored history remains', async () => {
    const before = (await readDb()).entries.length;
    await tabRequest('stop-recording');
    await click('#products');
    await sleep(800);
    const db = await readDb();
    assert(db.entries.length === before, `captured after stop (${before} -> ${db.entries.length})`);
    assert(db.sessions.find((s) => s.id === sessionId)?.endedAt, 'session not ended');
  });

  await check('Clearing the session deletes its requests', async () => {
    await ext.goto(`chrome-extension://${extId}/dashboard.html?session=${sessionId}#network`);
    await ext.waitForSelector('.row');
    const [clear] = await ext.$$('xpath/.//button[contains(., "Clear session")]');
    await clear.click();
    // In-app confirmation dialog (no window.confirm).
    await ext.waitForSelector('.modal');
    const [confirmBtn] = await ext.$$('xpath/.//button[contains(., "Delete session data")]');
    await confirmBtn.click();
    await ext.waitForSelector('.empty');
    const db = await readDb();
    assert(db.entries.filter((e) => e.sessionId === sessionId).length === 0, 'entries remain');
  });

  await check('Popup page renders without errors', async () => {
    const popup = await browser.newPage();
    popup.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('.popup-root');
    await popup.close();
  });

  await check('No uncaught errors in extension pages', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  // /api/hang keeps connections open; close them so the process can exit.
  server.closeAllConnections();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} E2E checks passed. Screenshots: ${artifacts}`,
);
process.exit(failed.length ? 1 : 0);
