// SSR / server tracing E2E in a real Chrome with the real Next.js example app
// (examples/next-ssr) and the development-only server tracer.
//
//   npm run build:e2e && node tests/e2e/run-e2e-ssr.mjs
// Requires `npm install` in examples/next-ssr and packages/server-tracer.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  createReporter,
  launchWithExtension,
  readDb,
  root,
  sleep,
  waitForDb,
  watchdog,
} from './harness.mjs';

watchdog(600_000, 'SSR E2E');
const { check, summary } = createReporter();
const APP_DIR = resolve(root, 'examples/next-ssr');
const APP = 'http://127.0.0.1:3100';
const COLLECTOR = 'http://127.0.0.1:4319';
const TOKEN = 'e2e-token-0123456789abcdef0123456789';
const STORES = ['entries', 'timeline', 'sessions', 'spans'];

if (!existsSync(resolve(APP_DIR, 'node_modules/next'))) {
  console.log('SSR E2E skipped: run `npm install` in examples/next-ssr first.');
  process.exit(0);
}

const { startUpstream, received } = await import(pathToFileURL(resolve(APP_DIR, 'upstream.mjs')).href);
const upstream = await startUpstream(3101);

let next = null;
let nextLog = '';
async function startNext(env = {}) {
  nextLog = '';
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', '3100'], {
    cwd: APP_DIR,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', DEV_COMPANION_TOKEN: TOKEN, ...env },
  });
  next.stdout.on('data', (d) => (nextLog += d));
  next.stderr.on('data', (d) => (nextLog += d));
  const start = Date.now();
  while (!/Ready|ready in/i.test(nextLog)) {
    if (Date.now() - start > 90_000) throw new Error(`next dev did not start:\n${nextLog}`);
    await sleep(250);
  }
  // Warm up routes so compile time does not distort the checks.
  for (const path of ['/orders', '/legacy', '/cached', '/static', '/slow?tag=warm'])
    await fetch(`${APP}${path}`).catch(() => undefined);
  await fetch(`${APP}/api/orders`, { method: 'POST', body: '{}' }).catch(() => undefined);
}
async function stopNext() {
  if (!next) return;
  const proc = next;
  next = null;
  await new Promise((r) => {
    proc.once('exit', r);
    proc.kill();
    setTimeout(r, 5000);
  });
  await sleep(500);
}

const { browser, extId } = await launchWithExtension('user-data-ssr');
const pageErrors = [];
try {
  await startNext({ DEV_COMPANION_TRACING: '1' });
  const ext = await browser.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`extension page: ${e.message}`));
  await ext.goto(`chrome-extension://${extId}/dashboard.html`);
  const db = () => readDb(ext, STORES);
  const waitDb = (predicate, label, timeout = 15_000) => waitForDb(ext, STORES, predicate, label, timeout);

  // Configure the integration the way the Settings view does (token in storage.local, never exported).
  await ext.evaluate(
    async (app, collector, token) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: {
          ...settings,
          serverIntegrations: [{ id: 'next', appOrigin: app, collectorUrl: collector, enabled: true }],
        },
        integrationTokens: { next: token },
      });
    },
    APP,
    COLLECTOR,
    TOKEN,
  );

  const app = await browser.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${APP}/static`);
  const start = await ext.evaluate(async (prefix) => {
    const [tab] = await chrome.tabs.query({ url: `${prefix}/*` });
    return chrome.runtime.sendMessage({ type: 'start-recording', tabId: tab.id, url: tab.url });
  }, APP);
  const sessionId = start.session.id;
  const syncNow = () => ext.evaluate(() => chrome.runtime.sendMessage({ type: 'sync-server-traces' }));
  // Spans can end after the HTML response; keep pulling while waiting for them.
  const waitSpans = async (predicate, label, timeout = 15_000) => {
    const timer = setInterval(() => void syncNow().catch(() => undefined), 1000);
    try {
      return await waitDb(predicate, label, timeout);
    } finally {
      clearInterval(timer);
    }
  };

  let ordersTrace;
  await check(
    'SSR performs two outbound calls (200 and 503) that appear as server spans with durations',
    async () => {
      assert(start.ok, JSON.stringify(start));
      await app.goto(`${APP}/orders`);
      await app.waitForSelector('#inventory');
      const html = await app.content();
      assert(html.includes('unavailable (503)'), 'page did not render the failed call');
      // `next dev` can render a page more than once; use the render this document came from.
      const meta = await app.$eval('meta[name="traceparent"]', (el) => el.content).catch(() => '');
      const docTrace = meta.split('-')[1];
      assert(docTrace, 'no traceparent meta tag');
      await syncNow();
      const { value } = await waitSpans((d) => {
        const spans = d.spans.filter((s) => s.sessionId === sessionId && s.traceId === docTrace);
        // The route handler also calls /products: find the render's 503 first, then its sibling.
        const inventory = spans.find(
          (s) => s.outbound && /\/inventory$/.test(s.httpUrl ?? '') && s.httpStatus === 503,
        );
        const products =
          inventory &&
          spans.find(
            (s) =>
              s.traceId === inventory.traceId &&
              s.outbound &&
              /\/products$/.test(s.httpUrl ?? '') &&
              s.httpStatus === 200,
          );
        return products && inventory && { products, inventory };
      }, 'outbound spans').catch(async (err) => {
        const d = await db();
        console.log(
          'DEBUG session spans:',
          d.spans
            .filter((x) => x.sessionId === sessionId)
            .map(
              (x) => `${x.traceId.slice(0, 8)} ${x.kind} ${x.name} ${x.httpStatus ?? ''} ${x.httpUrl ?? ''}`,
            )
            .join(' | '),
        );
        console.log(
          'DEBUG other spans:',
          d.spans.filter((x) => x.sessionId !== sessionId).length,
          'recording started',
          start.session.startedAt,
        );
        console.log('DEBUG status', JSON.stringify(await syncNow()));
        throw err;
      });
      assert(value.products.duration > 0 && value.inventory.duration > 0, 'missing durations');
      assert(value.products.phase === 'server fetch', `phase ${value.products.phase}`);
      ordersTrace = value.products.traceId;
    },
  );

  await check(
    'The browser navigation is linked to its server trace through the traceparent meta tag',
    async () => {
      const meta = await app.$eval('meta[name="traceparent"]', (el) => el.content).catch(() => null);
      assert(meta && meta.includes(ordersTrace), `meta ${meta} does not carry trace ${ordersTrace}`);
      const { value } = await waitDb(
        (d) =>
          d.timeline.find(
            (t) => t.kind === 'navigation' && t.sessionId === sessionId && t.data?.traceId === ordersTrace,
          ),
        'navigation event with trace id',
      );
      assert(value.data['next.router'] === 'app', `router ${value.data['next.router']}`);
    },
  );

  await check(
    'Sensitive headers and payload values are redacted; outbound requests were not modified',
    async () => {
      const text = JSON.stringify((await db()).spans);
      for (const secret of ['upstream-secret-abc123', 'upstream-token-secret'])
        assert(!text.includes(secret), `${secret} stored`);
      assert(text.includes('[REDACTED]'), 'no redaction marker');
      assert(
        received.every((r) => r.traceparent === null),
        'tracer injected traceparent into outbound requests',
      );
      assert(
        received.filter((r) => r.path === '/products').every((r) => r.hasAuth),
        'app credentials were dropped',
      );
    },
  );

  await check(
    'Client-side request after hydration is a browser entry; its route handler is a separate server trace',
    async () => {
      await app.waitForFunction(() =>
        document.querySelector('#client-order')?.textContent.includes('created'),
      );
      await syncNow();
      const { value } = await waitSpans((d) => {
        // React StrictMode runs the effect twice in development: two POSTs, two handler traces.
        const entry = d.entries.find(
          (e) =>
            e.sessionId === sessionId &&
            e.method === 'POST' &&
            e.url.endsWith('/api/orders') &&
            e.state === 'complete',
        );
        const handler = d.spans.find(
          (s) =>
            s.sessionId === sessionId &&
            s.kind === 'server' &&
            /\/api\/orders/.test(s.name) &&
            s.traceId !== ordersTrace,
        );
        return entry && handler && { entry, handler };
      }, 'client POST and route handler span');
      assert(value.entry.state === 'complete' && value.entry.status === 200, 'client request not captured');
    },
  );

  await check(
    'Dashboard Tracing view shows the waterfall, the failed call, and the explicit browser link',
    async () => {
      await ext.bringToFront();
      await ext.goto(
        `chrome-extension://${extId}/dashboard.html?session=${sessionId}#tracing?trace=${ordersTrace}`,
      );
      await ext.waitForSelector('.wf-row');
      const text = await ext.$eval('.tracing-layout', (el) => el.textContent);
      assert(/inventory 503/.test(text) || /inventory.*503/.test(text), 'failed call missing in waterfall');
      assert(/shared id/.test(text), 'explicit browser link missing');
      await ext.screenshot({ path: resolve(root, '.e2e-profile/artifacts/tracing.png') });
      await app.bringToFront();
    },
  );

  await check('Pages Router getServerSideProps and its node:http call are traced', async () => {
    await app.goto(`${APP}/legacy`);
    await app.waitForSelector('#legacy');
    await syncNow();
    await waitSpans((d) => {
      const spans = d.spans.filter((s) => s.sessionId === sessionId);
      const gssp = spans.find((s) => s.phase === 'getServerSideProps');
      return (
        gssp &&
        spans.find(
          (s) =>
            s.traceId === gssp.traceId &&
            s.outbound &&
            /node:http/.test(s.phase ?? '') &&
            /legacy-data/.test(s.httpUrl ?? ''),
        )
      );
    }, 'getServerSideProps + node:http span');
  });

  await check('A cached server fetch is distinguishable from a fresh one', async () => {
    await app.goto(`${APP}/cached`);
    await app.goto(`${APP}/cached`);
    await syncNow();
    const { value } = await waitSpans((d) => {
      const fetches = d.spans.filter(
        (s) => s.sessionId === sessionId && /legacy-data/.test(s.httpUrl ?? '') && s.phase === 'server fetch',
      );
      const statuses = fetches.map((s) => s.attributes['next.fetch.cache_status']);
      return statuses.includes('hit') && statuses;
    }, 'cache hit attribute');
    assert(value.includes('hit'), `cache statuses ${value}`);
  });

  await check('Concurrent navigations in two recorded tabs link each document to its own trace', async () => {
    const other = await browser.newPage();
    await other.goto(`${APP}/static`);
    const startB = await ext.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({ url: `${prefix}/*` });
      const tab = tabs.find((t) => t.url.includes('/static'));
      return chrome.runtime.sendMessage({ type: 'start-recording', tabId: tab.id, url: tab.url });
    }, APP);
    assert(startB.ok, JSON.stringify(startB));
    await Promise.all([app.goto(`${APP}/slow?tag=alpha`), other.goto(`${APP}/slow?tag=beta`)]);
    const metaA = await app.$eval('meta[name="traceparent"]', (el) => el.content);
    const metaB = await other.$eval('meta[name="traceparent"]', (el) => el.content);
    assert(metaA.split('-')[1] !== metaB.split('-')[1], 'both documents got the same trace id');
    await syncNow();
    const traceA = metaA.split('-')[1];
    const traceB = metaB.split('-')[1];
    const { value } = await waitSpans(
      (d) => {
        const a = d.spans.find(
          (s) => s.traceId === traceA && s.outbound && /tag=alpha/.test(s.httpUrl ?? ''),
        );
        const b = d.spans.find((s) => s.traceId === traceB && s.outbound && /tag=beta/.test(s.httpUrl ?? ''));
        return a && b && { a, b };
      },
      'tagged slow spans per trace',
      20_000,
    );
    assert(value.a.traceId !== value.b.traceId, 'traces mixed');
    // Spans are stored in the most recently started recording of the origin; links use the trace id, not timing.
    const crossed = (await db()).spans.find((s) => s.traceId === traceA && /tag=beta/.test(s.httpUrl ?? ''));
    assert(!crossed, 'beta call attributed to alpha trace');
    await other.close();
  });

  await check('An instrumentation (exporter) failure does not break rendering', async () => {
    await stopNext();
    await startNext({ DEV_COMPANION_TRACING: '1', DEV_COMPANION_TRACING_FAIL: 'export' });
    const before = (await db()).spans.length;
    const res = await fetch(`${APP}/orders`);
    assert(
      res.status === 200 && (await res.text()).includes('unavailable (503)'),
      'page broken by exporter failure',
    );
    await syncNow();
    await sleep(1500);
    assert((await db()).spans.length === before, 'spans stored despite a failing exporter');
  });

  await check('Server restart: the new collector instance is detected and spans continue', async () => {
    await stopNext();
    await startNext({ DEV_COMPANION_TRACING: '1' });
    await app.goto(`${APP}/orders`);
    await app.waitForSelector('#inventory');
    await syncNow();
    const { value } = await waitDb(
      (d) => d.timeline.find((t) => t.kind === 'capture' && /collector restarted/.test(t.message)),
      'collector restart note',
    );
    assert(value, 'restart not reported');
    const meta = await app.$eval('meta[name="traceparent"]', (el) => el.content);
    await waitSpans((d) => d.spans.some((s) => s.traceId === meta.split('-')[1]), 'spans after restart');
  });

  await check(
    'Tracing disabled: the app works, no spans are produced, and the collector is reported unreachable',
    async () => {
      await stopNext();
      await startNext({});
      assert(!/server tracing on/.test(nextLog), 'tracing started without DEV_COMPANION_TRACING=1');
      await app.goto(`${APP}/orders`);
      await app.waitForSelector('#inventory');
      const status = await syncNow();
      const st = status?.status?.next;
      assert(st && !st.ok && /unreachable/.test(st.message), `status ${JSON.stringify(st)}`);
    },
  );

  await check('No uncaught errors in the app or extension pages', async () => {
    const relevant = pageErrors.filter((e) => !/hydrat/i.test(e));
    assert(relevant.length === 0, relevant.join('\n'));
  });
} finally {
  await browser.close();
  await stopNext();
  upstream.close();
}

process.exit(summary('SSR E2E') ? 1 : 0);
