import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, parseUnits, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_FACTORY_ABI, LAUNCH_REGISTRY_ABI, loadAdvancedArtifacts, assertAbiMatchesArtifact, encodeAdvancedLaunch } from '../lib/advanced-abi.mjs';
import { AdvancedLaunchService, advancedInput, buildAdvancedParams, advancedSupply, FULL_SUPPLY } from '../lib/advanced-launch-service.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { LaunchStore } from '../lib/launch-store.mjs';
import { valuation } from '../lib/usd.mjs';
import { QUOTES } from '../lib/config.mjs';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const account = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222';
const factory = '0x3333333333333333333333333333333333333333', launchRegistry = '0x4444444444444444444444444444444444444444';
const pairRegistry = '0x5555555555555555555555555555555555555555', ledger = '0x6666666666666666666666666666666666666666';
const settings = '0x' + '5e'.repeat(32), key = '0x' + 'ee'.repeat(32), hash = '0x' + 'cd'.repeat(32), blockHash = '0x' + 'ef'.repeat(32);
const poolIds = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
export const advancedFixture = { account, name: 'Advanced  fixture', symbol: 'adv', imageCid: 'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm',
  feeBps: 200, creatorBps: 7500, markets: [{ quote: USDG, openingBuy: '1' }, { quote: WETH, openingBuy: '1' }],
  recipients: [{ address: account, bps: 6000 }, { address: '0x7777777777777777777777777777777777777777', bps: 4000 }] };
const artifacts = await loadAdvancedArtifacts();
const profile = { engine: 'plugged-advanced-v1', verified: true, verifiedBlock: '103',
  capabilities: { strictWalletCap: true, maxPools: 4, maxRecipients: 100 }, deployment: { factory, launchRegistry, pairRegistry } };

function setup(options = {}) {
  const store = options.store ?? new LaunchStore(':memory:'), calls = { verify: 0 };
  const decimals = { [USDG]: 6, [WETH]: 18 };
  const reads = ({ address, functionName, args }) => {
    const overrides = options.reads?.[functionName];
    if (overrides !== undefined) return typeof overrides === 'function' ? overrides({ address, args }) : overrides;
    return {
      isApproved: true, pairConfig: { tokenDecimals: decimals[args?.[0]] }, decimals: decimals[address?.toLowerCase()], balanceOf: 10n ** 30n, allowance: 10n ** 30n,
      minDevBuyFor: 1n, economicsHash: settings, predictTokenAddressFor: token, canonicalName: 'ADVANCED FIXTURE', canonicalTicker: 'ADV', fingerprint: key,
      tokenFor: options.registered ? token : zeroAddress, isOurs: true, poolsOf: poolIds, pairsOf: [WETH, USDG], name: 'ADVANCED FIXTURE', symbol: 'ADV',
      totalSupply: FULL_SUPPLY, MAX_WALLET_BPS: 300, ledgerOf: ledger,
    }[functionName];
  };
  const client = { getChainId: async () => 4663, getBlockNumber: async () => 103n, readContract: async request => reads(request),
    simulateContract: async ({ functionName }) => ({ result: functionName === 'approve' ? true : [token, 2] }), estimateContractGas: async () => 1000000n,
    getBlock: async () => ({ hash: blockHash, timestamp: 12345n }), ...options.client };
  const service = new AdvancedLaunchService({ store, client, artifacts, now: () => 1000000, profilePath: 'profile.json',
    loadProfile: async () => options.profile ?? profile, verifyProfile: async p => { calls.verify++; if (options.verifyError) throw new Error(options.verifyError); return p; },
    price: async (q, m) => ({ ...valuation(QUOTES.find(x => x.address === q), '1', m), expiresAt: new Date(1060000).toISOString() }), ...options.service });
  return { store, client, service, calls };
}
function receipt(record, mutate = e => e) {
  const log = (address, abi, eventName, args, types, values) => ({ address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(types, values) });
  const logs = [
    log(launchRegistry, LAUNCH_REGISTRY_ABI, 'Registered', { key, token }, [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }], ['ADV', 'ADVANCED FIXTURE', settings]),
    ...record.params.markets.map((m, i) => log(factory, ADVANCED_FACTORY_ABI, 'MarketOpened', { token, pair: m.pair }, [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }], [poolIds[i], ledger, ledger])),
    log(factory, ADVANCED_FACTORY_ABI, 'AdvancedLaunched', { token, creator: account, economics: settings }, [{ type: 'address' }, { type: 'uint8' }, { type: 'uint8' }], [ledger, 2, 2]),
  ];
  return { status: 'success', blockNumber: 104n, blockHash, logs: mutate(logs) };
}
const transaction = record => ({ from: account, to: factory, input: record.transaction.data, value: 0n, chainId: 4663, blockNumber: 104n });
const confirmable = (record, extra = {}) => ({ getTransaction: async () => transaction(record), getTransactionReceipt: async () => receipt(record), getBlockNumber: async () => 106n, ...extra });

test('runtime ABI matches the compiled factory and registry artifacts and drift fails closed', () => {
  expect(assertAbiMatchesArtifact(ADVANCED_FACTORY_ABI, artifacts.factory)).toBe(true);
  expect(assertAbiMatchesArtifact(LAUNCH_REGISTRY_ABI, artifacts.registry)).toBe(true);
  const params = buildAdvancedParams(advancedInput(advancedFixture), Object.fromEntries([USDG, WETH].map(q => [q, valuation(QUOTES.find(x => x.address === q), '1')])), '0x' + '12'.repeat(32));
  expect(encodeAdvancedLaunch(params, artifacts)).toBe(encodeFunctionData({ abi: artifacts.factory, functionName: 'launch', args: [params] }));
  const drifted = artifacts.factory.map(item => item.name === 'launch' ? { ...item, inputs: [{ ...item.inputs[0], components: item.inputs[0].components.slice(0, -1) }] } : item);
  expect(() => assertAbiMatchesArtifact(ADVANCED_FACTORY_ABI, drifted)).toThrow('drift');
  expect(() => encodeAdvancedLaunch(params, { factory: drifted })).toThrow();
});

test('fails closed without a verified plugged-advanced-v1 deployment', async () => {
  const none = setup({ service: { profilePath: null } });
  await expect(none.service.prepare(advancedFixture)).rejects.toThrow('unavailable');
  expect((await none.service.status())).toMatchObject({ available: false });
  await expect(setup({ profile: { ...profile, engine: 'carbon-baseline-v1' } }).service.prepare(advancedFixture)).rejects.toThrow('not a plugged-advanced-v1');
  const bad = setup({ verifyError: 'Runtime code mismatch: factory' });
  await expect(bad.service.prepare(advancedFixture)).rejects.toThrow('Runtime code mismatch');
  expect(bad.store.list('prepared', 10, 'plugged-advanced-v1')).toEqual([]);
  const ok = setup();expect(await ok.service.status()).toMatchObject({ available: true, factory, maxWalletBps: 300 });
});

test('input validation enforces markets, recipients and vesting policy', () => {
  const bad = [
    { markets: [] }, { markets: [1, 2, 3, 4, 5].map(() => ({ quote: USDG, openingBuy: '1' })) }, { markets: [{ quote: USDG, openingBuy: '1' }, { quote: USDG, openingBuy: '2' }] },
    { markets: [{ quote: zeroAddress, openingBuy: '1' }] }, { markets: [{ quote: USDG, openingBuy: '0.0000001' }] },
    { recipients: [{ address: account, bps: 9999 }] }, { recipients: [{ address: account, bps: 5000 }, { address: account.toUpperCase().replace('0X', '0x'), bps: 5000 }] },
    { recipients: Array.from({ length: 101 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), bps: 1 })) },
    { creatorBps: 0 }, { vestDays: 3 }, { vestDays: 10, cliffDays: 11 }, { referrer: account }, { name: 'é' }, { symbol: 'AB-C' },
  ];
  for (const change of bad) expect(() => advancedInput({ ...advancedFixture, ...change })).toThrow();
  const input = advancedInput({ ...advancedFixture, recipients: undefined });
  expect(input.recipients).toEqual([{ address: account, bps: 10000 }]);
  expect(input.markets.map(m => m.quote)).toEqual([WETH, USDG]);
  expect(advancedInput({ ...advancedFixture, creatorBps: 0, recipients: [] }).recipients).toEqual([]);
  for (const n of [1, 2, 3, 4]) expect(advancedSupply(n) % BigInt(n)).toBe(0n);
  expect(advancedSupply(3)).toBe(FULL_SUPPLY - 1n);
});

test('prepare verifies every time, splits valuation by pool and returns exact factory calldata', async () => {
  const { service, store, calls } = setup();
  const r = await service.prepare(advancedFixture);
  expect(calls.verify).toBe(1); await service.prepare(advancedFixture); expect(calls.verify).toBe(2);
  expect(r.next).toBe('launch'); expect(r.engine).toBe('plugged-advanced-v1'); expect(r.fingerprint).toBe(`advanced:${key}`);
  expect(r.transaction.to).toBe(factory); expect(r.transaction.value).toBe('0x0'); expect(r.transaction.gas).toBe('0x124f80');
  expect(r.params.markets.map(m => m.pair)).toEqual([WETH, USDG]);
  const usdg = valuation(QUOTES.find(q => q.address === USDG), '1');
  expect(r.params.markets[1].openingMarketCap).toBe(((BigInt(usdg.openingQuoteRaw) + 1n) / 2n).toString());
  expect(r.params.markets[1].devBuyPairAmount).toBe(parseUnits('1', 6).toString());
  expect(r.params.recipients).toEqual([account, '0x7777777777777777777777777777777777777777']); expect(r.params.sharesBps).toEqual([6000, 4000]);
  expect(r.params.capToleranceBps).toBe(200); expect(r.canonical).toEqual({ name: 'ADVANCED FIXTURE', symbol: 'ADV' });
  const restored = { ...r.params, supply: BigInt(r.params.supply), vestDuration: 0n, vestCliff: 0n, minShareForQueue: BigInt(r.params.minShareForQueue), metadata: r.params.metadata,
    markets: r.params.markets.map(m => ({ ...m, openingMarketCap: BigInt(m.openingMarketCap), graduationThreshold: BigInt(m.graduationThreshold), devBuyPairAmount: BigInt(m.devBuyPairAmount), minPushPayout: BigInt(m.minPushPayout) })) };
  expect(r.transaction.data).toBe(encodeFunctionData({ abi: artifacts.factory, functionName: 'launch', args: [restored] }));
  expect(store.list('prepared', 10)).toEqual([]); expect(store.list('prepared', 10, 'plugged-advanced-v1')).toHaveLength(2);
});

test('per-quote funding and approvals; nonzero allowances are reset first; on-chain duplicates are refused', async () => {
  const unfunded = await setup({ reads: { balanceOf: ({ address }) => address === WETH ? 0n : 10n ** 30n } }).service.prepare(advancedFixture);
  expect(unfunded.next).toBe('fund'); expect(unfunded.transaction).toBeNull(); expect(unfunded.approvals).toEqual([]);
  const r = await setup({ reads: { allowance: ({ address }) => address === WETH ? 5n : 0n } }).service.prepare(advancedFixture);
  expect(r.next).toBe('approve'); expect(r.transaction).toBeNull(); expect(r.simulation).toBeNull();
  expect(r.approvals.map(a => [a.quote, a.reset])).toEqual([[WETH, true], [USDG, false]]);
  expect(r.approvals[0].transaction.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, 0n] }));
  expect(r.approvals[1].transaction.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, parseUnits('1', 6)] }));
  await expect(setup({ registered: true }).service.prepare(advancedFixture)).rejects.toThrow('already launched');
  await expect(setup().service.prepare({ ...advancedFixture, markets: [{ quote: USDG, openingBuy: '60' }] })).rejects.toThrow('2%');
  await expect(setup({ reads: { decimals: 8 } }).service.prepare(advancedFixture)).rejects.toThrow('decimals');
  await expect(setup({ reads: { isApproved: false } }).service.prepare(advancedFixture)).rejects.toThrow('not approved');
  const revert = Object.assign(new Error('reverted'), { data: { errorName: 'OpeningsDiverge' } });
  await expect(setup({ client: { simulateContract: async () => { throw revert; } } }).service.prepare(advancedFixture)).rejects.toThrow('OpeningsDiverge');
});

test('submit and confirm require exact transaction, two confirmations, events and on-chain pools', async () => {
  const base = setup(); const r = await base.service.prepare(advancedFixture);
  const run = async (client, reads) => { const s = setup({ store: base.store, client: confirmable(r, client), reads, registered: true }); return s.service; };
  await expect((await run({ getTransaction: async () => ({ ...transaction(r), value: 1n }) })).submit(r.id, hash)).rejects.toThrow('does not match');
  await expect((await run({ getTransaction: async () => ({ ...transaction(r), to: token }) })).submit(r.id, hash)).rejects.toThrow('does not match');
  expect((await (await run({ getBlockNumber: async () => 105n })).submit(r.id, hash)).status).toBe('submitted');
  await expect((await run({ getTransactionReceipt: async () => receipt(r, logs => logs.slice(1)) })).recordStatus(r.id)).rejects.toThrow('Expected one');
  await expect((await run({}, { poolsOf: [poolIds[1], poolIds[0]] })).recordStatus(r.id)).rejects.toThrow('On-chain');
  await expect((await run({}, { MAX_WALLET_BPS: 0 })).recordStatus(r.id)).rejects.toThrow('On-chain');
  const confirmed = await (await run({})).recordStatus(r.id);
  expect(confirmed).toMatchObject({ status: 'confirmed', token, poolIds, ledger, blockNumber: '104' });
  await expect((await run({})).submit(r.id, '0x' + '99'.repeat(32))).rejects.toThrow('different transaction');
  // Engines never leak into each other's listings or recovery paths.
  expect(base.store.list('confirmed')).toEqual([]); expect(base.store.list('confirmed', 10, 'plugged-advanced-v1')).toHaveLength(1);
  const baseline = new LaunchService({ store: base.store, client: {} });
  await expect(baseline.submit(r.id, hash)).rejects.toThrow('not found');
  expect((await baseline.markets()).tokens).toEqual([]);
});

test('reverted launches are recorded and restart reconciliation confirms retained submissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugged-advanced-')), path = join(dir, 'launches.sqlite');
  try {
    let store = new LaunchStore(path); const first = setup({ store }); const r = await first.service.prepare(advancedFixture);
    const pending = setup({ store, client: { getTransaction: async () => transaction(r), getTransactionReceipt: async () => { throw Object.assign(new Error('pending'), { name: 'TransactionReceiptNotFoundError' }); } } });
    expect((await pending.service.submit(r.id, hash)).status).toBe('submitted'); store.close();
    store = new LaunchStore(path);
    const offline = setup({ store, service: { profilePath: null } });
    expect(await offline.service.reconcile()).toBe(false); expect(store.get(r.id).status).toBe('submitted');
    const restarted = setup({ store, client: confirmable(r), registered: true });
    expect(await restarted.service.reconcile()).toBe(true); expect(store.get(r.id).status).toBe('confirmed');
    const unregistered = setup({ store, client: confirmable(r) });
    await expect(unregistered.service.confirm(store.get(r.id))).rejects.toThrow('On-chain'); store.close();
    const other = setup(); const q = await other.service.prepare(advancedFixture);
    const reverted = setup({ store: other.store, client: confirmable(q, { getTransactionReceipt: async () => ({ ...receipt(q), status: 'reverted' }) }) });
    expect((await reverted.service.submit(q.id, hash)).status).toBe('reverted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
