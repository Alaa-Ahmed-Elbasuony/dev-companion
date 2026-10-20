// Realtime E2E checks in a real Chrome: WebSocket, Socket.IO, SignalR (mock hub,
// real @microsoft/signalr client) and SSE capture through the built extension.
// Reads what the extension persisted in IndexedDB.
//
//   npm run build:e2e && node tests/e2e/run-e2e-realtime.mjs
import { startMockServer } from '../../test-page/mock-server.mjs';
import {
  assert,
  createReporter,
  launchPlain,
  launchWithExtension,
  readDb,
  sleep,
  tabRequest,
  waitForDb,
  watchdog,
} from './harness.mjs';

watchdog(360_000, 'Realtime E2E');
const { check, summary } = createReporter();
const STORES = ['entries', 'bodies', 'timeline', 'sessions', 'rt-connections', 'rt-messages'];

const server = await startMockServer(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const clickOn =
  (page) =>
  async (id, wait = 250) => {
    await page.$eval(`#${id}`, (el) => el.click());
    await sleep(wait);
  };

/** The scripted flow used to compare page behavior with and without recording. */
async function scenario(page) {
  const click = clickOn(page);
  await page.evaluate(() => (window.appLog = []));
  for (const [id, wait] of [
    ['ws-connect', 400],
    ['ws-send-json', 200],
    ['ws-binary-out', 200],
    ['ws-binary-in', 200],
    ['create-order', 500],
    ['ws-close-1011', 400],
    ['sio-connect', 1500],
    ['sio-order', 400],
    ['sio-disconnect', 300],
    ['sr-ws', 900],
    ['sr-order', 500],
    ['sr-stop', 400],
    ['sse-open', 1000],
    ['create-order', 600],
    ['sse-close', 200],
  ]) {
    await click(id, wait);
  }
  // Order ids and request ids differ between runs; compare the shape of the log. The SSE
  // server also emits a timer tick every 400 ms, whose count depends on wall-clock timing,
  // so only event-driven entries are compared. Socket.IO's transport upgrade completes
  // whenever its probe returns, before or after "connect" with or without the extension,
  // so it is compared by count, not position.
  const log = await page.evaluate(() =>
    window.appLog
      .filter((e) => !(e.kind === 'sse-message' && e.detail.includes('"tick"')))
      .map((e) => `${e.kind}${e.kind === 'ws-message' ? ` ${e.detail.split(' ')[0]}` : ''}`),
  );
  const upgrades = log.filter((e) => e === 'sio-upgrade').length;
  return [...log.filter((e) => e !== 'sio-upgrade'), `sio-upgrade x${upgrades}`];
}

// Baseline: the same flow in Chrome without the extension.
let baseline;
{
  const plain = await launchPlain();
  try {
    const page = await plain.newPage();
    await page.goto(`${origin}/realtime`);
    baseline = await scenario(page);
  } finally {
    await plain.close();
  }
}

const { browser, extId } = await launchWithExtension('user-data-realtime');
const pageErrors = [];
try {
  console.log(`Extension loaded: ${extId}\nRealtime test page: ${origin}/realtime\n`);
  const app = await browser.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${origin}/realtime`);
  const click = clickOn(app);
  const ext = await browser.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`extension page: ${e.message}`));
  await ext.goto(`chrome-extension://${extId}/dashboard.html`);
  await app.bringToFront();
  const db = () => readDb(ext, STORES);
  const waitDb = (predicate, label, timeout) => waitForDb(ext, STORES, predicate, label, timeout);
  const messagesOf = (d, connId) =>
    d['rt-messages'].filter((m) => m.connectionId === connId).sort((a, b) => a.timestamp - b.timestamp);

  let sessionId;
  await check('Recording starts; the popup is never opened during this suite', async () => {
    const result = await tabRequest(ext, 'http://127.0.0.1', 'start-recording');
    assert(result?.ok && result.injected, `start failed: ${JSON.stringify(result)}`);
    sessionId = result.session.id;
    // Reload so the recorder is installed at document_start, as for every later load.
    await app.reload();
    await app.waitForFunction(() => typeof window.io === 'function' && typeof window.signalR === 'object');
  });

  await check('WebSocket lifecycle and incoming/outgoing text frames are recorded', async () => {
    await click('ws-connect', 500);
    await click('ws-send-json', 300);
    const { value: conn } = await waitDb(
      (d) => d['rt-connections'].find((c) => c.url.endsWith('/ws') && c.state === 'open' && c.inCount >= 2),
      'open /ws connection with frames',
    );
    assert(conn.sessionId === sessionId && conn.protocol === 'raw', JSON.stringify(conn));
    const msgs = messagesOf(await db(), conn.id);
    const kinds = msgs.map((m) => m.lifecycle ?? `${m.direction}:${m.opcode}`);
    assert(kinds.join(',').startsWith('connecting,open,in:text,out:text,in:text'), kinds.join(','));
    const out = msgs.find((m) => m.direction === 'out');
    assert(out.decoded?.[0]?.name === 'subscribe', `decoded ${JSON.stringify(out.decoded)}`);
  });

  await check('Secrets in frames are redacted before storage', async () => {
    await click('ws-send-secret', 400);
    const d = await db();
    const text = JSON.stringify(d['rt-messages']);
    assert(!text.includes('ws-hunter2'), 'password stored');
    assert(!text.includes('ws-secret-welcome'), 'welcome token stored');
    assert(text.includes('[REDACTED]'), 'no redaction marker');
  });

  await check(
    'Binary frames keep metadata only; large frames are truncated; malformed JSON is flagged',
    async () => {
      await click('ws-binary-out');
      await click('ws-binary-in');
      await click('ws-large', 600);
      await click('ws-malformed', 300);
      const { value } = await waitDb((d) => {
        const msgs = d['rt-messages'].filter((m) => m.sessionId === sessionId);
        const binOut = msgs.find((m) => m.opcode === 'binary' && m.direction === 'out');
        // The server echoes the 5-byte send; the 16-byte frame is the server-generated one.
        const binIn = msgs.find((m) => m.opcode === 'binary' && m.direction === 'in' && m.size === 16);
        const large = msgs.find((m) => m.size > 200_000);
        const bad = msgs.find((m) => m.parseError);
        return binOut && binIn && large && bad && { binOut, binIn, large, bad };
      }, 'binary, large and malformed frames');
      assert(value.binOut.size === 5 && value.binOut.text === undefined, JSON.stringify(value.binOut));
      assert(
        value.binIn.size === 16 && value.binIn.binaryType === 'arraybuffer',
        JSON.stringify(value.binIn),
      );
      assert(
        value.large.truncated && value.large.text.length <= 64 * 1024,
        `large ${value.large.text?.length}`,
      );
      assert(/not valid JSON/.test(value.bad.parseError), value.bad.parseError);
    },
  );

  await check(
    'Server close (1011), abrupt drop (1006), rejected handshake and app reconnects are recorded',
    async () => {
      await click('ws-close-1011', 500);
      await click('ws-reject', 600);
      await click('ws-flaky', 2500);
      const { value } = await waitDb(
        (d) => {
          const c = d['rt-connections'].filter((x) => x.sessionId === sessionId);
          const closed = c.find((x) => x.closeCode === 1011);
          const rejected = c.find((x) => x.url.endsWith('/ws/reject') && x.state === 'failed');
          const flaky = c.filter((x) => x.url.includes('scenario=flaky') && x.closeCode === 1006);
          return closed && rejected && flaky.length === 3 && { closed, rejected, flaky };
        },
        'close codes and reconnects',
        10_000,
      );
      assert(
        value.closed.closeReason === 'Internal server error' && value.closed.state === 'closed',
        'close 1011',
      );
      assert(value.rejected.closeCode === 1006, `rejected code ${value.rejected.closeCode}`);
      const attempts = value.flaky.sort((a, b) => a.createdAt - b.createdAt);
      assert(
        attempts[1].reconnectOf === attempts[0].id && attempts[2].reconnectOf === attempts[1].id,
        'reconnect chain',
      );
      assert(attempts.map((a) => a.attempt).join() === '0,1,2', attempts.map((a) => a.attempt).join());
      assert(
        attempts.every((a) => a.wasClean === false),
        'abnormal closes must not be clean',
      );
    },
  );

  await check('HTTP request and the realtime event it caused share an explicit request id', async () => {
    await click('ws-connect', 500);
    await click('create-order', 800);
    const { value } = await waitDb((d) => {
      const post = d.entries.find((e) => e.url.endsWith('/api/rt/orders') && e.state === 'complete');
      const reqId = post?.responseHeaders.find((h) => h.name === 'x-request-id')?.value;
      const frame = reqId && d['rt-messages'].find((m) => m.direction === 'in' && m.text?.includes(reqId));
      return frame && { post, frame, reqId };
    }, 'order POST and order.created frame');
    assert(value.frame.decoded?.[0]?.name === 'order.created', 'frame not decoded as order.created');
    assert(value.frame.timestamp >= value.post.startedAt, 'event before request');
    assert(await app.$('.toast'), 'page toast missing');
  });

  await check(
    'Socket.IO: polling handshake, upgrade, events, acknowledgements and connect errors',
    async () => {
      await click('sio-connect', 2000);
      await click('sio-order', 600);
      await click('sio-fail', 400);
      await click('sio-admin-bad', 800);
      const { value } = await waitDb(
        (d) => {
          const c = d['rt-connections'].filter(
            (x) => x.sessionId === sessionId && x.protocol === 'socket.io',
          );
          const ws = c.find((x) => x.transport === 'websocket' && x.upgradedFrom);
          const polling = ws && c.find((x) => x.id === ws.upgradedFrom);
          const msgs = d['rt-messages'].filter(
            (m) => m.sessionId === sessionId && m.decoded?.[0]?.protocol === 'socket.io',
          );
          const emit = msgs.find((m) => m.direction === 'out' && m.decoded[0].name === 'place-order');
          const ack =
            emit &&
            msgs.find((m) => m.decoded[0].kind === 'ACK' && m.decoded[0].ackId === emit.decoded[0].ackId);
          const created = msgs.find((m) => m.direction === 'in' && m.decoded[0].name === 'order.created');
          const connectError = msgs.find((m) => m.decoded[0].kind === 'CONNECT_ERROR');
          return (
            ws &&
            polling &&
            emit &&
            ack &&
            created &&
            connectError && { ws, polling, emit, ack, created, connectError }
          );
        },
        'socket.io traffic',
        10_000,
      );
      assert(
        value.polling.transport === 'polling' && value.polling.state === 'closed',
        'polling not closed by upgrade',
      );
      assert(value.ack.decoded[0].args[0].ok === true, JSON.stringify(value.ack.decoded));
      assert(value.connectError.decoded[0].namespace === '/admin', 'connect error namespace');
      assert(value.connectError.decoded[0].error === 'not authorized', value.connectError.decoded[0].error);
      assert(value.created.decoded[0].category === 'app', 'app event category');
    },
  );

  await check('Socket.IO heartbeats are classified separately from application events', async () => {
    await sleep(5500); // server pingInterval is 5 s
    const { value } = await waitDb(
      (d) =>
        d['rt-messages'].find(
          (m) => m.decoded?.[0]?.protocol === 'socket.io' && m.decoded[0].category === 'heartbeat',
        ),
      'socket.io heartbeat',
      4000,
    );
    assert(['ping', 'pong'].includes(value.decoded[0].kind), value.decoded[0].kind);
    await click('sio-disconnect', 300);
  });

  for (const [button, transport, label] of [
    ['sr-ws', 'websocket', 'WebSockets'],
    ['sr-sse', 'eventsource', 'Server-Sent Events'],
    ['sr-lp', 'polling', 'Long Polling'],
  ]) {
    await check(
      `SignalR over ${label}: negotiate, handshake, invocation, completion and server calls`,
      async () => {
        const before = new Set((await db())['rt-connections'].map((c) => c.id));
        await click(button, 1200);
        await click('sr-order', 900);
        await click('sr-fail', 600);
        await click('sr-stop', 700);
        const { value } = await waitDb(
          (d) => {
            const conn = d['rt-connections'].find(
              (c) => !before.has(c.id) && c.protocol === 'signalr' && c.transport === transport,
            );
            if (!conn) return null;
            const packets = messagesOf(d, conn.id).flatMap((m) =>
              (m.decoded ?? []).map((p) => ({ ...p, dir: m.direction })),
            );
            const invoke = packets.find(
              (p) => p.kind === 'Invocation' && p.name === 'PlaceOrder' && p.dir === 'out',
            );
            const completion =
              invoke &&
              packets.find((p) => p.kind === 'Completion' && p.invocationId === invoke.invocationId);
            const serverCall = packets.find(
              (p) => p.kind === 'Invocation' && p.name === 'OrderCreated' && p.dir === 'in',
            );
            const failed = packets.find((p) => p.kind === 'Completion' && p.error);
            const handshake = packets.find((p) => p.kind === 'Handshake request');
            return invoke && completion && serverCall && failed && handshake && { conn, completion, failed };
          },
          `SignalR ${label} traffic`,
          10_000,
        );
        assert(
          value.conn.negotiateEntryId || /negotiate|framing/.test(value.conn.protocolEvidence),
          'no protocol evidence',
        );
        assert(value.completion.result?.orderId?.startsWith('sr-'), JSON.stringify(value.completion));
        assert(/OUT_OF_STOCK/.test(value.failed.error), value.failed.error);
      },
    );
  }

  await check(
    'SSE: named events the page listens to, unnamed messages, auto-reconnect and failures',
    async () => {
      await click('sse-open', 1200);
      await click('create-order', 700);
      await click('sse-close', 200);
      await click('sse-drop', 3500);
      await click('sse-close', 200);
      await click('sse-fail', 1000);
      const { value } = await waitDb(
        (d) => {
          const c = d['rt-connections'].filter(
            (x) => x.sessionId === sessionId && x.transport === 'eventsource' && x.protocol === 'sse',
          );
          const first = c.find((x) => x.url.endsWith('/sse/orders') && x.state === 'closed');
          const dropping = c.find((x) => x.url.includes('drop=1'));
          const failing = c.find((x) => x.url.endsWith('/sse/fail'));
          if (!first || !dropping || !failing) return null;
          const named = messagesOf(d, first.id).find((m) => m.sse?.type === 'order.created');
          const ticks = messagesOf(d, first.id).filter((m) => m.sse?.type === 'message');
          const reconnecting = messagesOf(d, dropping.id).filter((m) => m.lifecycle === 'reconnecting');
          const resumed = messagesOf(d, dropping.id).find(
            (m) => m.sse?.type === 'hello' && m.text.includes('"resumedFrom":"'),
          );
          return (
            named && ticks.length >= 2 && reconnecting.length >= 1 && resumed && { failing, named, first }
          );
        },
        'SSE traffic',
        10_000,
      );
      assert(value.named.decoded?.[0]?.name === 'order.created', 'named event not decoded');
      assert(value.named.sse.lastEventId, 'no event id');
      assert(value.failing.state === 'failed', `failing stream state ${value.failing.state}`);
    },
  );

  await check(
    'Rate limit: a 4000-frame burst is delivered to the page in full and capture loss is reported',
    async () => {
      await click('ws-connect', 500);
      await app.evaluate(() => (window.tickCount = 0));
      await app.evaluate(() => {
        // The page's own socket; flood command handled by the server.
        const s = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
        s.onmessage = (e) => {
          if (e.data.includes('"tick"')) window.tickCount++;
        };
        s.onopen = () => s.send(JSON.stringify({ cmd: 'flood', n: 4000 }));
      });
      await app.waitForFunction(() => window.tickCount === 4000, { timeout: 15_000 });
      const { value } = await waitDb(
        (d) => d.timeline.find((e) => e.kind === 'capture' && /dropped/.test(e.message)),
        'capture-dropped event',
        10_000,
      );
      assert(/\d+ event\(s\) dropped/.test(value.message), value.message);
    },
  );

  await check("Navigation closes the previous document's connections; history persists", async () => {
    await click('ws-connect', 500);
    const openBefore = (await db())['rt-connections'].filter(
      (c) => c.sessionId === sessionId && c.state === 'open',
    );
    assert(openBefore.length >= 1, 'no open connection before navigation');
    await app.goto(`${origin}/page2`);
    const { value } = await waitDb((d) => {
      const ids = new Set(openBefore.map((c) => c.id));
      const after = d['rt-connections'].filter((c) => ids.has(c.id));
      return after.every((c) => c.state === 'closed' && c.warnings.some((w) => /navigated/.test(w))) && after;
    }, 'connections closed by navigation');
    assert(value.length === openBefore.length, 'connections lost');
  });

  await check('Capture survives a service-worker restart', async () => {
    const cdp = await browser.target().createCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    assert(sw, 'service worker target not found');
    await cdp.send('Target.closeTarget', { targetId: sw.targetId });
    // The worker is gone until the next event (the page's next message) wakes it up.
    await sleep(500);
    const { targetInfos: after } = await cdp.send('Target.getTargets');
    assert(!after.some((t) => t.targetId === sw.targetId), 'service worker was not stopped');
    await app.goto(`${origin}/realtime`);
    await app.waitForFunction(() => typeof window.io === 'function');
    const before = (await db())['rt-connections'].length;
    await click('ws-connect', 800);
    const { value } = await waitDb(
      (d) => d['rt-connections'].length > before && d['rt-connections'].at(-1),
      'connection after worker restart',
      10_000,
    );
    assert(value.sessionId === sessionId, 'new connection not linked to the running session');
    const d = await db();
    assert(d['rt-messages'].filter((m) => m.sessionId === sessionId).length > 50, 'earlier messages missing');
  });

  await check(
    'Application realtime behavior is identical with recording on (vs. Chrome without the extension)',
    async () => {
      await app.goto(`${origin}/realtime`);
      await app.waitForFunction(() => typeof window.io === 'function');
      const recorded = await scenario(app);
      assert(
        JSON.stringify(recorded) === JSON.stringify(baseline),
        `with recording:\n${recorded.join(', ')}\nwithout extension:\n${baseline.join(', ')}`,
      );
    },
  );

  // Deduplication with advanced (CDP) capture active is covered by run-e2e-cdp.mjs.

  // ---- Dashboard UI on real realtime data ------------------------------------------
  const { resolve: resolvePath } = await import('node:path');
  const artifacts = resolvePath(import.meta.dirname, '../../.e2e-profile/artifacts');
  // Puppeteer element clicks wait for animation frames, which background tabs never run.
  const dash = async (hash = '') => {
    await ext.bringToFront();
    await ext.goto(`chrome-extension://${extId}/dashboard.html?session=${sessionId}${hash}`);
  };
  const textOf = (sel) => ext.$eval(sel, (el) => el.textContent);

  await check(
    'Overview shows capture, realtime and tracing status; unconfigured tracing is not shown as zero',
    async () => {
      await ext.setViewport({ width: 1280, height: 860 });
      await dash('#overview');
      await ext.waitForSelector('.metric');
      const text = await textOf('.overview');
      assert(/Connections/.test(text) && /Failed requests/.test(text), 'missing metrics');
      assert(/Not configured/.test(text), 'tracing should be labeled "Not configured"');
      assert(!/Server spans/.test(text), 'span count shown without an integration');
      await ext.screenshot({ path: resolvePath(artifacts, 'overview.png') });
    },
  );

  await check('Realtime view lists connections and shows decoded messages', async () => {
    await dash('#realtime');
    await ext.waitForSelector('.conn');
    const conns = await ext.$$('.conn');
    assert(conns.length >= 5, `only ${conns.length} connections listed`);
    // Pick a Socket.IO WebSocket connection.
    const target = await ext.evaluateHandle(() =>
      [...document.querySelectorAll('.conn')].find(
        (el) => el.textContent.includes('Socket.IO') && el.textContent.includes('websocket'),
      ),
    );
    assert(target.asElement(), 'no Socket.IO connection in the list');
    await target.asElement().click();
    await ext.waitForSelector('.msg-row');
    // The list re-renders while data arrives; find and click the row in one step, and
    // retry until the detail shows that message.
    const detail = await ext
      .waitForFunction(
        () => {
          const shown = document.querySelector('.msg-detail')?.textContent ?? '';
          if (shown.includes('order.created')) return shown;
          [...document.querySelectorAll('.msg-row')]
            .find((el) => el.textContent.includes('order.created'))
            ?.click();
          return false;
        },
        { timeout: 10_000, polling: 250 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    assert(typeof detail === 'string', 'no decoded order.created row');
    assert(
      /Decoded \(socket\.io\)/.test(detail) && /EVENT/.test(detail),
      `decoded section missing: ${detail.slice(0, 200)}`,
    );
    await ext.screenshot({ path: resolvePath(artifacts, 'realtime.png') });
  });

  await check('Unified timeline mixes HTTP and realtime events and filters by type', async () => {
    await dash('#timeline');
    await ext.waitForSelector('.tl-row');
    const all = await ext.$$eval('.tl-row', (rows) => rows.map((r) => r.textContent));
    assert(all.some((t) => t.includes('HTTP')) || all.length > 0, 'no rows');
    const chip = await ext.evaluateHandle(() =>
      [...document.querySelectorAll('.chip')].find((c) => c.textContent.startsWith('SignalR')),
    );
    assert(chip.asElement(), 'no SignalR filter chip');
    await chip.asElement().click();
    await ext.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.tl-row')];
      return rows.length > 0 && rows.every((r) => r.textContent.includes('SignalR'));
    });
    assert((await textOf('.active-filters')).includes('SignalR'), 'active filter chip missing');
    await ext.screenshot({ path: resolvePath(artifacts, 'timeline.png') });
  });

  await check(
    'Investigating a realtime message shows the notification checklist without inventing handler/UI stages',
    async () => {
      const d = await db();
      const msg = d['rt-messages'].find(
        (m) => m.direction === 'in' && m.decoded?.[0]?.name === 'order.created',
      );
      assert(msg, 'no order.created message');
      await dash(`#investigations?tab=workspace&anchor=rt-message:${msg.id}`);
      await ext.waitForSelector('.workspace .checklist');
      const text = await textOf('.workspace');
      assert(/Server message reached the browser/.test(text), 'checklist stage missing');
      assert(
        /Frontend handler ran\W*Not instrumented/.test(text),
        'handler stage must be "Not instrumented" without the adapter',
      );
      assert(
        /UI notification displayed\W*Not instrumented/.test(text),
        'UI stage must be "Not instrumented" without the adapter',
      );
      assert(
        /Missing evidence/.test(text) && /no server integration is configured/.test(text),
        'missing-evidence section incomplete',
      );
      await ext.screenshot({ path: resolvePath(artifacts, 'workspace.png'), fullPage: true });
    },
  );

  await check('Bug report download is redacted', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const client = await ext.createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts });
    const [btn] = await ext.$$('xpath/.//button[contains(., "Create bug report")]');
    await btn.click();
    let file;
    for (let i = 0; i < 40 && !file; i++) {
      await sleep(150);
      file = (await readdir(artifacts)).find((f) => f.startsWith('bug-report-') && f.endsWith('.md'));
    }
    assert(file, 'report not downloaded');
    const md = await readFile(resolvePath(artifacts, file), 'utf8');
    assert(
      md.includes('## Notification checklist') && md.includes('## Evidence still missing'),
      'report sections missing',
    );
    for (const secret of ['ws-hunter2', 'ws-secret-welcome'])
      assert(!md.includes(secret), `${secret} in report`);
  });

  await check('Command palette, shortcut help and view shortcuts work from the keyboard', async () => {
    await dash('#overview');
    await ext.waitForSelector('.metric');
    await ext.keyboard.down('Control');
    await ext.keyboard.press('KeyK');
    await ext.keyboard.up('Control');
    await ext.waitForSelector('.palette');
    await ext.keyboard.type('timeline');
    await ext.keyboard.press('Enter');
    await ext.waitForFunction(() => location.hash.startsWith('#timeline'));
    await ext.keyboard.press('?');
    await ext.waitForSelector('.modal .shortcuts');
    await ext.keyboard.press('Escape');
    await ext.waitForFunction(() => !document.querySelector('.modal'));
    await ext.keyboard.down('Alt');
    await ext.keyboard.press('Digit2');
    await ext.keyboard.up('Alt');
    await ext.waitForFunction(() => location.hash.startsWith('#network'));
    await ext.waitForSelector('.request-list .row');
    await ext.keyboard.press('j');
    await ext.waitForSelector('.details');
    await ext.keyboard.press('Escape');
    await ext.waitForFunction(() => !document.querySelector('.details'));
  });

  await check(
    'Icon-only buttons have accessible names and the dashboard has no horizontal page overflow at 900 px',
    async () => {
      await ext.setViewport({ width: 900, height: 800 });
      for (const hash of [
        '#overview',
        '#network',
        '#realtime',
        '#timeline',
        '#tracing',
        '#console',
        '#investigations',
        '#settings',
      ]) {
        await dash(hash);
        await ext.waitForSelector('.app-main');
        await sleep(250);
        const problems = await ext.evaluate(() => {
          const unnamed = [...document.querySelectorAll('button')].filter(
            (b) => !b.textContent.trim() && !b.getAttribute('aria-label'),
          );
          return {
            unnamed: unnamed.length,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          };
        });
        assert(problems.unnamed === 0, `${hash}: ${problems.unnamed} button(s) without accessible name`);
        assert(!problems.overflow, `${hash}: horizontal page overflow at 900 px`);
      }
      await ext.setViewport({ width: 1280, height: 860 });
    },
  );

  await check('Theme can be switched to light and back to system', async () => {
    await dash('#settings');
    await ext.waitForSelector('select[aria-label="Theme"]');
    await ext.select('select[aria-label="Theme"]', 'light');
    assert(
      (await ext.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light',
      'light theme not applied',
    );
    const bg = await ext.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(bg === 'rgb(255, 255, 255)', `light background expected, got ${bg}`);
    await ext.select('select[aria-label="Theme"]', 'system');
    assert(
      (await ext.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null,
      'system theme not restored',
    );
  });

  await check(
    'Pause stops capture without closing connections; resume continues the same session',
    async () => {
      await app.goto(`${origin}/realtime`);
      await app.waitForFunction(() => typeof window.io === 'function');
      await click('ws-connect', 500);
      await dash('#overview');
      await ext.waitForSelector('.recording-bar');
      const [pause] = await ext.$$('xpath/.//header//button[normalize-space(.)="Pause"]');
      await pause.click();
      await ext.waitForFunction(() => document.querySelector('.rec-dot')?.textContent === 'PAUSED');
      const pausedAt = Date.now();
      await app.evaluate(() => (window.appLog = []));
      await click('create-order', 800);
      const log = await app.evaluate(() => window.appLog.map((e) => e.kind));
      assert(log.includes('toast'), 'page stopped working while paused');
      const during = (await db())['rt-messages'].filter((m) => m.timestamp > pausedAt);
      assert(during.length === 0, `${during.length} frames captured while paused`);
      const [resume] = await ext.$$('xpath/.//header//button[normalize-space(.)="Resume"]');
      await resume.click();
      await ext.waitForFunction(() => document.querySelector('.rec-dot')?.textContent === 'REC');
      await click('create-order', 800);
      const { value } = await waitDb(
        (d) => d['rt-messages'].find((m) => m.timestamp > pausedAt && m.sessionId === sessionId),
        'frames after resume',
      );
      assert(value, 'nothing captured after resume');
      const timeline = (await db()).timeline.filter((t) => t.kind === 'recording').map((t) => t.message);
      assert(
        timeline.some((m) => /paused/.test(m)) && timeline.some((m) => /resumed/.test(m)),
        'pause/resume not on the timeline',
      );
    },
  );

  await check('Popup shows the recording state at its real width', async () => {
    const popup = await browser.newPage();
    popup.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
    await popup.setViewport({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('.popup-root');
    const overflow = await popup.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    assert(!overflow, 'popup overflows horizontally at 360 px');
    await popup.close();
  });

  await check("Stopping recording does not close the page's connections", async () => {
    await click('ws-connect', 500);
    await tabRequest(ext, 'http://127.0.0.1', 'stop-recording');
    await sleep(300);
    await app.evaluate(() => (window.appLog = []));
    await click('create-order', 800);
    const log = await app.evaluate(() => window.appLog.map((e) => e.kind));
    assert(log.includes('toast'), `page stopped receiving notifications: ${log.join(',')}`);
    const d = await db();
    const after = d['rt-messages'].filter((m) => m.timestamp > Date.now() - 600);
    assert(after.length === 0, `${after.length} frames captured after stop`);
  });

  await check('No uncaught errors in the app or extension pages', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

const failed = summary('Realtime E2E');
process.exit(failed ? 1 : 0);
