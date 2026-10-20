// Realtime endpoints for the local test page: raw WebSocket scenarios, a real
// Socket.IO server, a mock SignalR hub (JSON Hub Protocol over WebSockets,
// Server-Sent Events and Long Polling) and an SSE stream. Attached to the
// mock server's HTTP server by attachRealtime().
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Server as SocketIoServer } from 'socket.io';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const RS = '\x1e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared state so "create order" can broadcast to every transport. */
const listeners = new Set();
let orderSeq = 5000;

export function broadcastOrder({ duplicate = false, malformed = false } = {}) {
  const orderId = `o-${++orderSeq}`;
  const requestId = `req-${randomUUID().slice(0, 8)}`;
  const payload = malformed ? { requestId, status: 'created' } : { orderId, requestId, status: 'created' };
  const times = duplicate ? 2 : 1;
  for (let i = 0; i < times; i++) for (const fn of listeners) fn(payload);
  return { orderId, requestId };
}

// ---- raw WebSocket -----------------------------------------------------------

function rawWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const push = (payload) =>
      ws.readyState === 1 && ws.send(JSON.stringify({ type: 'order.created', ...payload }));
    listeners.add(push);
    ws.on('close', () => listeners.delete(push));
    ws.send(JSON.stringify({ type: 'welcome', server: 'dev-companion-test', token: 'ws-secret-welcome' }));
    if (url.searchParams.get('scenario') === 'flaky') {
      // Drops abruptly shortly after connecting: the client sees code 1006.
      setTimeout(() => ws._socket?.destroy(), 300);
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.send(data, { binary: true }); // echo binary
        return;
      }
      const text = data.toString();
      let cmd;
      try {
        cmd = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: 'echo', text }));
        return;
      }
      switch (cmd.cmd) {
        case 'binary':
          ws.send(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), { binary: true });
          break;
        case 'large':
          ws.send(JSON.stringify({ type: 'large', data: 'L'.repeat(200 * 1024) }));
          break;
        case 'malformed':
          ws.send('{"type":"order.created","orderId":');
          break;
        case 'close-1011':
          ws.close(1011, 'Internal server error');
          break;
        case 'drop':
          ws._socket?.destroy();
          break;
        case 'flood':
          for (let i = 0; i < (cmd.n ?? 100); i++) ws.send(JSON.stringify({ type: 'tick', i }));
          break;
        default:
          ws.send(JSON.stringify({ type: 'echo', received: cmd }));
      }
    });
  });
}

// ---- Socket.IO -----------------------------------------------------------------

function socketIo(httpServer) {
  // destroyUpgrade: false leaves the other WebSocket endpoints' upgrades to our own handler.
  const io = new SocketIoServer(httpServer, {
    path: '/socket.io/',
    serveClient: true,
    pingInterval: 5000,
    destroyUpgrade: false,
  });
  const onConnection = (socket) => {
    const push = (payload) => socket.emit('order.created', payload);
    listeners.add(push);
    socket.on('disconnect', () => listeners.delete(push));
    socket.emit('welcome', { id: socket.id });
    socket.on('place-order', (order, ack) => {
      const result = { ok: true, orderId: `sio-${++orderSeq}`, item: order?.item };
      if (typeof ack === 'function') ack(result);
      socket.emit('order.created', { orderId: result.orderId, via: 'socket.io' });
    });
    socket.on('fail-order', (_order, ack) => {
      if (typeof ack === 'function') ack({ ok: false, error: 'OUT_OF_STOCK' });
    });
  };
  io.on('connection', onConnection);
  const admin = io.of('/admin');
  admin.use((socket, next) => {
    if (socket.handshake.auth?.token === 'admin-ok') next();
    else next(new Error('not authorized'));
  });
  admin.on('connection', (socket) => socket.emit('admin.hello', { role: 'admin' }));
  return io;
}

// ---- mock SignalR hub ---------------------------------------------------------------

const HUB = '/hubs/orders';
const hubConnections = new Map(); // token -> connection

function hubConnection(token) {
  let c = hubConnections.get(token);
  if (!c) {
    c = { token, handshaken: false, queue: [], poll: null, sse: null, ws: null, closed: false };
    hubConnections.set(token, c);
  }
  return c;
}

function hubSend(c, message) {
  const frame = JSON.stringify(message) + RS;
  if (c.ws) c.ws.send(frame);
  else if (c.sse) c.sse.write(`data: ${frame}\n\n`);
  else {
    c.queue.push(frame);
    flushPoll(c);
  }
}

function flushPoll(c) {
  if (!c.poll || !c.queue.length) return;
  const res = c.poll;
  c.poll = null;
  clearTimeout(res.timer);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(c.queue.splice(0).join(''));
}

function hubReceive(c, text) {
  for (const record of text.split(RS).filter(Boolean)) {
    let msg;
    try {
      msg = JSON.parse(record);
    } catch {
      continue;
    }
    if (!c.handshaken && msg.protocol) {
      c.handshaken = true;
      hubSend(c, {});
      const push = (payload) => hubSend(c, { type: 1, target: 'OrderCreated', arguments: [payload] });
      c.push = push;
      listeners.add(push);
      continue;
    }
    if (msg.type === 1 && msg.target === 'PlaceOrder') {
      const orderId = `sr-${++orderSeq}`;
      if (msg.invocationId) hubSend(c, { type: 3, invocationId: msg.invocationId, result: { orderId } });
      hubSend(c, { type: 1, target: 'OrderCreated', arguments: [{ orderId, via: 'signalr' }] });
    } else if (msg.type === 1 && msg.target === 'Fail') {
      if (msg.invocationId)
        hubSend(c, { type: 3, invocationId: msg.invocationId, error: 'Hub method failed: OUT_OF_STOCK' });
    } else if (msg.type === 7) {
      hubClose(c);
    }
  }
}

function hubClose(c) {
  c.closed = true;
  if (c.push) listeners.delete(c.push);
  hubConnections.delete(c.token);
  if (c.poll) {
    clearTimeout(c.poll.timer);
    c.poll.writeHead(204);
    c.poll.end();
    c.poll = null;
  }
  c.sse?.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Handles SignalR negotiate, SSE and long-polling HTTP requests. Returns true when handled. */
async function signalRHttp(req, res, url) {
  if (url.pathname === `${HUB}/negotiate` && req.method === 'POST') {
    const token = randomUUID();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        negotiateVersion: 1,
        connectionId: randomUUID(),
        connectionToken: token,
        availableTransports: [
          { transport: 'WebSockets', transferFormats: ['Text', 'Binary'] },
          { transport: 'ServerSentEvents', transferFormats: ['Text'] },
          { transport: 'LongPolling', transferFormats: ['Text', 'Binary'] },
        ],
      }),
    );
    return true;
  }
  if (url.pathname !== HUB) return false;
  const token = url.searchParams.get('id');
  if (!token) {
    res.writeHead(400);
    res.end('Connection ID required');
    return true;
  }
  const c = hubConnection(token);
  if (req.method === 'POST') {
    hubReceive(c, await readBody(req));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
    return true;
  }
  if (req.method === 'DELETE') {
    hubClose(c);
    res.writeHead(202);
    res.end();
    return true;
  }
  if ((req.headers.accept ?? '').includes('text/event-stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(':\n\n');
    c.sse = res;
    req.on('close', () => hubClose(c));
    return true;
  }
  // Long polling: the first poll returns immediately, later polls wait for data (or time out empty).
  if (!c.polled) {
    c.polled = true;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
    return true;
  }
  if (c.closed) {
    res.writeHead(204);
    res.end();
    return true;
  }
  c.poll = res;
  res.timer = setTimeout(() => {
    if (c.poll !== res) return;
    c.poll = null;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  }, 5000);
  flushPoll(c);
  return true;
}

function signalRWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('id') ?? randomUUID();
    const c = hubConnection(token);
    c.ws = ws;
    ws.on('message', (data) => hubReceive(c, data.toString()));
    ws.on('close', () => hubClose(c));
  });
}

// ---- Server-Sent Events --------------------------------------------------------------

const sseClients = new Set();
let sseId = 0;

function sse(req, res, url) {
  if (url.pathname === '/sse/fail') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('stream unavailable');
    return true;
  }
  if (url.pathname !== '/sse/orders') return false;
  const resumeFrom = req.headers['last-event-id'];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`retry: 1500\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ resumedFrom: resumeFrom ?? null })}\n\n`);
  // An event type the test page never subscribes to: only advanced capture can see it.
  res.write(`event: audit\ndata: ${JSON.stringify({ audit: 'stream-opened' })}\n\n`);
  const send = (payload) =>
    res.write(`id: ${++sseId}\nevent: order.created\ndata: ${JSON.stringify(payload)}\n\n`);
  sseClients.add(send);
  listeners.add(send);
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks++;
    res.write(`: keep-alive\n\n`);
    res.write(`id: ${++sseId}\ndata: ${JSON.stringify({ tick: ticks })}\n\n`);
    if (url.searchParams.get('drop') === '1' && ticks === 2) {
      await sleep(10);
      res.socket?.destroy(); // abrupt end: EventSource reconnects with Last-Event-ID
    }
  }, 400);
  req.on('close', () => {
    clearInterval(timer);
    sseClients.delete(send);
    listeners.delete(send);
  });
  return true;
}

// ---- wiring ------------------------------------------------------------------------

export function attachRealtime(httpServer) {
  const raw = new WebSocketServer({ noServer: true });
  const hub = new WebSocketServer({ noServer: true });
  rawWebSocket(raw);
  signalRWebSocket(hub);
  socketIo(httpServer);

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/socket.io/')) return; // handled by socket.io's own listener
    if (url.pathname === '/ws/reject') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (url.pathname === '/ws') raw.handleUpgrade(req, socket, head, (ws) => raw.emit('connection', ws, req));
    else if (url.pathname === HUB)
      hub.handleUpgrade(req, socket, head, (ws) => hub.emit('connection', ws, req));
    else socket.destroy();
  });
}

/** HTTP routes for realtime scenarios. Returns true when the request was handled. */
export async function handleRealtimeHttp(req, res, url) {
  if (url.pathname === '/vendor/signalr.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(await readFile(require.resolve('@microsoft/signalr/dist/browser/signalr.js')));
    return true;
  }
  if (url.pathname === '/api/rt/orders' && req.method === 'POST') {
    await readBody(req);
    await sleep(30);
    const result = broadcastOrder({
      duplicate: url.searchParams.get('dup') === '1',
      malformed: url.searchParams.get('malformed') === '1',
    });
    res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': result.requestId });
    res.end(JSON.stringify(result));
    return true;
  }
  if (sse(req, res, url)) return true;
  return signalRHttp(req, res, url);
}
