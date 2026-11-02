import { afterEach, expect, test } from 'bun:test';
import { createPlatformServer } from '../server.ts';

const platforms = [];
afterEach(async () => { for (const p of platforms.splice(0)) await p.shutdown(); });
async function serve(options = {}) {
  const platform = createPlatformServer({ dbPath: ':memory:', launchEnabled: false, programsEnabled: false, ...options });
  platforms.push(platform);
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  return { ...platform, get: path => fetch(base + path),
    post: (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
const id = '00000000-0000-4000-8000-000000000000', txHash = '0x' + 'ab'.repeat(32);

test('advanced routes dispatch exact shapes; preparation is gated while recovery stays available', async () => {
  const seen = [];
  const advancedService = { status: async () => ({ available: false, reason: 'No advanced deployment profile is configured.' }),
    prepare: async input => { seen.push(['prepare', input]); return { ok: true }; }, submit: async (...args) => { seen.push(['submit', args]); return { status: 'submitted' }; },
    recordStatus: async (...args) => { seen.push(['status', args]); return { status: 'prepared' }; }, reconcile: async () => true };
  const off = await serve({ advancedService });
  expect(await (await off.get('/api/advanced/config')).json()).toEqual({ available: false, reason: 'No advanced deployment profile is configured.' });
  expect((await off.post('/api/advanced/prepare', { name: 'x' })).status).toBe(503);
  expect((await off.post('/api/advanced/submit', { id, txHash })).status).toBe(200);
  expect((await off.post('/api/advanced/status', { id })).status).toBe(200);
  expect((await off.post('/api/advanced/status', { id, extra: 1 })).status).toBe(422);
  expect((await off.post('/api/advanced/submit', { id: 'bad', txHash })).status).toBe(422);
  expect(seen).toEqual([['submit', [id, txHash]], ['status', [id]]]);
  const readiness = await (await off.get('/api/readiness')).json();
  expect(readiness.features.advanced).toMatchObject({ implemented: true, engine: 'plugged-advanced-v1', profileConfigured: false });
  const on = await serve({ advancedService, launchEnabled: true });
  expect(await (await on.post('/api/advanced/prepare', { name: 'x' })).json()).toEqual({ ok: true });
});

test('default advanced service fails closed with no profile and baseline status ignores advanced records', async () => {
  const p = await serve({ launchEnabled: true, advancedProfilePath: null });
  const config = await (await p.get('/api/advanced/config')).json();
  expect(config.available).toBe(false); expect(config.reason).toContain('No advanced deployment profile');
  const response = await p.post('/api/advanced/prepare', { account: '0x1111111111111111111111111111111111111111', name: 'Fixture', symbol: 'FX',
    imageCid: 'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm', markets: [{ quote: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', openingBuy: '1' }] });
  expect(response.status).not.toBe(200);
  p.services.launches().store.save({ id, engine: 'plugged-advanced-v1', fingerprint: 'advanced:x', status: 'prepared', createdAt: 1 });
  expect((await p.post('/api/launches/status', { id })).status).toBe(404);
});
