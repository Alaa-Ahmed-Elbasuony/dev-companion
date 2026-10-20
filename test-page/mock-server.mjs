// Local test page + mock API for manual and automated verification.
//   node test-page/mock-server.mjs            -> http://127.0.0.1:4173
//   PORT=5000 node test-page/mock-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachRealtime, handleRealtimeHttp } from './realtime-server.mjs';

const dir = import.meta.dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

let orderSeq = 1000;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (await handleRealtimeHttp(req, res, url)) return;
  if (path === '/' || path === '/index.html' || path === '/page2' || path === '/realtime') {
    const file = path === '/page2' ? 'page2.html' : path === '/realtime' ? 'realtime.html' : 'index.html';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(await readFile(resolve(dir, file)));
    return;
  }
  if (path === '/api/init')
    return json(res, 200, { user: { id: 7, name: 'Test User' }, features: ['orders'] });
  if (path === '/api/products') {
    if (url.searchParams.get('variant') === 'v2') {
      // Same endpoint with a contract change: price became a string, stock is gone.
      return json(res, 200, [{ id: '123', name: 'Keyboard', price: '49.50' }]);
    }
    return json(res, 200, [
      { id: '123', name: 'Keyboard', price: 49.5, stock: 3 },
      { id: '456', name: 'Mouse', price: 19.0, stock: 0 },
    ]);
  }
  if (path === '/api/orders' && req.method === 'POST') {
    const raw = await readBody(req);
    await sleep(40);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { message: 'Body must be JSON', code: 'BAD_JSON' });
    }
    if (!body.productId) return json(res, 400, { message: 'productId is required', code: 'VALIDATION' });
    if ((body.quantity ?? 1) > 3)
      return json(res, 422, { message: 'Insufficient stock', code: 'OUT_OF_STOCK' });
    return json(res, 201, {
      id: `o-${++orderSeq}`,
      productId: body.productId,
      quantity: body.quantity ?? 1,
      status: 'created',
    });
  }
  if (path === '/api/login' && req.method === 'POST') {
    await readBody(req);
    return json(
      res,
      200,
      { access_token: 'tok-secret-123', user: { name: 'Ada' } },
      { 'set-cookie': 'sid=server-secret; HttpOnly' },
    );
  }
  if (path === '/api/slow') {
    await sleep(Number(url.searchParams.get('ms') ?? 2500));
    return json(res, 200, { slow: true });
  }
  if (path === '/api/error')
    return json(res, 500, { message: 'Database connection lost', requestId: 'req-42' });
  if (path === '/api/redirect') {
    res.writeHead(302, { location: '/api/products' });
    res.end();
    return;
  }
  if (path === '/api/large') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('L'.repeat(1536 * 1024));
    return;
  }
  if (path === '/api/binary') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '8' });
    res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return;
  }
  if (path === '/api/hang') return; // never responds (use with abort)
  if (path === '/api/drop') {
    req.socket.destroy(); // network error: no HTTP response
    return;
  }
  json(res, 404, { message: 'Not found', path });
}

export function startMockServer(port = Number(process.env.PORT ?? 4173), host = '127.0.0.1') {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  attachRealtime(server);
  return new Promise((resolveStart) => {
    server.listen(port, host, () => resolveStart(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = await startMockServer();
  const { port } = server.address();
  console.log(`Dev Companion test page: http://127.0.0.1:${port}/`);
}
