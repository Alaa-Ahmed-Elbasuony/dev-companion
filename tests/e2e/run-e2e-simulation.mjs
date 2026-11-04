// Fetch and XHR simulation E2E checks in a real Chrome: allowlist + master switch,
// the armed recorder registration, mocked responses, failures, delays, sensitive
// endpoint protection, the XHR event lifecycle, Axios, findings about simulated
// traffic (the page's reactions kept, no backend failures from simulated outcomes),
// simulated tags and the simulated-only filter in the list and timeline, failed-request
// counts, page acknowledgement of rules, lease expiry releasing a held request,
// pause, the kill switch and the Simulation view (rules created and changed
// through the UI and the worker).
// The mock server counts the requests it receives, so "never sent" is verified on
// the server side.
//
//   npm run build:e2e && node tests/e2e/run-e2e-simulation.mjs
import { resolve } from 'node:path';
import { startMockServer } from '../../test-page/mock-server.mjs';
import {
  assert,
  createReporter,
  launchWithExtension,
  root,
  sleep,
  tabRequest,
  waitForDb,
  watchdog,
} from './harness.mjs';

watchdog(300_000, 'Simulation E2E');
const { check, summary } = createReporter();
// Axios is a devDependency; its browser bundle is loaded into the test page.
const AXIOS_BUNDLE = resolve(root, 'node_modules/axios/dist/axios.min.js');
const STORES = ['entries'];

const server = await startMockServer(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const received = [];
server.on('request', (req) => received.push(`${req.method} ${new URL(req.url, origin).pathname}`));
const sawRequest = (line) => received.includes(line);

const RULES = [
  {
    id: 'mock-items',
    name: 'Items under maintenance',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/sim/items' },
    action: {
      kind: 'mock',
      status: 503,
      headers: [{ name: 'x-simulated', value: 'yes' }],
      body: '{"error":"maintenance"}',
      bodyKind: 'json',
    },
  },
  {
    id: 'empty-list',
    name: 'Empty list',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/sim/list' },
    action: { kind: 'mock', status: 200, headers: [], body: '[]', bodyKind: 'json' },
  },
  {
    id: 'slow',
    name: 'Slow',
    enabled: true,
    delayMs: 400,
    match: { methods: ['GET'], urlPattern: '/api/sim/slow' },
    action: { kind: 'delay' },
  },
  {
    id: 'writes-fail',
    name: 'Writes fail',
    enabled: true,
    match: { methods: ['POST'], urlPattern: '/api/*' },
    action: { kind: 'fail', mode: 'network-error' },
  },
  {
    id: 'xhr-mock',
    name: 'XHR mock',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/xsim/items' },
    action: {
      kind: 'mock',
      status: 201,
      statusText: 'Created',
      headers: [{ name: 'x-sim', value: 'xhr' }],
      body: '{"items":[1,2,3]}',
      bodyKind: 'json',
    },
  },
  {
    id: 'xhr-401',
    name: 'XHR unauthorized',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/xsim/me' },
    action: {
      kind: 'mock',
      status: 401,
      headers: [],
      body: '{"message":"Session expired"}',
      bodyKind: 'json',
    },
  },
  {
    id: 'xhr-down',
    name: 'XHR down',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/xsim/down' },
    action: { kind: 'fail', mode: 'network-error' },
  },
  {
    id: 'xhr-hang',
    name: 'XHR hang',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/xsim/hang' },
    action: { kind: 'fail', mode: 'hang' },
  },
  {
    id: 'xhr-timeout',
    name: 'XHR timeout',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/xsim/timeout' },
    action: { kind: 'fail', mode: 'timeout', timeoutMs: 300 },
  },
  {
    id: 'xhr-slow',
    name: 'XHR slow',
    enabled: true,
    delayMs: 300,
    match: { methods: ['GET'], urlPattern: '/api/xsim/slow' },
    action: { kind: 'delay' },
  },
  {
    // Requested through <base href="http://localhost:PORT/"> by a page on 127.0.0.1.
    id: 'base-mock',
    name: 'Base URL',
    enabled: true,
    match: { methods: ['GET'], urlPattern: `localhost:${server.address().port}/api/base/*` },
    action: { kind: 'mock', status: 200, headers: [], body: '{"base":true}', bodyKind: 'json' },
  },
  {
    id: 'orders-500',
    name: 'Orders 500',
    enabled: true,
    match: { methods: ['GET'], urlPattern: '/api/fe/orders' },
    action: { kind: 'mock', status: 500, headers: [], body: '{"error":"boom"}', bodyKind: 'json' },
  },
  {
    // The mock server answers /api/error with a real 500.
    id: 'error-delayed',
    name: 'Error delayed',
    enabled: true,
    delayMs: 300,
    match: { methods: ['GET'], urlPattern: '/api/error' },
    action: { kind: 'delay' },
  },
  {
    id: 'long-delay',
    name: 'Long delay',
    enabled: true,
    delayMs: 1500,
    match: { methods: ['GET'], urlPattern: '/api/fe/timeout' },
    action: { kind: 'delay' },
  },
];

const { browser, extId } = await launchWithExtension('user-data-simulation');
const pageErrors = [];
try {
  const app = await browser.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${origin}/`);
  const ext = await browser.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`extension page: ${e.message}`));
  await ext.goto(`chrome-extension://${extId}/dashboard.html`);
  await app.bringToFront();

  const send = (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const registered = () =>
    ext.evaluate(async () =>
      Object.fromEntries(
        (await chrome.scripting.getRegisteredContentScripts()).map((s) => [s.id, s.matches]),
      ),
    );
  /** Runs fetch in the page and reports what the page observed. */
  const pageFetch = (path, init) =>
    app.evaluate(
      async (path, init) => {
        const started = performance.now();
        try {
          const res = await fetch(path, init);
          return {
            ok: true,
            status: res.status,
            url: res.url,
            header: res.headers.get('x-simulated'),
            contentType: res.headers.get('content-type'),
            body: await res.text(),
            ms: performance.now() - started,
          };
        } catch (err) {
          return { ok: false, name: err.name, message: err.message, ms: performance.now() - started };
        }
      },
      path,
      init,
    );
  const entryFor = (path, predicate = () => true) =>
    waitForDb(
      ext,
      STORES,
      (d) => d.entries.find((e) => new URL(e.url).pathname === path && predicate(e)),
      `entry for ${path}`,
    ).then((r) => r.value);

  await check('Simulation is off by default', async () => {
    const status = await send({ type: 'get-simulation-state' });
    assert(status.armed === false && status.origins.length === 0, JSON.stringify(status));
  });

  await check('Recording without simulation registers only the plain recorder', async () => {
    const start = await tabRequest(ext, origin, 'start-recording');
    assert(start.ok, JSON.stringify(start));
    const scripts = await registered();
    assert(scripts['dc-main-world'] && !scripts['dc-main-world-armed'], JSON.stringify(scripts));
  });

  await check('Content scripts are refused extension storage; extension pages keep it', async () => {
    // Dev Companion's content-script world in the app page, found through CDP.
    const cdp = await app.createCDPSession();
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    const bridge = contexts.find(
      (c) => c.origin === `chrome-extension://${extId}` && c.auxData?.type === 'isolated',
    );
    assert(bridge, `no content-script context: ${JSON.stringify(contexts.map((c) => [c.name, c.origin]))}`);
    const { result } = await cdp.send('Runtime.evaluate', {
      contextId: bridge.id,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const attempt = async (area, op) => {
          try { await op(chrome.storage[area]); return 'allowed'; } catch (err) { return 'denied: ' + err.message; }
        };
        return {
          readLocal: await attempt('local', (s) => s.get('settings')),
          writeLocal: await attempt('local', (s) => s.set({ simulationRules: [] })),
          readSession: await attempt('session', (s) => s.get('simulationArmed')),
        };
      })()`,
    });
    await cdp.detach();
    const access = result.value;
    assert(
      // Chrome's access-level refusal, not a missing API.
      Object.values(access).every((v) => v === 'denied: Access to storage is not allowed from this context.'),
      `content script reached storage: ${JSON.stringify(access)}`,
    );
    // Extension pages keep full access.
    const roundTrip = await ext.evaluate(async () => {
      await chrome.storage.local.set({ accessProbe: 'ok' });
      const { accessProbe } = await chrome.storage.local.get('accessProbe');
      await chrome.storage.local.remove('accessProbe');
      return accessProbe;
    });
    assert(roundTrip === 'ok', `extension page storage: ${roundTrip}`);
    // The bridge still gets its config from the worker: the recorder captures.
    await pageFetch('/api/sim/after-restriction');
    await entryFor('/api/sim/after-restriction', (e) => e.state === 'complete');
  });

  await check('Arming with an allowlisted origin registers the armed recorder', async () => {
    await ext.evaluate(
      async (origin, rules) => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: { ...settings, simulationOrigins: [origin] },
          simulationRules: rules,
        });
      },
      origin,
      RULES,
    );
    await sleep(200);
    const status = await send({ type: 'set-simulation-armed', armed: true });
    assert(status.armed && status.enabledRules === RULES.length, JSON.stringify(status));
    const scripts = await registered();
    assert(
      JSON.stringify(scripts['dc-main-world-armed']) === JSON.stringify(['http://127.0.0.1/*']),
      JSON.stringify(scripts),
    );
    assert(!scripts['dc-main-world'], 'plain recorder still registered for the same host');
    await app.reload();
    await sleep(300);
  });

  await check('A mocked response reaches the page and the request never reaches the server', async () => {
    const r = await pageFetch('/api/sim/items');
    assert(r.ok && r.status === 503, JSON.stringify(r));
    assert(r.body === '{"error":"maintenance"}', r.body);
    assert(r.header === 'yes' && r.contentType === 'application/json', JSON.stringify(r));
    assert(r.url === `${origin}/api/sim/items`, r.url);
    assert(!sawRequest('GET /api/sim/items'), 'server received the mocked request');
    const e = await entryFor('/api/sim/items', (x) => x.state === 'complete');
    assert(
      e.status === 503 && e.simulated?.action === 'mock' && e.simulated.sent === false,
      JSON.stringify(e),
    );
  });

  await check('Relative URLs are matched as the browser resolves them (document base URL)', async () => {
    const port = server.address().port;
    const r = await app.evaluate(async (port) => {
      const base = document.createElement('base');
      base.href = `http://localhost:${port}/`;
      document.head.prepend(base);
      try {
        const res = await fetch('/api/base/check');
        return { status: res.status, body: await res.text(), url: res.url };
      } catch (err) {
        return { error: err.name };
      } finally {
        base.remove();
      }
    }, port);
    assert(r.status === 200 && r.body === '{"base":true}', JSON.stringify(r));
    assert(r.url === `http://localhost:${port}/api/base/check`, r.url);
    assert(!sawRequest('GET /api/base/check'), 'server received the mocked request');
    const e = await entryFor('/api/base/check');
    assert(
      new URL(e.url).host === `localhost:${port}` && e.simulated?.ruleId === 'base-mock',
      JSON.stringify(e),
    );
  });

  await check('An empty array mock', async () => {
    const r = await pageFetch('/api/sim/list');
    assert(r.ok && r.status === 200 && r.body === '[]', JSON.stringify(r));
  });

  await check('A simulated network error rejects like Chrome and sends nothing', async () => {
    const r = await pageFetch('/api/sim/write', { method: 'POST', body: '{}' });
    assert(!r.ok && r.name === 'TypeError' && r.message === 'Failed to fetch', JSON.stringify(r));
    assert(!sawRequest('POST /api/sim/write'), 'server received the failed request');
    const e = await entryFor('/api/sim/write', (x) => x.state === 'error');
    assert(e.simulated?.action === 'network-error', JSON.stringify(e.simulated));
  });

  await check('Authentication endpoints are not simulated by a broad rule', async () => {
    const r = await pageFetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.c","password":"x"}',
    });
    assert(r.ok, JSON.stringify(r));
    assert(sawRequest('POST /api/login'), 'the login request did not reach the server');
  });

  await check('A delay rule sends the real request after the delay', async () => {
    const r = await pageFetch('/api/sim/slow');
    assert(r.ok && r.status === 404, JSON.stringify(r));
    assert(r.ms >= 380, `resolved after ${r.ms} ms`);
    assert(sawRequest('GET /api/sim/slow'), 'server never received the delayed request');
    const e = await entryFor('/api/sim/slow', (x) => x.state === 'complete');
    assert(e.simulated?.action === 'delay' && e.simulated.sent === true, JSON.stringify(e.simulated));
  });

  /** Runs one XHR in the page; reports every event with its readyState, and the final state. */
  const pageXhr = (path, opts = {}) =>
    app.evaluate(
      (path, opts) =>
        new Promise((done) => {
          const xhr = new XMLHttpRequest();
          const log = [];
          const handlers = [];
          const types = [
            'loadstart',
            'readystatechange',
            'progress',
            'load',
            'error',
            'timeout',
            'abort',
            'loadend',
          ];
          for (const type of types) xhr.addEventListener(type, () => log.push(`${type}:${xhr.readyState}`));
          for (const type of ['load', 'error', 'timeout', 'abort'])
            xhr[`on${type}`] = () => handlers.push(`on${type}`);
          xhr.open('GET', path);
          log.length = 0;
          if (opts.responseType) xhr.responseType = opts.responseType;
          if (opts.timeout) xhr.timeout = opts.timeout;
          const started = performance.now();
          xhr.addEventListener('loadend', () =>
            setTimeout(() => {
              const out = {
                log,
                handlers,
                readyState: xhr.readyState,
                status: xhr.status,
                statusText: xhr.statusText,
                url: xhr.responseURL,
                header: xhr.getResponseHeader('x-sim'),
                all: xhr.getAllResponseHeaders(),
                ms: performance.now() - started,
              };
              try {
                out.text = xhr.responseText;
              } catch (err) {
                out.textError = err.name;
              }
              if (xhr.responseType === 'json') out.response = xhr.response;
              done(out);
            }, 0),
          );
          xhr.send();
          if (opts.abortAfter) setTimeout(() => xhr.abort(), opts.abortAfter);
        }),
      path,
      opts,
    );
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const FAILED = (type) => ['loadstart:1', 'readystatechange:4', `${type}:4`, 'loadend:4'];
  const MOCK_SEQUENCE = [
    'loadstart:1',
    'readystatechange:2',
    'readystatechange:3',
    'progress:3',
    'readystatechange:4',
    'load:4',
    'loadend:4',
  ];

  await check('XHR: a mocked response follows the native event sequence and is never sent', async () => {
    const r = await pageXhr('/api/xsim/items');
    assert(sameList(r.log, MOCK_SEQUENCE), JSON.stringify(r.log));
    assert(sameList(r.handlers, ['onload']), JSON.stringify(r.handlers));
    assert(r.status === 201 && r.statusText === 'Created', JSON.stringify(r));
    assert(r.text === '{"items":[1,2,3]}' && r.url === `${origin}/api/xsim/items`, JSON.stringify(r));
    assert(r.header === 'xhr', JSON.stringify(r));
    assert(r.all === 'content-type: application/json\r\nx-sim: xhr\r\n', JSON.stringify(r.all));
    const json = await pageXhr('/api/xsim/items', { responseType: 'json' });
    assert(sameList(json.response, { items: [1, 2, 3] }), JSON.stringify(json));
    assert(json.textError === 'InvalidStateError', JSON.stringify(json));
    assert(!sawRequest('GET /api/xsim/items'), 'server received the mocked XHR');
  });

  await check('XHR: a simulated network error fires error and sends nothing', async () => {
    const r = await pageXhr('/api/xsim/down');
    assert(sameList(r.log, FAILED('error')), JSON.stringify(r.log));
    assert(sameList(r.handlers, ['onerror']) && r.status === 0, JSON.stringify(r));
    assert(!sawRequest('GET /api/xsim/down'), 'server received the failed XHR');
  });

  await check('XHR: abort() during a simulated hang ends UNSENT and sends nothing', async () => {
    const r = await pageXhr('/api/xsim/hang', { abortAfter: 200 });
    assert(sameList(r.log, FAILED('abort')), JSON.stringify(r.log));
    assert(sameList(r.handlers, ['onabort']) && r.readyState === 0, JSON.stringify(r));
    assert(!sawRequest('GET /api/xsim/hang'), 'server received the hanging XHR');
  });

  await check('XHR: xhr.timeout fires during a simulated hang', async () => {
    const r = await pageXhr('/api/xsim/hang', { timeout: 200 });
    assert(sameList(r.log, FAILED('timeout')), JSON.stringify(r.log));
    assert(sameList(r.handlers, ['ontimeout']) && r.readyState === 4, JSON.stringify(r));
    assert(r.ms >= 190, `timed out after ${r.ms} ms`);
  });

  await check('XHR: a simulated timeout fires timeout after the configured time', async () => {
    const r = await pageXhr('/api/xsim/timeout');
    assert(sameList(r.log, FAILED('timeout')), JSON.stringify(r.log));
    assert(r.ms >= 280, `timed out after ${r.ms} ms`);
    assert(!sawRequest('GET /api/xsim/timeout'), 'server received the timed-out XHR');
  });

  await check('XHR: a delay sends the real request afterwards, with one loadstart', async () => {
    const r = await pageXhr('/api/xsim/slow');
    assert(r.status === 404 && r.ms >= 280, JSON.stringify(r));
    assert(r.log.filter((e) => e.startsWith('loadstart')).length === 1, JSON.stringify(r.log));
    assert(sawRequest('GET /api/xsim/slow'), 'server never received the delayed XHR');
  });

  await check('XHR: reusing an object after a mock restores native behavior', async () => {
    const r = await app.evaluate(
      () =>
        new Promise((done) => {
          const xhr = new XMLHttpRequest();
          const states = [];
          xhr.open('GET', '/api/xsim/items');
          xhr.onloadend = () => {
            xhr.onloadend = () => done({ states, status: xhr.status, first });
            const first = xhr.status;
            xhr.onreadystatechange = () => states.push(xhr.readyState);
            xhr.open('GET', '/api/xsim/real');
            xhr.send();
          };
          xhr.send();
        }),
    );
    assert(r.first === 201 && r.status === 404, JSON.stringify(r));
    assert(r.states[0] === 1 && r.states.at(-1) === 4, JSON.stringify(r.states));
    assert(sawRequest('GET /api/xsim/real'), 'reused XHR never reached the server');
  });

  await check('XHR: simulated requests are recorded with their outcome and rule', async () => {
    const mocked = await entryFor('/api/xsim/items', (e) => e.state === 'complete');
    assert(mocked.source === 'xhr' && mocked.status === 201, JSON.stringify(mocked));
    assert(
      mocked.simulated?.ruleId === 'xhr-mock' && mocked.simulated.sent === false,
      JSON.stringify(mocked),
    );
    const down = await entryFor('/api/xsim/down', (e) => e.state === 'error');
    assert(down.simulated?.action === 'network-error', JSON.stringify(down.simulated));
    const aborted = await entryFor('/api/xsim/hang', (e) => e.state === 'aborted');
    assert(aborted.simulated?.action === 'hang', JSON.stringify(aborted.simulated));
  });

  await check('Axios (XHR adapter): mocks, errors, timeout and cancellation', async () => {
    const serverItemsBefore = received.filter((l) => l === 'GET /api/sim/items').length;
    await app.addScriptTag({ path: AXIOS_BUNDLE });
    const r = await app.evaluate(async () => {
      const settle = async (p) => {
        try {
          const res = await p;
          return { ok: true, status: res.status, data: res.data, header: res.headers['x-sim'] };
        } catch (err) {
          return {
            ok: false,
            code: err.code,
            status: err.response?.status,
            data: err.response?.data,
            cancel: window.axios.isCancel(err),
          };
        }
      };
      const client = window.axios.create({ adapter: 'xhr' });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 100);
      return {
        success: await settle(client.get('/api/xsim/items')),
        serverError: await settle(client.get('/api/sim/items')),
        unauthorized: await settle(client.get('/api/xsim/me')),
        network: await settle(client.get('/api/xsim/down')),
        timeout: await settle(client.get('/api/xsim/hang', { timeout: 200 })),
        cancelled: await settle(client.get('/api/xsim/hang', { signal: cancel.signal })),
      };
    });
    assert(r.success.ok && r.success.status === 201 && r.success.header === 'xhr', JSON.stringify(r.success));
    assert(sameList(r.success.data, { items: [1, 2, 3] }), JSON.stringify(r.success));
    assert(
      r.serverError.status === 503 && r.serverError.code === 'ERR_BAD_RESPONSE',
      JSON.stringify(r.serverError),
    );
    assert(
      r.unauthorized.status === 401 && r.unauthorized.data?.message === 'Session expired',
      JSON.stringify(r.unauthorized),
    );
    assert(r.network.code === 'ERR_NETWORK', JSON.stringify(r.network));
    assert(r.timeout.code === 'ECONNABORTED', JSON.stringify(r.timeout));
    assert(r.cancelled.cancel === true, JSON.stringify(r.cancelled));
    for (const line of [
      'GET /api/xsim/items',
      'GET /api/xsim/me',
      'GET /api/xsim/down',
      'GET /api/xsim/hang',
    ]) {
      assert(!sawRequest(line), `server received ${line}`);
    }
    assert(
      received.filter((l) => l === 'GET /api/sim/items').length === serverItemsBefore,
      'server received the mocked 503 request',
    );
  });

  await check('Findings keep the page reacting to simulated traffic, never as backend failures', async () => {
    // Findings link errors to requests that ended up to 5 s earlier: keep earlier checks out of the window.
    await sleep(5500);
    const page = await app.evaluate(async () => {
      const orders = await fetch('/api/fe/orders');
      const body = await orders.json();
      if (!orders.ok) console.error(`Could not load orders: HTTP ${orders.status}`);
      let count;
      try {
        count = body.items.length; // the error body used as data
      } catch (err) {
        console.error(err.message);
      }
      const delayed = await fetch('/api/error');
      let timeout = 'none';
      try {
        await fetch('/api/fe/timeout', { signal: AbortSignal.timeout(200) });
      } catch (err) {
        timeout = err.name;
      }
      return { orders: orders.status, count, delayed: delayed.status, timeout };
    });
    assert(
      page.orders === 500 && page.delayed === 500 && page.timeout === 'TimeoutError',
      JSON.stringify(page),
    );
    await sleep(1600); // past the long delay: the timed-out request must never have been sent
    assert(!sawRequest('GET /api/fe/orders'), 'server received the mocked request');
    assert(sawRequest('GET /api/error'), 'server never received the delayed request');
    assert(!sawRequest('GET /api/fe/timeout'), 'a request that timed out during the delay was sent');
    const mocked = await entryFor('/api/fe/orders', (x) => x.state === 'complete');
    assert(mocked.simulated?.action === 'mock', JSON.stringify(mocked.simulated));
    const delayed = await entryFor('/api/error', (x) => x.state === 'complete');
    assert(
      delayed.status === 500 && delayed.responseAt !== undefined && delayed.simulated?.action === 'delay',
      JSON.stringify(delayed),
    );
    // `sent` is set when the delay starts; the lifecycle shows the request ended during it.
    const cancelled = await entryFor('/api/fe/timeout', (x) => x.state === 'timeout');
    assert(
      cancelled.simulated?.sent === true && cancelled.endedAt - cancelled.startedAt < 1500,
      JSON.stringify(cancelled),
    );

    const tabId = await ext.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/*` }))[0].id, origin);
    await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#network`);
    await ext.bringToFront();
    const row = await ext.waitForFunction(
      () =>
        [...document.querySelectorAll('.request-list [role="row"]')]
          .find((r) => r.querySelector('.url-path')?.textContent === '/api/fe/orders')
          ?.querySelector('.tag')?.textContent,
      { timeout: 10_000 },
    );
    assert((await row.jsonValue()) === 'simulated', 'mocked request not tagged in the request list');

    await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#investigations`);
    const host = new URL(origin).host;
    const cards = await ext
      .waitForFunction(
        (consoleTitle) => {
          const all = [...document.querySelectorAll('article.finding')].map((a) => ({
            title: a.querySelector('h3')?.textContent ?? '',
            tags: [...a.querySelectorAll('header .tag')].map((t) => t.textContent),
          }));
          return all.some((c) => c.title.startsWith(consoleTitle)) && all;
        },
        { timeout: 15_000 },
        'Console error after failed request · simulated by rule "Orders 500"',
      )
      .then((h) => h.jsonValue())
      .catch(async (err) => {
        const seen = await ext.$$eval('article.finding h3', (hs) => hs.map((h) => h.textContent));
        throw new Error(`${err.message}; findings shown: ${JSON.stringify(seen)}`);
      });
    const find = (prefix) => cards.find((c) => c.title.startsWith(prefix));
    const titles = JSON.stringify(cards.map((c) => c.title));
    // The page's reactions: kept, tagged as page behavior and simulated.
    const consoleCard = find('Console error after failed request · simulated by rule "Orders 500"');
    assert(String(consoleCard.tags) === 'page behavior,simulated', JSON.stringify(consoleCard));
    const mapping = find('"length" accessed on undefined shortly after GET /api/fe/orders returned 500');
    assert(mapping?.title.endsWith('· simulated by rule "Orders 500"'), titles);
    assert(String(mapping.tags) === 'page behavior,simulated', JSON.stringify(mapping));
    // No backend failure from the mocked 500 or the timeout during the delay.
    assert(!find(`500 from GET ${host}/api/fe/orders`), titles);
    assert(!find(`Timeout: GET ${host}/api/fe/timeout`), titles);
    // The real 500 behind the delay is a backend finding, marked as delayed; its time is not latency.
    const backend = find(`500 from GET ${host}/api/error`);
    assert(backend?.title.endsWith('· delayed by rule "Error delayed"'), titles);
    assert(String(backend.tags) === 'backend,delayed by simulation', JSON.stringify(backend));
    await app.bringToFront();
  });

  // Event names of the page <-> bridge channel (src/shared/messages.ts).
  const PAGE_TO_BRIDGE = '__devcompanion:capture';
  const BRIDGE_TO_PAGE = '__devcompanion:control';
  const appTabId = () =>
    ext.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/*` }))[0].id, origin);

  await check('List and timeline tag simulated requests; the simulated-only filter composes', async () => {
    const tabId = await appTabId();
    await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#network?sim=1`);
    await ext.bringToFront();
    const rows = () =>
      ext.$$eval('.request-list [role="row"]', (rs) =>
        rs.map((r) => ({
          path: r.querySelector('.url-path')?.textContent,
          tag: r.querySelector('.tag')?.textContent ?? null,
        })),
      );
    await ext.waitForSelector('.request-list [role="row"]');
    const simulatedOnly = await rows();
    assert(simulatedOnly.length > 0 && simulatedOnly.every((r) => r.tag), JSON.stringify(simulatedOnly));
    const tagOf = (list, path) => list.find((r) => r.path === path)?.tag;
    // Server-answered only with a recorded response; a timeout during the delay is the rule's outcome.
    assert(tagOf(simulatedOnly, '/api/error') === 'delayed by simulation', JSON.stringify(simulatedOnly));
    assert(tagOf(simulatedOnly, '/api/fe/timeout') === 'simulated', JSON.stringify(simulatedOnly));
    assert(tagOf(simulatedOnly, '/api/fe/orders') === 'simulated', JSON.stringify(simulatedOnly));
    // Composes with search and status filters.
    await ext.goto(
      `chrome-extension://${extId}/dashboard.html?tabId=${tabId}#network?sim=1&q=api%2Ffe&status=server-error`,
    );
    await ext.waitForSelector('.request-list [role="row"]');
    const narrowed = await rows();
    assert(
      narrowed.length === 1 && narrowed[0].path === '/api/fe/orders' && narrowed[0].tag === 'simulated',
      JSON.stringify(narrowed),
    );
    await ext.goto(
      `chrome-extension://${extId}/dashboard.html?tabId=${tabId}#network?sim=1&q=no-such-endpoint`,
    );
    await ext.waitForSelector('::-p-text(No simulated requests match the current filters.)');

    const timeline = async (q) => {
      await ext.goto(
        `chrome-extension://${extId}/dashboard.html?tabId=${tabId}#timeline?q=${encodeURIComponent(q)}`,
      );
      await ext.waitForSelector('.tl-row');
      return ext.$$eval('.tl-row .tl-msg', (ms) =>
        ms.map((m) => ({ text: m.textContent, tag: m.querySelector('.tag')?.textContent ?? null })),
      );
    };
    // "simulated" finds simulated requests only (and every visible one is tagged).
    const found = await timeline('simulated');
    assert(found.length > 0 && found.every((i) => i.tag), JSON.stringify(found));
    const timelineTag = async (path, title) =>
      (await timeline(path)).find((i) => i.text.includes(title))?.tag;
    assert(
      (await timelineTag('/api/error', 'GET /api/error → 500')) === 'delayed by simulation',
      'timeline: /api/error',
    );
    assert(
      (await timelineTag('/api/fe/orders', 'GET /api/fe/orders → 500')) === 'simulated',
      'timeline: /api/fe/orders',
    );
    assert(
      (await timelineTag('/api/fe/timeout', 'GET /api/fe/timeout → timeout')) === 'simulated',
      'timeline: /api/fe/timeout',
    );
    await app.bringToFront();
  });

  await check(
    'Header, Overview and popup agree on failed requests: a delayed real 500 counts, a mock does not',
    async () => {
      const tabId = await appTabId();
      const { value: entries } = await waitForDb(ext, STORES, (d) => d.entries, 'entries');
      // Independent oracle: a failure counts when no rule produced it (the server returned it).
      const failure = (e) => e.state !== 'pending' && (e.state !== 'complete' || (e.status ?? 0) >= 400);
      const answered = (e) =>
        e.simulated?.sent && e.state === 'complete' && e.status > 0 && e.responseAt !== undefined;
      const expected = entries.filter((e) => failure(e) && (!e.simulated || answered(e))).length;
      const delayed = entries.filter((e) => e.simulated && failure(e) && answered(e)).length;
      const synthetic = entries.filter((e) => e.simulated && failure(e) && !answered(e)).length;
      assert(delayed >= 1 && synthetic >= 1, `delayed ${delayed}, synthetic ${synthetic}`);

      await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#overview`);
      await ext.bringToFront();
      const tile = await ext
        .waitForFunction(() => {
          const t = [...document.querySelectorAll('.metric')].find(
            (m) => m.querySelector('.metric-label')?.textContent === 'Failed requests',
          );
          return (
            t && {
              value: Number(t.querySelector('.metric-value')?.textContent),
              hint: t.querySelector('.metric-hint')?.textContent ?? '',
            }
          );
        })
        .then((h) => h.jsonValue());
      const header = await ext.$eval('.counts', (el) => Number(/(\d+) failed/.exec(el.textContent)?.[1]));
      assert(
        tile.value === expected && header === expected,
        `tile ${tile.value}, header ${header}, expected ${expected}`,
      );
      assert(
        tile.hint.includes(`including ${delayed} returned by the server behind a simulated delay`) &&
          tile.hint.includes(`not counting ${synthetic} simulated failure(s)`),
        tile.hint,
      );

      await app.bringToFront();
      await app.triggerExtensionAction((await browser.extensions()).get(extId));
      const target = await browser.waitForTarget((t) => t.url().endsWith('/popup.html'), { timeout: 5000 });
      const popup = await target.asPage();
      popup.on('pageerror', (e) => pageErrors.push(`toolbar popup: ${e.message}`));
      const shown = await popup
        .waitForFunction(() => {
          const link = [...document.querySelectorAll('.stat-link')].find((l) => /failed/.test(l.textContent));
          return link && Number(/(\d+) failed/.exec(link.textContent)?.[1]);
        })
        .then((h) => h.jsonValue());
      await popup.close();
      assert(shown === expected, `popup ${shown}, expected ${expected}`);
    },
  );

  await check('Rules are shown as active only once the page confirms them', async () => {
    const tabId = await appTabId();
    const state = () => send({ type: 'get-simulation-state', tabId });
    const before = await state();
    assert(before.page.active && before.page.delivery === 'acknowledged', JSON.stringify(before.page));
    const toggle = async (enabled) => {
      const rule = (await state()).rules.find((r) => r.id === 'long-delay');
      const res = await send({
        type: 'update-simulation-rules',
        change: { op: 'set-enabled', id: 'long-delay', enabled, expectedUpdatedAt: rule.updatedAt },
      });
      assert(res.ok, JSON.stringify(res));
    };
    // The page stops reaching the bridge (a broken page could): it receives new rules but cannot confirm them.
    await app.evaluate((event) => {
      const block = (e) => e.stopImmediatePropagation();
      window.addEventListener(event, block, true);
      window.__dcUnblock = () => window.removeEventListener(event, block, true);
    }, PAGE_TO_BRIDGE);
    await toggle(false);
    const sent = await state();
    assert(sent.page.active && sent.page.delivery === 'sent', JSON.stringify(sent.page));
    await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#simulation`);
    await ext.bringToFront();
    await ext.waitForSelector('::-p-text(Not confirmed by this tab)', { timeout: 10_000 });
    assert(!(await ext.$('::-p-text(Active on this tab)')), 'shown as active without confirmation');
    assert((await state()).page.delivery === 'timed-out', 'worker did not time out');
    // Reachable again: the next configuration is confirmed by the page.
    await app.evaluate(() => window.__dcUnblock());
    await toggle(true);
    await ext.waitForSelector('::-p-text(Active on this tab)', { timeout: 10_000 });
    assert((await state()).page.delivery === 'acknowledged', 'not acknowledged after reconnecting');
    await app.bringToFront();
  });

  await check('A held request is released when the page lease runs out without renewal', async () => {
    const result = await app.evaluate(async (event) => {
      const rule = {
        id: 'lease-hang',
        name: 'Lease hang',
        enabled: true,
        delayMs: 0,
        allowSensitive: false,
        pattern: { kind: 'always' },
        updatedAt: 1,
        match: { methods: ['GET'], urlPattern: '/api/e2e/lease' },
        action: { kind: 'fail', mode: 'hang' },
      };
      // Rules whose lease is never renewed, as when the worker stops answering.
      const config = { simulation: { rules: [rule], leaseUntil: Date.now() + 1500, revision: 'e2e-lease' } };
      document.dispatchEvent(new CustomEvent(event, { detail: JSON.stringify({ type: 'config', config }) }));
      const started = performance.now();
      const res = await fetch('/api/e2e/lease');
      return { status: res.status, ms: performance.now() - started };
    }, BRIDGE_TO_PAGE);
    assert(result.status === 404 && result.ms >= 1300 && result.ms < 10_000, JSON.stringify(result));
    assert(sawRequest('GET /api/e2e/lease'), 'the released request never reached the server');
    const e = await entryFor('/api/e2e/lease', (x) => x.state === 'complete');
    assert(
      e.simulated?.action === 'hang' &&
        e.simulated.sent === true &&
        e.warnings.some((w) => w.includes('lease ran out')),
      JSON.stringify(e),
    );
    // The bridge gives the page its real rules back; the page confirms them.
    await app.evaluate((event) => {
      document.dispatchEvent(new CustomEvent(event, { detail: JSON.stringify({ type: 'ping' }) }));
    }, PAGE_TO_BRIDGE);
    const tabId = await appTabId();
    let delivery;
    for (let i = 0; i < 20 && delivery !== 'acknowledged'; i++) {
      delivery = (await send({ type: 'get-simulation-state', tabId })).page.delivery;
      if (delivery !== 'acknowledged') await sleep(100);
    }
    assert(delivery === 'acknowledged', `after restoring: ${delivery}`);
  });

  await check('Pausing recording pauses simulation; resuming restores it', async () => {
    const before = received.filter((l) => l === 'GET /api/sim/items').length;
    await tabRequest(ext, origin, 'pause-recording');
    await sleep(200);
    const paused = await pageFetch('/api/sim/items');
    assert(paused.ok && paused.status === 404, JSON.stringify(paused));
    assert(received.filter((l) => l === 'GET /api/sim/items').length === before + 1, 'not sent while paused');
    const scripts = await registered();
    assert(!scripts['dc-main-world-armed'], 'armed recorder still registered while paused');

    await tabRequest(ext, origin, 'resume-recording');
    await sleep(200);
    const resumed = await pageFetch('/api/sim/items');
    assert(resumed.ok && resumed.status === 503, JSON.stringify(resumed));
  });

  await check('The kill switch stops simulation in the open page without a reload', async () => {
    const status = await send({ type: 'set-simulation-armed', armed: false });
    assert(status.armed === false, JSON.stringify(status));
    await sleep(200);
    const r = await pageFetch('/api/sim/items');
    assert(r.ok && r.status === 404, JSON.stringify(r));
    const write = await pageFetch('/api/sim/write', { method: 'POST', body: '{}' });
    assert(write.ok, JSON.stringify(write));
    assert(sawRequest('POST /api/sim/write'), 'request not sent after disarming');
    const xhr = await pageXhr('/api/xsim/down');
    assert(xhr.status === 404, JSON.stringify(xhr));
    // The native sequence for a real response is the one simulated mocks reproduce.
    assert(sameList(xhr.log, MOCK_SEQUENCE), `native sequence: ${JSON.stringify(xhr.log)}`);
    assert(sawRequest('GET /api/xsim/down'), 'XHR not sent after disarming');
    const scripts = await registered();
    assert(scripts['dc-main-world'] && !scripts['dc-main-world-armed'], JSON.stringify(scripts));
  });

  await check('Simulation view: switch, create, disable and delete a rule through the worker', async () => {
    const tabId = await ext.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/*` }))[0].id, origin);
    await ext.goto(`chrome-extension://${extId}/dashboard.html?tabId=${tabId}#simulation`);
    // Clicks wait for animation frames, which background tabs do not run.
    await ext.bringToFront();
    await ext.waitForSelector('::-p-text(Not running on this tab)');
    await ext.click('::-p-text(Turn simulation on)');
    await ext.waitForSelector('::-p-text(Active on this tab)');

    await ext.click('::-p-text(New rule)');
    await ext.locator('input[placeholder="localhost:3000/api/orders/:id"]').fill('/api/ui/teapot');
    await ext.locator('.sim-mock input[max="599"]').fill('418');
    await ext.locator('.sim-mock textarea[placeholder^="{"]').fill('{"brewed":false}');
    await ext.click('::-p-text(Create rule)');
    await ext.waitForSelector('::-p-text(Rule created.)');
    await sleep(200);
    const mocked = await pageFetch('/api/ui/teapot');
    assert(mocked.ok && mocked.status === 418 && mocked.body === '{"brewed":false}', JSON.stringify(mocked));
    assert(!sawRequest('GET /api/ui/teapot'), 'server received the mocked request');

    await ext.click('input[aria-label="Enable /api/ui/teapot"]');
    await ext.waitForSelector('::-p-text(Disabled “/api/ui/teapot”.)');
    await sleep(200);
    const passed = await pageFetch('/api/ui/teapot');
    assert(passed.ok && passed.status === 404, JSON.stringify(passed));
    assert(sawRequest('GET /api/ui/teapot'), 'disabled rule still applied');

    await ext.click('button[aria-label="Delete /api/ui/teapot"]');
    await ext.click('.modal ::-p-text(Delete rule)');
    await ext.waitForSelector('::-p-text(Deleted “/api/ui/teapot”.)');
    const after = await send({ type: 'get-simulation-state' });
    assert(after.rules.length === RULES.length, JSON.stringify(after.rules.map((r) => r.id)));

    await ext.click('::-p-text(Turn simulation off)');
    await ext.waitForSelector('::-p-text(Not running on this tab)');
    const off = await send({ type: 'get-simulation-state' });
    assert(off.armed === false && off.enabledRules === RULES.length, JSON.stringify(off));
  });

  await check('No uncaught errors in the app or extension pages', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

process.exit(summary('Simulation E2E') ? 1 : 0);
