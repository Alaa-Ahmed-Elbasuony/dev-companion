// Upstream API the example app calls during server rendering.
//   node upstream.mjs   -> http://127.0.0.1:3101
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What the upstream received (used by tests to check headers were not modified). */
export const received = [];

export function startUpstream(port = Number(process.env.UPSTREAM_PORT ?? 3101)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    received.push({
      path: url.pathname,
      method: req.method,
      hasAuth: !!req.headers.authorization,
      traceparent: req.headers.traceparent ?? null,
    });
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `up-${received.length}` });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/products') {
      await sleep(40);
      return json(200, [
        { id: 'kbd-1', name: 'Keyboard', price: 49.5, supplierToken: 'upstream-token-secret' },
      ]);
    }
    if (url.pathname === '/inventory') {
      await sleep(60);
      return json(503, { error: 'inventory service unavailable', retryAfter: 5 });
    }
    if (url.pathname === '/legacy-data') {
      await sleep(25);
      return json(200, { legacy: true, items: 3 });
    }
    if (url.pathname === '/slow') {
      await sleep(Number(url.searchParams.get('ms') ?? 800));
      return json(200, { slow: true, tag: url.searchParams.get('tag') });
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = await startUpstream();
  console.log(`Upstream API: http://127.0.0.1:${server.address().port}`);
}
