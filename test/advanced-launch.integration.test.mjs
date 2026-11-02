import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { concat, createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, getAddress, getContractAddress, http, keccak256, parseUnits, toHex } from '../../app/node_modules/viem/_esm/index.js';
import { mnemonicToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { AdvancedLaunchService, advancedSupply } from '../lib/advanced-launch-service.mjs';
import { ADVANCED_FACTORY_ABI } from '../lib/advanced-abi.mjs';
import { CHAIN_ID, CREATE2_DEPLOYER, POOL_MANAGER } from '../lib/deployment-profile.mjs';
import { preparePairApprovals } from '../tools/deployment.mjs';
import { LaunchStore } from '../lib/launch-store.mjs';
import { valuation } from '../lib/usd.mjs';
import { QUOTES } from '../lib/config.mjs';

// Opt in: PLUGGED_ADVANCED_INTEGRATION=1 bun test ./plugged/test/advanced-launch.integration.test.mjs
// Requires `forge build` artifacts in plugged/contracts/out. Private localhost Anvil only (chain id 4663 so the
// production chain checks stay strict); no external RPC, no broadcast elsewhere.
const integration = process.env.PLUGGED_ADVANCED_INTEGRATION === '1' ? describe : describe.skip;
const mnemonic = 'test test test test test test test test test test test junk';
const accounts = Array.from({ length: 6 }, (_, addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }));
const [deployer, creator, outsider, platform, ops, second] = accounts;
const chain = { id: CHAIN_ID, name: 'Robinhood Chain (local Anvil)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } };
const artifact = (source, name = source) => JSON.parse(readFileSync(new URL(`../contracts/out/${source}.sol/${name}.json`, import.meta.url), 'utf8'));
const pick = address => QUOTES.find(q => q.address === address);
// 6-, 8- and 18-decimal catalog quotes, placed at their real catalog addresses.
const USDG = pick('0x5fc5360d0400a0fd4f2af552add042d716f1d168'), CBBTC = pick('0xcec185eb182c47d1ba1efc84e6959e18cd620be4'), CRM = pick('0xd95b44124e475743a7589e68f3d74008a5536d44');
const IMAGE = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

integration('advanced launch service against a real ephemeral Anvil PluggedAdvancedFactory', () => {
  let proc, client, wallets, service, store, dir, deployment, profilePath;
  beforeAll(async () => {
    const binary = process.env.PLUGGED_ANVIL_BIN || join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
    if (!existsSync(binary)) throw new Error('Existing Anvil required; set PLUGGED_ANVIL_BIN.');
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    // The factory runtime is ~29 KB; Anvil gets the same 96 KB limit as contracts/foundry.toml.
    proc = Bun.spawn([binary, '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID), '--hardfork', 'cancun',
      '--code-size-limit', '98304', '--mnemonic', mnemonic, '--silent'], { stdout: 'ignore', stderr: 'pipe' });
    const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 10000 });
    client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 10 });
    wallets = Object.fromEntries(accounts.map(a => [a.address, createWalletClient({ chain, transport, account: a, cacheTime: 0 })]));
    for (let i = 0; i < 100; i++) { try { if (await client.getChainId() === CHAIN_ID) break; } catch {} await Bun.sleep(50); }
    const rpc = (method, params) => client.request({ method, params });
    const deploy = async (from, a, args = []) => {
      const r = await client.waitForTransactionReceipt({ hash: await wallets[from.address].deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) });
      expect(r.status).toBe('success'); return r.contractAddress;
    };
    const patchTo = async (temp, target) => {
      // Relocate a deployed runtime, rewriting any embedded self address (PoolManager's NoDelegateCall immutable).
      const code = (await client.getCode({ address: temp })).toLowerCase().split(temp.slice(2).toLowerCase()).join(target.slice(2).toLowerCase());
      await rpc('anvil_setCode', [target, code]);
      for (let slot = 0; slot < 8; slot++) await rpc('anvil_setStorageAt', [target, toHex(slot, { size: 32 }), await client.getStorageAt({ address: temp, slot: toHex(slot) })]);
    };

    // Environment the real chain already has: canonical PoolManager, CREATE2 proxy, catalog quote tokens.
    await patchTo(await deploy(ops, artifact('PoolManager'), [ops.address]), POOL_MANAGER);
    expect(await client.getCode({ address: CREATE2_DEPLOYER })).not.toBe(undefined);
    const mock = artifact('MockERC20');
    for (const q of [USDG, CBBTC, CRM]) {
      await patchTo(await deploy(ops, mock, [q.name ?? q.symbol, q.symbol, q.decimals]), q.address);
      for (const who of [creator, outsider, second]) await mined(wallets[ops.address].writeContract({ address: q.address, abi: mock.abi, functionName: 'mint', args: [who.address, parseUnits('1000000', q.decimals)] }));
    }

    // Plugged advanced deployment in the exact sequence the deployment tool reserves (nonces n..n+5).
    const startingNonce = await client.getTransactionCount({ address: deployer.address });
    const pairRegistry = await deploy(deployer, artifact('PairRegistry'), [deployer.address]);
    const tokenImplementation = await deploy(deployer, artifact('PluggedAdvancedToken'));
    const satellites = await deploy(deployer, artifact('MultiDeployer'));
    const factory = getContractAddress({ from: deployer.address, nonce: BigInt(startingNonce + 4) });
    const hookArtifact = artifact('FeeHook');
    const init = concat([hookArtifact.bytecode.object, encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [POOL_MANAGER, factory, platform.address])]);
    const hookInitCodeHash = keccak256(init);
    let hookSalt, feeHook;
    for (let i = 0n; ; i++) {
      hookSalt = toHex(i, { size: 32 });
      feeHook = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: hookSalt, bytecodeHash: hookInitCodeHash });
      if ((BigInt(feeHook) & 0x3fffn) === 0x20ccn) break;
    }
    await mined(wallets[deployer.address].sendTransaction({ to: CREATE2_DEPLOYER, data: concat([hookSalt, init]) }));
    expect(getAddress(await deploy(deployer, artifact('PluggedAdvancedFactory'), [POOL_MANAGER, feeHook, pairRegistry, tokenImplementation, satellites]))).toBe(factory);
    const tradeRouter = await deploy(deployer, artifact('TradeRouter'), [POOL_MANAGER]);
    const launchRegistry = await client.readContract({ address: factory, abi: ADVANCED_FACTORY_ABI, functionName: 'registry' });
    deployment = { launcher: factory, factory, pairRegistry, feeHook, tradeRouter, poolManager: POOL_MANAGER, tokenImplementation, launchRegistry, satellites };
    const hashes = {};
    for (const [role, address] of Object.entries(deployment)) {
      const code = await client.getCode({ address });
      hashes[role] = { address, codeHash: keccak256(code), codeBytes: (code.length - 2) / 2 };
    }
    dir = mkdtempSync(join(tmpdir(), 'plugged-advanced-'));
    profilePath = join(dir, 'advanced-deployed.json');
    writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, engine: 'plugged-advanced-v1', status: 'deployed', chainId: CHAIN_ID, independent: true,
      ownerAddress: getAddress(deployer.address), platformRecipientAddress: getAddress(platform.address), platformVolumeBps: 100, maxFeeBps: 1000,
      deployerAddress: getAddress(deployer.address), startingNonce, hookSalt, hookInitCodeHash,
      deployment: Object.fromEntries(Object.entries(deployment).map(([k, v]) => [k, getAddress(v)])),
      hashes: Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, { ...v, address: getAddress(v.address) }])) }, null, 2));

    // Pair approvals come from the deployment tool's unsigned owner transactions.
    const { loadDeploymentProfile } = await import('../lib/deployment-profile.mjs');
    const approvals = await preparePairApprovals(await loadDeploymentProfile({ profilePath }), { client, pairs: [USDG, CBBTC, CRM].map(q => ({ address: q.address, decimals: q.decimals })) });
    expect(approvals.pairs.every(p => p.setupTransaction)).toBe(true);
    for (const p of approvals.pairs) await mined(wallets[deployer.address].sendTransaction({ to: p.setupTransaction.to, data: p.setupTransaction.data }));

    store = new LaunchStore(':memory:');
    service = new AdvancedLaunchService({ store, client, profilePath,
      price: async (q, milestone) => ({ ...valuation(pick(q), '1', milestone), expiresAt: new Date(Date.now() + 60000).toISOString() }) });
  }, 60000);
  afterAll(async () => { if (proc) { proc.kill(); await proc.exited; } if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function mined(promise) { const r = await client.waitForTransactionReceipt({ hash: await promise }); expect(r.status).toBe('success'); return r; }
  const settings = (name, symbol, markets, account = creator) => ({ account: account.address, name, symbol, imageCid: IMAGE, milestoneUsd: '40000', feeBps: 200, markets });
  async function launch(input, account = creator) {
    let prep = await service.prepare(input);
    expect(prep.next).toBe('approve');
    expect(prep.transaction).toBeNull();
    expect(prep.approvals).toHaveLength(input.markets.length);
    for (const a of prep.approvals) await mined(wallets[account.address].sendTransaction({ to: a.transaction.to, data: a.transaction.data }));
    prep = await service.prepare(input);
    expect(prep).toMatchObject({ next: 'launch', approvals: [] });
    expect(prep.simulation.token).toBe(prep.predicted);
    const t = prep.transaction;
    const hash = await wallets[account.address].sendTransaction({ to: t.to, data: t.data, gas: BigInt(t.gas), value: 0n });
    await mined(Promise.resolve(hash));
    const early = await service.submit(prep.id, hash);
    expect(early.status).toBe('submitted');
    await client.request({ method: 'anvil_mine', params: ['0x2'] });
    const done = await service.recordStatus(prep.id);
    return { prep, done, hash };
  }
  async function verifyOnChain(done, n) {
    expect(done).toMatchObject({ status: 'confirmed', token: done.predicted, priceableMarkets: expect.any(Number) });
    expect(done.poolIds).toHaveLength(n);
    const supply = advancedSupply(n);
    expect(await client.readContract({ address: done.token, abi: erc20Abi, functionName: 'totalSupply' })).toBe(supply);
    expect(await client.readContract({ address: deployment.factory, abi: ADVANCED_FACTORY_ABI, functionName: 'isOurs', args: [done.token] })).toBe(true);
    const pairs = await client.readContract({ address: deployment.factory, abi: ADVANCED_FACTORY_ABI, functionName: 'pairsOf', args: [done.token] });
    expect(pairs.map(p => p.toLowerCase())).toEqual(done.params.markets.map(m => m.pair));
  }

  test('profile verifies against the live local deployment', async () => {
    const status = await service.status();
    expect(status).toMatchObject({ available: true, engine: 'plugged-advanced-v1', factory: getAddress(deployment.factory), launchRegistry: getAddress(deployment.launchRegistry) });
    expect(status.capabilities).toMatchObject({ strictWalletCap: true, maxPools: 4, maxRecipients: 100 });
  });

  test('unfunded wallet is told to fund first', async () => {
    const fresh = mnemonicToAccount(mnemonic, { addressIndex: 9 });
    const prep = await service.prepare(settings('Fund Me', 'FUND', [{ quote: USDG.address, openingBuy: '10' }], fresh));
    expect(prep).toMatchObject({ next: 'fund', transaction: null, approvals: [] });
  });

  test('single-pool launch: prepare → approve → launch → submit → confirm', async () => {
    const { done } = await launch(settings('Plugged Solo', 'SOLO', [{ quote: USDG.address, openingBuy: '10' }]));
    await verifyOnChain(done, 1);
    expect(await client.readContract({ address: done.token, abi: erc20Abi, functionName: 'name' })).toBe(done.canonical.name);
    expect(done.canonical).toEqual({ name: 'PLUGGED SOLO', symbol: 'SOLO' });
  });

  test('three-pool launch across 6/8/18-decimal quotes confirms every pool', async () => {
    const { done } = await launch(settings('Plugged Trio', 'TRIO', [
      { quote: CRM.address, openingBuy: '5' }, { quote: USDG.address, openingBuy: '5' }, { quote: CBBTC.address, openingBuy: '5' }]));
    await verifyOnChain(done, 3);
    expect(done.params.markets.map(m => m.pair)).toEqual([USDG.address, CBBTC.address, CRM.address].sort());
  });

  test('two-pool launch, then duplicate name/ticker is refused', async () => {
    const input = settings('Plugged Duo', 'DUO', [{ quote: USDG.address, openingBuy: '5' }, { quote: CRM.address, openingBuy: '5' }]);
    const { done } = await launch(input);
    await verifyOnChain(done, 2);
    await expect(service.prepare(input)).rejects.toThrow('already launched');
    // Canonically equal name/ticker from another wallet with the same economics is refused too.
    await expect(service.prepare({ ...input, account: second.address, name: 'plugged duo', symbol: 'duo' })).rejects.toThrow('already launched');
    // By contract design the key is name + ticker + economics hash, so different economics is a distinct launch.
    expect((await service.prepare({ ...input, feeBps: 300 })).next).toBe('approve');
  });

  test('submit rejects the prepared calldata sent by another wallet', async () => {
    const input = settings('Plugged Foreign', 'FRGN', [{ quote: USDG.address, openingBuy: '10' }]);
    let prep = await service.prepare(input);
    for (const a of prep.approvals) await mined(wallets[creator.address].sendTransaction({ to: a.transaction.to, data: a.transaction.data }));
    prep = await service.prepare(input);
    expect(prep.next).toBe('launch');
    const hash = await wallets[outsider.address].sendTransaction({ to: prep.transaction.to, data: prep.transaction.data, gas: BigInt(prep.transaction.gas) });
    await client.waitForTransactionReceipt({ hash });
    await expect(service.submit(prep.id, hash)).rejects.toThrow('does not match');
    expect(store.get(prep.id).txHash).toBeUndefined();
  });
});
