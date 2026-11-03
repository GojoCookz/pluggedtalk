import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseEther, toHex, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
let saltNonce = 0;
import { mnemonicToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { foundry } from '../../app/node_modules/viem/_esm/chains/index.js';
import { FeeVaultService } from '../lib/fee-vault-service.mjs';

// Opt in: PLUGGED_VAULT_INTEGRATION=1 bun test ./plugged/test/fee-vault.integration.test.mjs
// Requires `forge build` artifacts. Ephemeral localhost Anvil; no external RPC, no broadcast elsewhere.
const integration = process.env.PLUGGED_VAULT_INTEGRATION === '1' ? describe : describe.skip;
const mnemonic = 'test test test test test test test test test test test junk';
const accounts = Array.from({ length: 4 }, (_, addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }));
const [deployer, creator, dev, outsider] = accounts;
const artifact = (source, name = source) => JSON.parse(readFileSync(new URL(`../contracts/out/${source}.sol/${name}.json`, import.meta.url), 'utf8'));
const WRITE_ABI = [
  { type: 'function', name: 'createContainer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'uint256' }, { type: 'address' }] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'depositNative', stateMutability: 'payable', inputs: [{ type: 'uint256' }], outputs: [] },
];

integration('fee vault service against a real ephemeral Anvil deployment', () => {
  let proc, client, wallets, service, vault, token;
  beforeAll(async () => {
    const binary = process.env.PLUGGED_ANVIL_BIN || join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
    if (!existsSync(binary)) throw new Error('Existing Anvil required; set PLUGGED_ANVIL_BIN.');
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    proc = Bun.spawn([binary, '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'cancun', '--mnemonic', mnemonic, '--silent'], { stdout: 'ignore', stderr: 'pipe' });
    const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 2000 });
    client = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 10 });
    wallets = accounts.map(account => createWalletClient({ chain: foundry, transport, account, cacheTime: 0 }));
    for (let i = 0; i < 80; i++) { try { if (await client.getChainId() === 31337) break; } catch {} await Bun.sleep(50); }
    const deploy = async (a, args = []) => (await client.waitForTransactionReceipt({ hash: await wallets[0].deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress;
    const vaultArtifact = artifact('PluggedFeeVault'), tokenArtifact = artifact('PluggedFeeVault.t', 'VaultToken');
    vault = await deploy(vaultArtifact); token = await deploy(tokenArtifact);
    await mined(wallets[0].writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'mint', args: [creator.address, parseEther('1000')] }));
    await mined(wallets[1].writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [vault, parseEther('1000')] }));
    const codeHash = keccak256(await client.getCode({ address: vault }));
    service = new FeeVaultService({ client, manifest: { address: vault, codeHash, chainId: 31337 }, chainId: 31337, symbols: { [token.toLowerCase()]: 'VQ' } });
  }, 20000);
  afterAll(async () => { if (proc) { proc.kill(); await proc.exited; } });

  async function mined(promise) { const r = await client.waitForTransactionReceipt({ hash: await promise }); expect(r.status).toBe('success'); return r; }
  const mined2 = mined;
  async function create(currency, window = 0n) {
    const before = await client.readContract({ address: vault, abi: artifact('PluggedFeeVault').abi, functionName: 'containerCount' });
    await mined(wallets[1].writeContract({ address: vault, abi: WRITE_ABI, functionName: 'createContainer', args: [dev.address, currency, window, zeroAddress, `0x${'0'.repeat(64)}`, toHex(++saltNonce, { size: 32 })] }));
    return String(before + 1n);
  }
  async function act(index, action, id, extra = {}) {
    const account = accounts[index].address;
    const prep = await service.prepare({ account, chainId: 31337, action, id, ...extra });
    const t = prep.transaction;
    const hash = await wallets[index].sendTransaction({ to: t.to, data: t.data, gas: BigInt(t.gas) });
    await client.waitForTransactionReceipt({ hash });
    const early = await service.submit({ id: prep.id, txHash: hash, account, chainId: 31337 });
    expect(early.status).toBe('confirming');
    await client.request({ method: 'anvil_mine', params: ['0x2'] });
    const done = await service.submit({ txHash: hash, account, chainId: 31337 }); // stateless re-verification
    expect(done).toMatchObject({ status: 'confirmed', verified: true, action, containerId: id });
    return { prep, done };
  }
  const find = (list, id) => list.find(c => c.id === id);

  test('accept then claim; UI credits equal real vault balances', async () => {
    const id = await create(token);
    await mined(wallets[1].writeContract({ address: vault, abi: WRITE_ABI, functionName: 'deposit', args: [BigInt(id), parseEther('12')] }));
    let view = await service.containers({ account: dev.address, chainId: 31337 });
    let c = find(view.recipient, id);
    expect(c).toMatchObject({ state: 'pending', balance: parseEther('12').toString(), symbol: 'VQ', actions: { accept: true, decline: true, claim: false } });
    const onchain = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault] });
    expect(view.conservation.find(x => x.currency === token.toLowerCase())).toMatchObject({ vaultBalance: onchain.toString(), totalHeld: onchain.toString() });
    await expect(service.prepare({ account: outsider.address, chainId: 31337, action: 'accept', id })).rejects.toThrow('cannot perform');
    await expect(service.prepare({ account: creator.address, chainId: 31337, action: 'reclaim', id })).rejects.toThrow('cannot perform');
    await act(2, 'accept', id);
    // funds pushed to the inbox after acceptance belong to the recipient
    await mined(wallets[1].writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [c.inbox, parseEther('3')] }));
    view = await service.containers({ account: dev.address, chainId: 31337 });
    c = find(view.recipient, id);
    expect(c).toMatchObject({ state: 'accepted', claimable: parseEther('15').toString(), actions: { claim: true } });
    const { prep, done } = await act(2, 'claim', id);
    expect(prep.expected).toMatchObject({ amount: parseEther('15').toString(), payee: dev.address.toLowerCase() });
    expect(done.receipt.args.amount).toBe(parseEther('15').toString());
    expect(await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [dev.address] })).toBe(parseEther('15'));
    const creatorView = await service.containers({ account: creator.address, chainId: 31337 });
    expect(find(creatorView.allocator, id).actions).toMatchObject({ reclaim: false, extend: false });
  });

  test('decline lets the allocator reclaim immediately', async () => {
    const id = await create(token);
    await mined(wallets[1].writeContract({ address: vault, abi: WRITE_ABI, functionName: 'deposit', args: [BigInt(id), parseEther('5')] }));
    const before = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [creator.address] });
    await act(2, 'decline', id);
    await expect(service.prepare({ account: dev.address, chainId: 31337, action: 'accept', id })).rejects.toThrow('cannot perform');
    await act(1, 'reclaim', id);
    expect(await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [creator.address] })).toBe(before + parseEther('5'));
  });

  test('native container expires, can be extended, then reclaimed', async () => {
    const id = await create(zeroAddress, 7n * 86400n);
    await mined(wallets[1].writeContract({ address: vault, abi: WRITE_ABI, functionName: 'depositNative', args: [BigInt(id)], value: parseEther('1') }));
    await client.request({ method: 'evm_increaseTime', params: [7 * 86400] });
    await client.request({ method: 'anvil_mine', params: ['0x1'] });
    let c = find((await service.containers({ account: creator.address, chainId: 31337 })).allocator, id);
    expect(c).toMatchObject({ state: 'expired', symbol: 'ETH', actions: { reclaim: true, extend: true } });
    await expect(service.prepare({ account: dev.address, chainId: 31337, action: 'accept', id })).rejects.toThrow('cannot perform');
    const now = Number((await client.getBlock()).timestamp);
    await expect(service.prepare({ account: creator.address, chainId: 31337, action: 'extend', id, deadline: now + 366 * 86400 })).rejects.toThrow('within 365 days');
    await act(1, 'extend', id, { deadline: now + 3 * 86400 });
    c = find((await service.containers({ account: dev.address, chainId: 31337 })).recipient, id);
    expect(c.state).toBe('pending');
    await client.request({ method: 'evm_increaseTime', params: [4 * 86400] });
    await client.request({ method: 'anvil_mine', params: ['0x1'] });
    const before = await client.getBalance({ address: creator.address });
    const { done } = await act(1, 'reclaim', id);
    expect(done.receipt.args.amount).toBe(parseEther('1').toString());
    expect(await client.getBalance({ address: creator.address })).toBeGreaterThan(before + parseEther('0.99'));
  });

  test('create action: prepared, signed, confirmed; event inbox is the stored inbox and receives fees', async () => {
    await expect(service.prepare({ account: creator.address, chainId: 31337, action: 'create', recipient: creator.address, currency: token, windowDays: 30 })).rejects.toThrow('must differ');
    await expect(service.prepare({ account: creator.address, chainId: 31337, action: 'create', recipient: dev.address, currency: outsider.address, windowDays: 30 })).rejects.toThrow('ETH or a token contract');
    const prep = await service.prepare({ account: creator.address, chainId: 31337, action: 'create', recipient: dev.address, currency: token, windowDays: 10 });
    const count = await client.readContract({ address: vault, abi: artifact('PluggedFeeVault').abi, functionName: 'containerCount' });
    expect(prep.expected).toMatchObject({ predictedId: String(count + 1n), recipient: dev.address.toLowerCase(), currency: token.toLowerCase(), symbol: 'VQ', windowDays: 10 });
    const t = prep.transaction;
    const hash = await wallets[1].sendTransaction({ to: t.to, data: t.data, gas: BigInt(t.gas) });
    const mined = await client.waitForTransactionReceipt({ hash });
    expect(await service.submit({ id: prep.id, txHash: hash, account: creator.address, chainId: 31337 })).toMatchObject({ status: 'confirming', action: 'create' });
    await client.request({ method: 'anvil_mine', params: ['0x2'] });
    await expect(service.submit({ txHash: hash, account: dev.address, chainId: 31337 })).rejects.toThrow('not a vault call from this wallet');
    const done = await service.submit({ txHash: hash, account: creator.address, chainId: 31337 });
    expect(done).toMatchObject({ status: 'confirmed', verified: true, action: 'create', containerId: prep.expected.predictedId, inbox: prep.expected.predictedInbox, recipient: dev.address.toLowerCase(), currency: token.toLowerCase() });
    const block = await client.getBlock({ blockNumber: mined.blockNumber });
    expect(done.deadline).toBe(Number(block.timestamp) + 10 * 86400);
    const stored = await client.readContract({ address: vault, abi: artifact('PluggedFeeVault').abi, functionName: 'getContainer', args: [BigInt(done.containerId)] });
    expect(stored.inbox.toLowerCase()).toBe(done.inbox);
    // Splitter-style push into the inbox: the recipient sees it and it is claimable after acceptance.
    await mined2(wallets[1].writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [done.inbox, parseEther('2')] }));
    const c = find((await service.containers({ account: dev.address, chainId: 31337 })).recipient, done.containerId);
    expect(c).toMatchObject({ state: 'pending', inbox: done.inbox, inboxBalance: parseEther('2').toString(), allocator: creator.address.toLowerCase() });
    await act(2, 'accept', done.containerId);
    const { done: claimed } = await act(2, 'claim', done.containerId);
    expect(claimed.receipt.args.amount).toBe(parseEther('2').toString());
  });

  test('native create action confirms with an ETH container', async () => {
    const prep = await service.prepare({ account: creator.address, chainId: 31337, action: 'create', recipient: dev.address, currency: zeroAddress, windowDays: 7 });
    expect(prep.expected).toMatchObject({ symbol: 'ETH', decimals: 18 });
    const hash = await wallets[1].sendTransaction({ to: prep.transaction.to, data: prep.transaction.data, gas: BigInt(prep.transaction.gas) });
    await client.waitForTransactionReceipt({ hash });
    await client.request({ method: 'anvil_mine', params: ['0x2'] });
    expect(await service.submit({ id: prep.id, txHash: hash, account: creator.address, chainId: 31337 })).toMatchObject({ status: 'confirmed', currency: zeroAddress, inbox: prep.expected.predictedInbox });
  });

  test('submit rejects a transaction from another wallet', async () => {
    const id = await create(token);
    const prep = await service.prepare({ account: dev.address, chainId: 31337, action: 'accept', id });
    const hash = await wallets[2].sendTransaction({ to: prep.transaction.to, data: prep.transaction.data });
    await client.waitForTransactionReceipt({ hash });
    await expect(service.submit({ txHash: hash, account: outsider.address, chainId: 31337 })).rejects.toThrow('not a vault call from this wallet');
  });
});
