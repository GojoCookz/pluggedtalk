import { afterEach, expect, test } from 'bun:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_FACTORY_ABI, LAUNCH_REGISTRY_ABI, assertAbiMatchesArtifact, loadAdvancedArtifacts } from '../lib/advanced-abi.mjs';
import { ADVANCED_HOOK_ABI, ADVANCED_SPLITTER_ABI, ADVANCED_FEED_ABI, advancedPoolKey, loadAdvancedMarketArtifacts } from '../lib/advanced-market-abi.mjs';
import { AdvancedLaunchService, FULL_SUPPLY } from '../lib/advanced-launch-service.mjs';
import { AdvancedMarketService } from '../lib/advanced-market-service.mjs';
import { AdvancedTradingService } from '../lib/advanced-trading-service.mjs';
import { AdvancedRewardsService } from '../lib/advanced-rewards-service.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { LaunchStore } from '../lib/launch-store.mjs';
import { RewardsService } from '../lib/rewards-service.mjs';
import { TradingService } from '../lib/trading-service.mjs';
import { TRADING_ABI } from '../lib/trading-abi.mjs';
import { POOL_MANAGER } from '../lib/deployment-profile.mjs';
import { valuation } from '../lib/usd.mjs';
import { QUOTES } from '../lib/config.mjs';
import { createPlatformServer } from '../server.ts';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const account = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222', other = '0x7777777777777777777777777777777777777777';
const factory = '0x3333333333333333333333333333333333333333', launchRegistry = '0x4444444444444444444444444444444444444444';
const pairRegistry = '0x5555555555555555555555555555555555555555', ledger = '0x6666666666666666666666666666666666666666';
const hook = '0x88888888888888888888888888888888888820cc', router = '0x9999999999999999999999999999999999999999';
const splitters = { [WETH]: '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', [USDG]: '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2' };
const feeds = { [WETH]: '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', [USDG]: '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' };
const settings = '0x' + '5e'.repeat(32), key = '0x' + 'ee'.repeat(32), hash = '0x' + 'cd'.repeat(32), blockHash = '0x' + 'ef'.repeat(32);
const routerCode = '0x6001', routerHash = keccak256(routerCode);
const pools = { [WETH]: advancedPoolKey(token, WETH, 60, hook), [USDG]: advancedPoolKey(token, USDG, 60, hook) };
const poolIds = [pools[WETH].poolId, pools[USDG].poolId];
const fixture = { account, name: 'Advanced  fixture', symbol: 'adv', imageCid: 'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm',
  feeBps: 200, creatorBps: 7500, markets: [{ quote: USDG, openingBuy: '1' }, { quote: WETH, openingBuy: '1' }],
  recipients: [{ address: account, bps: 6000 }, { address: other, bps: 4000 }] };
const profile = { engine: 'plugged-advanced-v1', verified: true, verifiedBlock: '103', capabilities: { strictWalletCap: true, maxPools: 4, maxRecipients: 100 },
  deployment: { factory, launchRegistry, pairRegistry, feeHook: hook, tradeRouter: router, poolManager: POOL_MANAGER }, hashes: { tradeRouter: { codeHash: routerHash } } };
const launchArtifacts = await loadAdvancedArtifacts(), marketArtifacts = await loadAdvancedMarketArtifacts();
const stores = [];
const lower = v => JSON.parse(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : typeof x === 'string' ? x.toLowerCase() : x));
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function chain(options = {}) {
  const decimals = { [USDG]: 6, [WETH]: 18, [token]: 18 }, shares = { [account]: 6000n, [other]: 4000n };
  const at = address => typeof address === 'string' ? address.toLowerCase() : address, pairOf = id => [WETH, USDG].find(p => pools[p].poolId === id);
  const reads = ({ address, functionName, args }) => {
    const o = options.reads?.[functionName];
    if (o !== undefined) { const v = typeof o === 'function' ? o({ address: at(address), args }) : o; if (v !== undefined) return v; }
    const a = at(address), feedPair = Object.keys(feeds).find(p => feeds[p] === a), splitPair = Object.keys(splitters).find(p => splitters[p] === a);
    return {
      isApproved: true, pairConfig: { tokenDecimals: decimals[args?.[0]] }, decimals: decimals[a], balanceOf: 10n ** 30n, allowance: 10n ** 30n,
      minDevBuyFor: 1n, economicsHash: settings, predictTokenAddressFor: token, canonicalName: 'ADVANCED FIXTURE', canonicalTicker: 'ADV', fingerprint: key,
      tokenFor: options.registered === false ? zeroAddress : token, isOurs: true, poolsOf: poolIds, pairsOf: [WETH, USDG], name: 'ADVANCED FIXTURE', symbol: 'ADV',
      totalSupply: FULL_SUPPLY, MAX_WALLET_BPS: 300, ledgerOf: ledger, splitterOf: splitters[at(args?.[1])], poolManager: POOL_MANAGER,
      poolConfig: args && pairOf(args[0]) ? [feeds[pairOf(args[0])], pairOf(args[0]), 200, splitters[pairOf(args[0])], 7500, true, 0, 0, 0, 0, 0, 0, 0, zeroAddress] : undefined,
      hook, currency: feedPair ?? splitPair, ledger, marketCapOf: 123456n, graduationProgressBps: 500n, hasGraduated: false,
      pendingFees: 10n, pendingTokenFees: 0n, stuckFeesOf: 5n, planHash: settings, recipientCount: 2n, recipients: [account, other][Number(args?.[0])],
      sharesBps: shares[at(args?.[0])], claimable: 7n, released: 0n,
    }[functionName];
  };
  const calls = [];
  return { calls, client: { getChainId: async () => 4663, getBlockNumber: async () => 106n, readContract: async r => reads(r),
    simulateContract: async call => { calls.push(call); return { result: { approve: true, launch: [token, 2], swap: 1000n, release: 7n, recoverStuckFees: 5n, sweep: 10n }[call.functionName] }; },
    estimateContractGas: async () => 100000n, getGasPrice: async () => 1n, getBalance: async () => 10n ** 18n,
    getCode: async ({ address }) => at(address) === router ? (options.routerCode ?? routerCode) : '0x60016002',
    getBlock: async () => ({ hash: blockHash, timestamp: 1000n }), ...options.client } };
}
function receiptFor(record) {
  const log = (address, abi, eventName, args, types, values) => ({ address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(types, values) });
  return { status: 'success', blockNumber: 104n, blockHash, logs: [
    log(launchRegistry, LAUNCH_REGISTRY_ABI, 'Registered', { key, token }, [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }], ['ADV', 'ADVANCED FIXTURE', settings]),
    ...record.params.markets.map((m, i) => log(factory, ADVANCED_FACTORY_ABI, 'MarketOpened', { token, pair: m.pair }, [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }], [poolIds[i], feeds[m.pair], splitters[m.pair]])),
    log(factory, ADVANCED_FACTORY_ABI, 'AdvancedLaunched', { token, creator: account, economics: settings }, [{ type: 'address' }, { type: 'uint8' }, { type: 'uint8' }], [ledger, 2, 2]),
  ] };
}
async function setup(options = {}) {
  const store = new LaunchStore(':memory:'); stores.push(store);
  const { client, calls } = chain(options);
  const make = c => new AdvancedLaunchService({ store, client: c, artifacts: launchArtifacts, now: () => 1000000, profilePath: options.profilePath === undefined ? 'profile.json' : options.profilePath,
    loadProfile: async () => options.profile ?? profile, verifyProfile: async p => p,
    price: async (q, m) => ({ ...valuation(QUOTES.find(x => x.address === q), '1', m), expiresAt: new Date(1060000).toISOString() }) });
  const record = await make(chain({ registered: false, client: { getBlockNumber: async () => 103n } }).client).prepare(fixture);
  Object.assign(client, { getTransaction: async () => ({ from: account, to: factory, input: record.transaction.data, value: 0n, chainId: 4663, blockNumber: 104n, blockHash }),
    getTransactionReceipt: async () => receiptFor(record), ...options.client });
  const advancedService = make(client);
  if (options.confirm !== false) expect((await advancedService.submit(record.id, hash)).status).toBe('confirmed');
  const markets = new AdvancedMarketService({ advancedService, artifacts: marketArtifacts, now: () => 1000000 });
  const launchService = new LaunchService({ store, client });
  const trading = new AdvancedTradingService({ launchService, marketService: markets, now: () => 1000000, routerHash });
  const rewards = new AdvancedRewardsService({ marketService: markets, now: () => 1000000 });
  return { store, client, calls, advancedService, markets, trading, rewards, launchService, record };
}

test('runtime hook, router, splitter and feed ABIs match the compiled artifacts; drift fails closed', async () => {
  expect(assertAbiMatchesArtifact(ADVANCED_HOOK_ABI, marketArtifacts.hook)).toBe(true);
  expect(assertAbiMatchesArtifact(ADVANCED_SPLITTER_ABI, marketArtifacts.splitter)).toBe(true);
  expect(assertAbiMatchesArtifact(ADVANCED_FEED_ABI, marketArtifacts.feed)).toBe(true);
  const drifted = marketArtifacts.splitter.filter(i => i.name !== 'recoverStuckFees');
  expect(() => assertAbiMatchesArtifact(ADVANCED_SPLITTER_ABI, drifted)).toThrow('drift');
  await expect(loadAdvancedMarketArtifacts({ FeeHook: '/missing/FeeHook.json' })).rejects.toThrow('unavailable');
  expect(advancedPoolKey(token, USDG, 60, hook).key).toEqual({ currency0: token, currency1: USDG, fee: 0, tickSpacing: 60, hooks: hook });
});

test('Discover lists only re-verified advanced launches with their quote pools; baseline unchanged', async () => {
  const f = await setup();
  const list = await f.markets.list();
  expect(list).toMatchObject({ available: true, engine: 'plugged-advanced-v1', unavailable: [], truncated: false });
  expect(list.tokens).toHaveLength(1);
  expect(list.tokens[0]).toMatchObject({ address: token, name: 'ADVANCED FIXTURE', symbol: 'ADV', maxWalletBps: 300, recipients: 2 });
  expect(list.tokens[0].markets.map(m => [m.pool, m.symbol, m.poolId, m.splitter, m.feed])).toEqual([[WETH, 'WETH', poolIds[0], splitters[WETH], feeds[WETH]], [USDG, 'USDG', poolIds[1], splitters[USDG], feeds[USDG]]]);
  expect(list.tokens[0].markets[0]).toMatchObject({ marketCapQuote: '123456', graduationProgressBps: '500', graduated: false });
  expect((await f.launchService.markets()).tokens).toEqual([]);
  expect(f.store.list('confirmed')).toEqual([]);
  expect((await f.markets.detail(token)).markets).toHaveLength(2);
});

test('no verified profile or failed re-verification means not listed and not tradable', async () => {
  const none = await setup(); none.advancedService.profilePath = null; none.markets.cache = null;
  expect(await none.markets.list()).toMatchObject({ available: false, tokens: [] });
  await expect(none.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' })).rejects.toThrow('profile');
  const bad = await setup({ reads: { poolConfig: ({ args }) => args[0] === poolIds[1] ? [feeds[USDG], USDG, 300, splitters[USDG], 7500, true, 0, 0, 0, 0, 0, 0, 0, zeroAddress] : undefined } });
  const list = await bad.markets.list();
  expect(list.tokens).toEqual([]); expect(list.unavailable[0]).toMatchObject({ address: token, reason: expect.stringContaining('Hook pool configuration') });
  const feed = await setup({ reads: { ledger: other } });
  expect((await feed.markets.list()).unavailable[0].reason).toContain('feed binding');
  const moved = await setup(), read = moved.client.readContract;
  moved.client.readContract = async q => q.functionName === 'poolsOf' ? [poolIds[1], poolIds[0]] : read(q);
  expect((await moved.markets.list()).tokens).toEqual([]);
  const elsewhere = await setup({ profile: { ...profile, deployment: { ...profile.deployment, factory: router } }, confirm: false });
  expect((await elsewhere.markets.list()).tokens).toEqual([]);
});

test('per-pool trading routes buy and sell through the verified router with the chosen pool key', async () => {
  const f = await setup();
  const buy = await f.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1', slippageBps: 100 });
  expect(buy).toMatchObject({ next: 'trade', engine: 'plugged-advanced-v1', pool: USDG, poolId: poolIds[1], router, expectedOutput: '1000', minimumOutput: '990' });
  const swap = f.calls.find(c => c.functionName === 'swap');
  expect(swap.address).toBe(router); expect(swap.args[0]).toEqual(pools[USDG].key); expect(swap.args[1]).toBe(false); expect(swap.args[2]).toBe(1000000n);
  const prepared = await f.trading.prepare({ id: buy.id, account });
  expect(prepared.transaction.to).toBe(router);
  expect(lower(decodeFunctionData({ abi: TRADING_ABI, data: prepared.transaction.data }).args)).toEqual(lower([pools[USDG].key, false, 1000000n, 990n, account]));
  const sell = await f.trading.quote({ token, account, pool: WETH, side: 'sell', amount: '5' });
  expect(sell).toMatchObject({ pool: WETH, poolId: poolIds[0], zeroForOne: false });
  expect(sell.inputAsset.address).toBe(token);
  await expect(f.trading.quote({ token, account, pool: other, side: 'buy', amount: '1' })).rejects.toThrow('quote pools');
  await expect(f.trading.quote({ token, account, side: 'buy', amount: '1' })).rejects.toThrow('quote pools');
  // Engines never share reviews.
  const baseline = new TradingService({ launchService: f.launchService });
  await expect(baseline.prepare({ id: buy.id, account })).rejects.toThrow('not found');
  await expect(baseline.quote({ token, account, side: 'buy', amount: '1' })).rejects.toThrow('not a confirmed Plugged launch');
});

test('trade submit verifies the router Traded event for the reviewed pool', async () => {
  const f = await setup();
  const q = await f.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' }), p = await f.trading.prepare({ id: q.id, account });
  const traded = key => ({ address: router, topics: encodeEventTopics({ abi: TRADING_ABI, eventName: 'Traded', args: { trader: account, recipient: account } }),
    data: encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], false, 1000000n, 999n]) });
  const tx = { from: account, to: router, input: p.transaction.data, value: 0n, chainId: 4663, nonce: 1, blockNumber: 107n, blockHash };
  Object.assign(f.client, { getTransaction: async () => tx, getBlockNumber: async () => 110n, getTransactionReceipt: async () => ({ status: 'success', blockNumber: 107n, blockHash, logs: [traded(pools[WETH].key)] }) });
  await expect(f.trading.submit({ id: q.id, txHash: hash })).rejects.toThrow('differs');
  f.client.getTransactionReceipt = async () => ({ status: 'success', blockNumber: 107n, blockHash, logs: [traded(pools[USDG].key)] });
  expect(await f.trading.submit({ id: q.id, txHash: hash })).toMatchObject({ status: 'confirmed', actualOutput: '999' });
});

test('router not pinned, wrong pool manager or stale head blocks advanced trading', async () => {
  const code = await setup({ routerCode: '0x6002' });
  await expect(code.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' })).rejects.toThrow('bytecode');
  const manifest = await setup({ profile: { ...profile, hashes: { tradeRouter: { codeHash: '0x' + '00'.repeat(32) } } } });
  await expect(manifest.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' })).rejects.toThrow('pinned');
  const manager = await setup({ reads: { poolManager: router } });
  await expect(manager.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' })).rejects.toThrow('Pool deployment');
  const stale = await setup(); stale.client.getBlock = async () => ({ hash: blockHash, timestamp: 1n });
  await expect(stale.trading.quote({ token, account, pool: USDG, side: 'buy', amount: '1' })).rejects.toThrow('stale');
});

test('rewards positions verify each per-quote splitter and expose sweep, release and recovery', async () => {
  const f = await setup();
  const r = await f.rewards.positions({ account, chainId: 4663 });
  expect(r).toMatchObject({ available: true, truncated: false });
  const pool = r.positions[0].pools[1];
  expect(pool).toMatchObject({ pool: USDG, poolId: poolIds[1], pendingQuote: '10', feedStuck: '5', splitterStuck: '5', account: { address: account, bps: 6000, claimable: '7' },
    actions: { sweep: true, release: true, 'recover-splitter': true, 'recover-feed': true }, holder: { status: 'unavailable' } });
  expect(pool.splitter.recipients.map(x => [x.address, x.bps])).toEqual([[account, 6000], [other, 4000]]);
  const wrongPlan = await setup({ reads: { planHash: key } });
  expect((await wrongPlan.rewards.positions({ account, chainId: 4663 })).positions[0]).toMatchObject({ status: 'unavailable', error: expect.stringContaining('Splitter') });
  const wrongShare = await setup({ reads: { sharesBps: 5000n } });
  expect((await wrongShare.rewards.positions({ account, chainId: 4663 })).positions[0].status).toBe('unavailable');
  const noProfile = await setup(); noProfile.advancedService.profilePath = null;
  expect(await noProfile.rewards.positions({ account, chainId: 4663 })).toMatchObject({ available: false, positions: [] });
});

test('rewards prepare exact calldata for every per-quote action and refuses redirects', async () => {
  const f = await setup(), base = { account, chainId: 4663, token, pool: USDG };
  const sweep = await f.rewards.prepare({ ...base, action: 'sweep' });
  expect(sweep.transaction.to).toBe(hook);
  expect(lower(decodeFunctionData({ abi: ADVANCED_HOOK_ABI, data: sweep.transaction.data }).args)).toEqual(lower([pools[USDG].key]));
  const release = await f.rewards.prepare({ ...base, action: 'release' });
  expect(release.transaction.to).toBe(splitters[USDG]);
  expect(lower(decodeFunctionData({ abi: ADVANCED_SPLITTER_ABI, data: release.transaction.data }))).toEqual({ functionName: 'release', args: [account] });
  expect((await f.rewards.prepare({ ...base, action: 'release', recipient: other })).expected.recipient).toBe(other);
  await expect(f.rewards.prepare({ ...base, action: 'release', recipient: router })).rejects.toThrow('fixed beneficiary');
  const rs = await f.rewards.prepare({ ...base, action: 'recover-splitter' }), rf = await f.rewards.prepare({ ...base, action: 'recover-feed' });
  expect([rs.transaction.to, rf.transaction.to]).toEqual([splitters[USDG], feeds[USDG]]);
  expect(decodeFunctionData({ abi: ADVANCED_FEED_ABI, data: rf.transaction.data }).functionName).toBe('recoverStuckFees');
  await expect(f.rewards.prepare({ ...base, action: 'recover-feed', recipient: other })).rejects.toThrow('recipient');
  await expect(f.rewards.prepare({ ...base, action: 'holder' })).rejects.toThrow('Unknown');
  const empty = await setup({ reads: { stuckFeesOf: 0n } });
  await expect(empty.rewards.prepare({ ...base, action: 'recover-feed' })).rejects.toThrow('Nothing available');
  // Baseline rewards never accept an advanced preparation.
  const baseline = new RewardsService({ launchService: { client: f.client, store: f.store, deployment: async () => {} }, store: f.rewards.store });
  await expect(baseline.submit({ preparation: { id: release.id }, txHash: hash, account, chainId: 4663 })).rejects.toThrow('not found');
});

test('rewards submit verifies payout events and token transfers; deferred sweeps are reported', async () => {
  const f = await setup(), base = { account, chainId: 4663, token, pool: USDG }, rewardHash = '0x' + 'ab'.repeat(32);
  const launchTx = f.client.getTransaction, launchReceipt = f.client.getTransactionReceipt;
  const transfer = (from, to, value) => ({ address: USDG, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  const run = async (prepared, logs) => {
    const tx = { from: account, to: prepared.transaction.to, input: prepared.transaction.data, value: 0n, chainId: 4663, blockNumber: BigInt(prepared.preparedBlock) + 1n, blockHash };
    Object.assign(f.client, { getTransaction: async q => q.hash === rewardHash ? tx : launchTx(q), getBlockNumber: async () => tx.blockNumber + 2n,
      getTransactionReceipt: async q => q.hash !== rewardHash ? launchReceipt(q) : ({ transactionHash: rewardHash, from: account, to: prepared.transaction.to, status: 'success', blockNumber: tx.blockNumber, blockHash, logs }) });
    return f.rewards.submit({ preparation: { id: prepared.id }, txHash: rewardHash, account, chainId: 4663 });
  };
  const release = await f.rewards.prepare({ ...base, action: 'release' });
  const released = { address: splitters[USDG], topics: encodeEventTopics({ abi: ADVANCED_SPLITTER_ABI, eventName: 'Released', args: { recipient: account, currency: USDG } }), data: encodeAbiParameters([{ type: 'uint256' }], [7n]) };
  await expect(run(release, [released, transfer(splitters[USDG], account, 6n)])).rejects.toThrow('transfer');
  const release2 = await f.rewards.prepare({ ...base, action: 'release' });
  expect(await run(release2, [released, transfer(splitters[USDG], account, 7n)])).toMatchObject({ status: 'confirmed', verified: true });
  const recover = await f.rewards.prepare({ ...base, action: 'recover-splitter' });
  const recovered = { address: splitters[USDG], topics: encodeEventTopics({ abi: ADVANCED_SPLITTER_ABI, eventName: 'StuckFeesRecovered' }), data: encodeAbiParameters([{ type: 'uint256' }], [5n]) };
  expect(await run(recover, [recovered, transfer(hook, splitters[USDG], 5n)])).toMatchObject({ status: 'confirmed' });
  const feeTaken = { address: hook, topics: encodeEventTopics({ abi: ADVANCED_HOOK_ABI, eventName: 'FeeTaken', args: { poolId: poolIds[1] } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [10n, 2n, 6n, 2n]) };
  const sweep = await f.rewards.prepare({ ...base, action: 'sweep' });
  expect(await run(sweep, [feeTaken, transfer(hook, feeds[USDG], 2n)])).toMatchObject({ status: 'payment-deferred' });
  const sweep2 = await f.rewards.prepare({ ...base, action: 'sweep' });
  expect(await run(sweep2, [feeTaken, transfer(hook, feeds[USDG], 2n), transfer(hook, splitters[USDG], 6n)])).toMatchObject({ status: 'confirmed' });
  const sweep3 = await f.rewards.prepare({ ...base, action: 'sweep' });
  expect(await run(sweep3, [])).toMatchObject({ status: 'no-op' });
});

test('HTTP: advanced market, trading and rewards routes dispatch; signing stays gated', async () => {
  const f = await setup();
  const platform = createPlatformServer({ dbPath: ':memory:', launchEnabled: false, programsEnabled: false, advancedService: f.advancedService,
    advancedMarketService: f.markets, advancedTradingService: f.trading, advancedRewardsService: f.rewards });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const markets = await (await fetch(base + '/api/advanced/markets')).json();
    expect(markets.tokens[0].markets.map(m => m.symbol)).toEqual(['WETH', 'USDG']);
    expect((await (await fetch(`${base}/api/advanced/token?address=${token}`)).json()).address).toBe(token);
    expect((await fetch(`${base}/api/advanced/token?address=${other}`)).status).toBe(422);
    const quote = await post('/api/advanced/trading/quote', { token, account, pool: USDG, side: 'buy', amount: '1' });
    expect(quote.status).toBe(200); const q = await quote.json(); expect(q.pool).toBe(USDG);
    expect((await post('/api/advanced/trading/prepare', { id: q.id, account })).status).toBe(503);
    expect((await post('/api/advanced/trading/quote', { token, account, pool: USDG, side: 'buy', amount: '1', extra: 1 })).status).toBe(422);
    expect((await (await post('/api/advanced/rewards/positions', { account, chainId: 4663 })).json()).positions).toHaveLength(1);
    expect((await post('/api/advanced/rewards/prepare', { account, chainId: 4663, action: 'sweep', token, pool: USDG })).status).toBe(503);
    expect((await (await fetch(base + '/api/readiness')).json()).features.advanced).toMatchObject({ markets: '/api/advanced/markets', trading: 'per-pool', holderLedgerClaims: false });
    expect((await (await fetch(base + '/api/markets')).json()).tokens ?? []).toEqual([]);
  } finally { await platform.shutdown(); }
});
