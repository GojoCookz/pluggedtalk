import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createJsonApi, publicError } from '../lib/http-api.mjs';

let base, clock = 0, calls = 0, release;
const routes = new Map([
  ['/prepare', { handler: ({ input }) => { calls++; return { amount: 4n, input }; } }],
  ['/small', { maxBytes: 12, handler: () => ({ ok: true }) }],
  ['/limited', { limit: 1, handler: () => ({ ok: true }) }],
  ['/busy', { handler: () => new Promise(resolve => { release = () => resolve({ ok: true }); }) }],
  ['/read', { method: 'GET', handler: ({ query }) => ({ id: query.get('id') }) }],
]);
const api = createJsonApi({ routes, now: () => clock, maxConcurrent: 1 });
const server = createServer(async (req, res) => {
  if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
});
beforeAll(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());
const post = (path, body = '{}', headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('explicit method/path allowlist and query handling', async () => {
  expect((await post('/unknown')).status).toBe(404);
  const method = await fetch(base + '/prepare');
  expect(method.status).toBe(405); expect(method.headers.get('allow')).toBe('POST');
  expect(await (await fetch(base + '/read?id=123')).json()).toEqual({ id: '123' });
});
test('cross-site requests cannot invoke expensive handlers', async () => {
  const before = calls;
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' }]) {
    expect((await post('/prepare', '{}', headers)).status).toBe(403);
  }
  expect(calls).toBe(before);
  expect((await post('/prepare', '{}', { origin: base })).status).toBe(200);
});
test('bad MIME, compressed, malformed, nonobject and oversized bodies fail closed', async () => {
  expect((await post('/prepare', '{}', { 'content-type': 'application/json-fake' })).status).toBe(415);
  expect((await post('/prepare', '{}', { 'content-encoding': 'gzip' })).status).toBe(415);
  expect((await post('/prepare', '{')).status).toBe(400);
  for (const body of ['null', '[]', '"string"']) expect((await post('/prepare', body)).status).toBe(422);
  expect((await post('/small', '{"long":"value"}')).status).toBe(413);
  expect((await post('/small')).status).toBe(200);
});
test('rate limits return retry metadata and recover after window', async () => {
  expect((await post('/limited')).status).toBe(200);
  const denied = await post('/limited'); expect(denied.status).toBe(429); expect(denied.headers.get('retry-after')).toBe('60');
  clock = 60000;
  expect((await post('/limited')).status).toBe(200);
});
test('pending preparation limit releases after completion', async () => {
  const request = post('/busy');
  for (let i = 0; !release && i < 100; i++) await Bun.sleep(5);
  expect(typeof release).toBe('function');
  try { expect((await post('/prepare')).status).toBe(503); }
  finally { release(); }
  expect((await request).status).toBe(200);
  const response = await post('/prepare'); expect(response.status).toBe(200); expect((await response.json()).amount).toBe('4');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
test('provider credentials and verbose payloads are not reflected', () => {
  expect(publicError(new Error('RPC https://host.example/private-key?secret=123 failed Bearer abcdef'))).toBe('RPC [provider] failed Bearer [redacted]');
  expect(publicError(new Error('x'.repeat(900))).length).toBe(600);
  expect(publicError(new Error("ENOENT: open 'C:\\Users\\alice\\plugged\\profile.json'"))).toBe("ENOENT: open '[path]'");
  expect(publicError(new Error('cannot read /home/alice/profile.json, aborting'))).toBe('cannot read [path], aborting');
  expect(publicError(new Error('Pair ETH/USD unavailable'))).toBe('Pair ETH/USD unavailable');
  const previous=process.env.PLUGGED_PINATA_JWT;
  try {
    process.env.PLUGGED_PINATA_JWT='synthetic-private-fixture-token';
    expect(publicError(new Error('failed synthetic-private-fixture-token'))).toBe('failed [redacted]');
    expect(publicError(new Error('api_key=synthetic-provider-value'))).toBe('api_key=[redacted]');
  } finally { if(previous===undefined)delete process.env.PLUGGED_PINATA_JWT;else process.env.PLUGGED_PINATA_JWT=previous; }
});

test('H1: twelve slow-body clients do not starve health or other clients', async () => {
  const { connect } = await import('node:net');
  const slowRoutes = new Map([
    ['/api/health', { method: 'GET', exempt: true, handler: () => ({ ok: true }) }],
    ['/work', { handler: () => ({ ok: true }) }],
  ]);
  const slowApi = createJsonApi({ routes: slowRoutes, bodyTimeoutMs: 5000 });
  const slowServer = createServer(async (req, res) => { if (!await slowApi(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  const port = slowServer.address().port;
  const sockets = [];
  try {
    for (let i = 0; i < 12; i++) {
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise(resolve => socket.once('connect', resolve));
      socket.write('POST /work HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
      sockets.push(socket);
    }
    await Bun.sleep(50);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    // Same loopback peer, but a distinct trusted client: its slots are not held by the slow bodies.
    const other = await fetch(`http://127.0.0.1:${port}/work`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' }, body: '{}' });
    expect(other.status).toBe(200);
  } finally { for (const s of sockets) s.destroy(); slowServer.close(); }
});

test('H2: clients have separate buckets; spoofed header from non-loopback peer is ignored', async () => {
  const { clientKey } = await import('../lib/http-api.mjs');
  let t = 0;
  const limited = new Map([['/one', { limit: 1, handler: () => ({ ok: true }) }]]);
  const h = createJsonApi({ routes: limited, now: () => t });
  const run = async (peer, ip) => {
    let status = 0;
    const res = { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, once() {}, writeHead(s) { status = s; }, end() {} };
    const req = { method: 'POST', complete: true, socket: { remoteAddress: peer }, headers: { 'content-type': 'application/json', ...(ip ? { 'x-real-ip': ip } : {}) },
      on(ev, fn) { if (ev === 'data') queueMicrotask(() => fn(Buffer.from('{}'))); }, once(ev, fn) { if (ev === 'end') setTimeout(fn, 0); }, off() {}, resume() {} };
    await h(req, res, new URL('http://x/one'));
    return status;
  };
  expect(await run('127.0.0.1', '198.51.100.1')).toBe(200);
  expect(await run('127.0.0.1', '198.51.100.1')).toBe(429);
  expect(await run('127.0.0.1', '198.51.100.2')).toBe(200);
  expect(clientKey({ socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-real-ip': '198.51.100.3' } })).toBe('203.0.113.5');
  expect(await run('203.0.113.5', '198.51.100.3')).toBe(200);
  expect(await run('203.0.113.5', '198.51.100.4')).toBe(429);
});
