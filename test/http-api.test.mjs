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
  const previous=process.env.PLUGGED_PINATA_JWT;
  try {
    process.env.PLUGGED_PINATA_JWT='synthetic-private-fixture-token';
    expect(publicError(new Error('failed synthetic-private-fixture-token'))).toBe('failed [redacted]');
    expect(publicError(new Error('api_key=synthetic-provider-value'))).toBe('api_key=[redacted]');
  } finally { if(previous===undefined)delete process.env.PLUGGED_PINATA_JWT;else process.env.PLUGGED_PINATA_JWT=previous; }
});
