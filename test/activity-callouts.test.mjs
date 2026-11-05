import { afterEach, expect, test } from 'bun:test';
import { verifyMessage } from '../../app/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { createPlatformServer } from '../server.ts';
import { LaunchStore } from '../lib/launch-store.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { CARBON_DEFAULT as engine } from '../lib/carbon-abi.mjs';
import { QUOTES } from '../lib/config.mjs';
import { cleanCallout, calloutMessage } from '../lib/callout-service.mjs';
import { priceFromSqrt } from '../lib/activity-service.mjs';

const quote = QUOTES.find(q => !q.native);
const token = '0x0000000000000000000000000000000000000abc'; // below every quote address: token is currency0
const poolId = '0x' + 'ab'.repeat(32);
const alice = privateKeyToAccount('0x' + '11'.repeat(32)), mallory = privateKeyToAccount('0x' + '22'.repeat(32));
const creator = alice.address.toLowerCase();
const Q96 = 2n ** 96n;

function fixture() {
  const swaps = [
    { blockNumber: 1005n, transactionHash: '0x' + '01'.repeat(32), logIndex: 0, args: { id: poolId, sender: engine.tradeRouter, amount0: 5n * 10n ** 18n, amount1: -(10n ** BigInt(quote.decimals)), sqrtPriceX96: Q96, liquidity: 1n, tick: 0, fee: 0 } },
    { blockNumber: 2500n, transactionHash: '0x' + '02'.repeat(32), logIndex: 1, args: { id: poolId, sender: engine.tradeRouter, amount0: -(2n * 10n ** 18n), amount1: 10n ** BigInt(quote.decimals) / 2n, sqrtPriceX96: Q96 * 2n, liquidity: 1n, tick: 0, fee: 0 } },
  ];
  const transfers = [
    { blockNumber: 1000n, args: { from: '0x0000000000000000000000000000000000000000', to: engine.poolManager, value: 97n * 10n ** 25n } },
    { blockNumber: 1000n, args: { from: engine.poolManager, to: creator, value: 3n * 10n ** 25n } },
    { blockNumber: 1005n, args: { from: engine.poolManager, to: '0x' + '33'.repeat(20), value: 5n * 10n ** 18n } },
  ];
  const calls = { getLogs: [] };
  const client = {
    getChainId: async () => 4663,
    getBlockNumber: async () => 3002n,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: '0x' + 'cd'.repeat(32), timestamp: 1_800_000_000n + blockNumber }),
    getTransaction: async ({ hash }) => ({ from: hash.endsWith('01') ? '0x' + '44'.repeat(20) : '0x' + '55'.repeat(20) }),
    getLogs: async ({ address, args, fromBlock, toBlock }) => {
      calls.getLogs.push([address.toLowerCase(), fromBlock, toBlock]);
      const inRange = l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock;
      if (address.toLowerCase() === engine.poolManager.toLowerCase()) {
        const ids = [].concat(args.id).map(x => x.toLowerCase());
        return swaps.filter(l => inRange(l) && ids.includes(l.args.id));
      }
      if (address.toLowerCase() === token) return transfers.filter(inRange);
      return [];
    },
    readContract: async ({ functionName, args }) => { if (functionName !== 'balanceOf') throw new Error('unexpected'); return args[0].toLowerCase() === creator ? 3n * 10n ** 25n : 0n; },
  };
  const store = new LaunchStore(':memory:');
  store.save({ id: crypto.randomUUID(), fingerprint: 'f1', status: 'confirmed', createdAt: 1, txHash: '0x' + '0f'.repeat(32), token, poolId, blockNumber: '1000', blockHash: '0x' + 'cd'.repeat(32), launchedAt: 1_800_001_000,
    input: { account: creator, name: 'Test Coin', symbol: 'TEST', quote: quote.address, feeBps: 200, creatorBps: 10000 } });
  return { client, store, calls };
}

const platforms = [];
afterEach(async () => { for (const p of platforms.splice(0)) await p.shutdown(); });
async function serve(extra = {}) {
  const f = fixture();
  let clock = 1_900_000_000_000;
  const launchService = new LaunchService({ store: f.store, client: f.client });
  const platform = createPlatformServer({ dbPath: ':memory:', launchService, verifyMessage, now: () => clock, ...extra });
  platforms.push(platform);
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  return { ...f, platform, tick: ms => { clock += ms; },
    get: path => fetch(base + path).then(async r => ({ status: r.status, body: await r.json() })),
    post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() })) };
}

test('price follows v4 sqrtPriceX96 for both token orderings', () => {
  expect(priceFromSqrt(Q96, true, 18)).toBe(1);
  expect(priceFromSqrt(Q96 * 2n, true, 18)).toBe(4);
  expect(priceFromSqrt(Q96 * 2n, false, 18)).toBe(0.25);
  expect(priceFromSqrt(0n, true, 18)).toBeNull();
});

test('trade tape reads swap logs for a verified launch only, with traders and timestamps', async () => {
  const s = await serve();
  const r = await s.get(`/api/activity/trades?address=${token}`);
  expect(r.status).toBe(200);
  expect(r.body.totalSwaps).toBe(2);
  expect(r.body.trades.map(t => t.side)).toEqual(['sell', 'buy']);
  expect(r.body.trades[1].trader).toBe('0x' + '44'.repeat(20));
  expect(r.body.trades[1].timestamp).toBe(1_800_001_005);
  expect(r.body.trades[0].tokenAmount).toBe((2n * 10n ** 18n).toString());
  expect(r.body.series.length).toBe(2);
  expect(r.body.complete).toBe(true);
  expect(r.body.indexedTo).toBe('3000'); // head minus two confirmations
  // A second read at the same head scans nothing new.
  const before = s.calls.getLogs.length;
  await s.get(`/api/activity/trades?address=${token}`);
  expect(s.calls.getLogs.length).toBe(before);
  expect((await s.get('/api/activity/trades?address=0x0000000000000000000000000000000000000def')).status).toBe(404);
  expect((await s.get('/api/activity/trades?address=nope')).status).toBe(422);
});

test('holder distribution replays transfers and labels the pool and creator', async () => {
  const s = await serve();
  const r = await s.get(`/api/activity/holders?address=${token}`);
  expect(r.status).toBe(200);
  expect(r.body.holderCount).toBe(3);
  expect(r.body.top[0].label).toBe('pool');
  expect(r.body.top[1]).toMatchObject({ address: creator, label: 'creator', bps: 300 });
  expect(r.body.top10WalletBps).toBe(300);
});

test('feed lists verified launches, recent swaps and most-active coins; creator lists launches', async () => {
  const s = await serve();
  const feed = await s.get('/api/activity/feed');
  expect(feed.status).toBe(200);
  expect(feed.body.launches.map(l => l.symbol)).toEqual(['TEST']);
  expect(feed.body.trades.length).toBe(2);
  expect(feed.body.mostActive).toEqual([{ token, name: 'Test Coin', symbol: 'TEST', swaps: 2 }]);
  expect(typeof feed.body.windowSeconds).toBe('number');
  const profile = await s.get(`/api/activity/creator?address=${creator}`);
  expect(profile.body.launches.map(l => l.token)).toEqual([token]);
  expect((await s.get(`/api/activity/creator?address=${'0x' + '99'.repeat(20)}`)).body.launches).toEqual([]);
});

async function sign(s, account, text, ip = '10.0.0.1') {
  const c = await s.post('/api/callouts/challenge', { account: account.address, token, text }, { 'x-real-ip': ip });
  if (c.status !== 200) return { challenge: c };
  const signature = await account.signMessage({ message: c.body.message });
  return { challenge: c, signature, submit: body => s.post('/api/callouts/post', body ?? { nonce: c.body.nonce, signature }, { 'x-real-ip': ip }) };
}

test('wallet-signed callout posts with the on-chain position; forged and replayed signatures fail', async () => {
  const s = await serve();
  const a = await sign(s, alice, 'Holding TEST, the team ships.');
  expect(a.challenge.body.message).toContain('Holding TEST, the team ships.');
  expect(a.challenge.body.message).toContain(`Author: ${creator}`);
  const forged = await mallory.signMessage({ message: a.challenge.body.message });
  expect((await a.submit({ nonce: a.challenge.body.nonce, signature: forged })).status).toBe(401);
  const ok = await a.submit();
  expect(ok.status).toBe(200);
  expect(ok.body.callout).toMatchObject({ author: creator, text: 'Holding TEST, the team ships.', position: (3n * 10n ** 25n).toString(), positionBlock: '3000' });
  expect((await a.submit()).status).toBe(409); // replay of the same challenge
  const list = await s.get(`/api/callouts?token=${token}`);
  expect(list.body.callouts.map(c => c.text)).toEqual(['Holding TEST, the team ships.']);
  expect(list.body.callouts[0].coin.symbol).toBe('TEST');
  expect((await s.get(`/api/callouts?author=${creator}`)).body.callouts.length).toBe(1);
});

test('callout text rules reject spam vectors', async () => {
  expect(cleanCallout('  hi\r\n\n\n\nthere ')).toBe('hi\n\nthere');
  for (const bad of ['', '   ', 'x'.repeat(281), '<img src=x onerror=alert(1)>', 'buy at https://evil.example', 'join t.me/scam', 'see evil.xyz now', 'go www.foo', 'abc\u202edcba', 'zero\u200bwidth', 42])
    expect(() => cleanCallout(bad)).toThrow();
  expect(cleanCallout('🚀'.repeat(280)).length).toBe(560); // counted by code points, not UTF-16 units
  const s = await serve();
  expect((await s.post('/api/callouts/challenge', { account: alice.address, token, text: 'x'.repeat(5000) })).status).toBe(413);
  expect((await s.post('/api/callouts/challenge', { account: alice.address, token, text: 'ok', extra: 1 })).status).toBe(422);
  expect((await s.post('/api/callouts/challenge', { account: alice.address, token: '0x' + '77'.repeat(20), text: 'ok' })).status).toBe(404);
  expect((await s.post('/api/callouts/post', { nonce: 'f'.repeat(32), signature: '0x' + '00'.repeat(65) })).status).toBe(409);
  expect((await s.post('/api/callouts/post', '{"nonce":')).status).toBe(400);
  expect(calloutMessage({ origin: 'o', token, account: creator, nonce: 'n', issuedAt: 'i', text: 't' })).toStartWith('Plugged callout\n');
});

test('per-wallet limits, expiry, report-to-hide and operator modes', async () => {
  const s = await serve();
  for (let i = 0; i < 3; i++) expect((await (await sign(s, alice, `post ${i}`, `10.0.1.${i}`)).submit()).status).toBe(200);
  const fourth = await sign(s, alice, 'post 4', '10.0.1.9');
  expect(fourth.challenge.status).toBe(429);
  s.tick(11 * 60 * 1000);
  const late = await sign(s, alice, 'post later', '10.0.2.1');
  s.tick(11 * 60 * 1000);
  expect((await late.submit()).status).toBe(410); // challenge expired
  const id = (await s.get(`/api/callouts?token=${token}`)).body.callouts[0].id;
  for (const ip of ['10.9.0.1', '10.9.0.1', '10.9.0.2']) expect((await s.post('/api/callouts/report', { id }, { 'x-real-ip': ip })).status).toBe(200);
  expect((await s.get(`/api/callouts?token=${token}`)).body.callouts.some(c => c.id === id)).toBe(true); // two distinct reporters
  await s.post('/api/callouts/report', { id }, { 'x-real-ip': '10.9.0.3' });
  expect((await s.get(`/api/callouts?token=${token}`)).body.callouts.some(c => c.id === id)).toBe(false);
  expect((await s.post('/api/callouts/report', { id: 'nope' })).status).toBe(422);

  const ro = await serve({ calloutMode: 'readonly' });
  expect((await ro.post('/api/callouts/challenge', { account: alice.address, token, text: 'hi' })).status).toBe(503);
  expect((await ro.get('/api/callouts')).body.mode).toBe('readonly');
  const pre = await serve({ calloutMode: 'premoderated' });
  const held = await (await sign(pre, alice, 'needs review')).submit();
  expect(held.body.pendingReview).toBe(true);
  expect((await pre.get(`/api/callouts?token=${token}`)).body.callouts).toEqual([]);
  expect(pre.platform.services.callouts().moderate(held.body.callout.id, false)).toBe(true);
  expect((await pre.get(`/api/callouts?token=${token}`)).body.callouts.length).toBe(1);
  expect(() => createPlatformServer({ dbPath: ':memory:', calloutMode: 'wide-open' })).toThrow();
});

test('cross-site callout posts are refused', async () => {
  const s = await serve();
  expect((await s.post('/api/callouts/challenge', { account: alice.address, token, text: 'hi' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
});
