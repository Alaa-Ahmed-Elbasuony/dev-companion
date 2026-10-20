// Local collector the extension pulls spans from. Loopback only, bearer-token
// protected, and rejects browser pages (any Origin other than an extension).
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Reads DEV_COMPANION_TOKEN, else a persisted token in .dev-companion/token, else creates one. */
export function resolveToken(dir = process.cwd()) {
  if (process.env.DEV_COMPANION_TOKEN) return { token: process.env.DEV_COMPANION_TOKEN, file: null };
  const folder = join(dir, '.dev-companion');
  const file = join(folder, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return { token: existing, file };
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  // Keep the folder out of version control even if the project's .gitignore does not list it.
  writeFileSync(join(folder, '.gitignore'), '*\n');
  return { token, file };
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {{ port: number; token: string; buffer: import('./spans.js').SpanBuffer; service: string }} opts
 * @returns {Promise<import('node:http').Server>}
 */
export function startCollector({ port, token, buffer, service }) {
  const instance = randomUUID();
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (origin?.startsWith('chrome-extension://')) {
        headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-headers'] = 'authorization';
        headers.vary = 'origin';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    // DNS-rebinding protection: only loopback host names.
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOOPBACK_HOSTS.has(host)) return send(403, { error: 'loopback host required' });
    // Web pages must never read traces, even with a guessed token.
    if (origin && !origin.startsWith('chrome-extension://'))
      return send(403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') return send(204, {});
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) {
      return send(401, { error: 'missing or invalid token' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return send(200, {
        ok: true,
        service,
        instance,
        startedAt,
        buffered: buffer.items.length,
        dropped: buffer.dropped,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/spans') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 500) || 500);
      const page = buffer.since(after, limit);
      return send(200, { instance, startedAt, service, dropped: buffer.dropped, ...page });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      // The collector must never keep a dev server process alive on its own.
      server.unref();
      resolve(server);
    });
  });
}
