import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, keccak256 } from '../../app/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { CashbackIndexer, CASHBACK_INDEX_ABI, cashbackPoolId, cashbackJson } from '../lib/cashback-index.mjs';
import { runCashbackTool } from '../tools/cashback-index.mjs';

// Deterministic test-only keys. Production tooling takes an injected signing interface.
const attestor = privateKeyToAccount('0x' + '11'.repeat(32));
const stranger = privateKeyToAccount('0x' + '12'.repeat(32));
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const trader = addr(10), other = addr(11), currency = addr(20), token = addr(21);
const router = addr(30), hook = addr(31), poolManager = addr(32), program = addr(33);
const bytecode = '0x6001600055';
const key = { currency0: currency, currency1: token, fee: 0, tickSpacing: 60, hooks: hook };
const poolId = cashbackPoolId(key), txHash = hash(1000), blockHash = hash(100), startBlock = 90;
const config = { chainId: 4663, program, currency, attestor: attestor.address, router, hook, poolManager,
  startBlock, confirmations: 3, pools: [key],
  codeHashes: Object.fromEntries(['program', 'currency', 'router', 'hook', 'poolManager'].map(role => [role, keccak256(bytecode)])) };
const cleanup = [];
const temp = join(tmpdir(), 'opencode');
mkdirSync(temp, { recursive: true });
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function event(name, args, address, logIndex, overrides = {}) {
  const abi = CASHBACK_INDEX_ABI.find(item => item.type === 'event' && item.name === name);
  const inputs = abi.inputs.filter(input => !input.indexed);
  return { address, logIndex, transactionHash: txHash, blockHash, blockNumber: 100n, transactionIndex: 0,
    removed: false, topics: encodeEventTopics({ abi: [abi], eventName: name, args }),
    data: encodeAbiParameters(inputs, inputs.map(input => args[input.name])), ...overrides };
}
function fixture({ path = ':memory:', policy = {} } = {}) {
  const state = {
    tx: { hash: txHash, from: trader, to: router, value: 0n, chainId: 4663, blockNumber: 100n, blockHash, transactionIndex: 0,
      input: encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: [key, true, 1000n, 1n, trader] }) },
    receipt: { status: 'success', transactionHash: txHash, from: trader, to: router, blockNumber: 100n, blockHash, transactionIndex: 0, logs: [] },
    finalized: 110n, head: 112n, chainId: 4663, canonicalHash: blockHash,
    code: {}, reads: {}, getLogsCalls: [], transactions: new Map(), receipts: new Map(),
  };
  state.receipt.logs = [
    event('FeeAccrued', { poolId, currency, amount: 30n, isBuy: true }, hook, 0),
    event('Swap', { id: poolId, sender: router, amount0: -970n, amount1: 500n, sqrtPriceX96: 1n << 96n, liquidity: 10000n, tick: 0, fee: 0 }, poolManager, 1),
    event('Transfer', { from: trader, to: poolManager, value: 1000n }, currency, 2),
    event('Traded', { key, trader, recipient: trader, zeroForOne: true, amountIn: 1000n, amountOut: 500n }, router, 3),
  ];
  const client = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => state.head,
    getBlock: async ({ blockNumber, blockTag }) => {
      const number = blockTag === 'finalized' ? state.finalized : blockNumber;
      return { number, hash: number === 100n ? state.canonicalHash : hash(Number(number)), timestamp: 1000n };
    },
    getCode: async ({ address }) => state.code[address.toLowerCase()] ?? ([trader, other].includes(address.toLowerCase()) ? '0x' : bytecode),
    readContract: async ({ functionName, args }) => {
      if (state.reads[functionName] !== undefined) return state.reads[functionName];
      if (functionName === 'voucherDigest') return hashTypedData(indexer.typedData({ trader: args[0], cumulativeFees: args[1], validUntil: args[2], evidence: args[3] }));
      return { CURRENCY: currency, ATTESTOR: attestor.address, poolManager }[functionName];
    },
    getTransaction: async ({ hash }) => state.transactions.get(hash) ?? state.tx,
    getTransactionReceipt: async ({ hash }) => state.receipts.get(hash) ?? state.receipt,
    getLogs: async input => { state.getLogsCalls.push(input); return state.receipt.logs.filter(log => log.address === hook); },
  };
  const indexer = new CashbackIndexer({ client, path, now: () => 1000, ...config, ...policy });
  let closed = false;
  const close = () => { if (!closed) { indexer.close(); closed = true; } };
  cleanup.push(close);
  return { state, client, indexer, close };
}
const expiry = 1100n;

test('receipt-derived fee is persistent, replay-safe, exact bigint and explicitly unsigned', async () => {
  const dir = mkdtempSync(join(temp, 'plugged-cashback-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fees.sqlite');
  const a = fixture({ path });
  expect((await a.indexer.indexTransaction(txHash)).status).toBe('indexed');
  expect((await a.indexer.indexTransaction(txHash.toUpperCase().replace('0X', '0x'))).status).toBe('duplicate');
  const exported = await a.indexer.attest({ trader, validUntil: expiry, cumulativeFees: 999999999n });
  expect(exported.status).toBe('unsigned');
  expect(exported.signerUnavailable).toBe(true);
  expect(exported.signature).toBeUndefined();
  expect(exported.typedData.message.cumulativeFees).toBe(30n);
  expect(exported.receipts[0].codeHashes).toEqual(config.codeHashes);
  expect(exported.typedData.domain).toEqual({ name: 'PluggedCashback', version: '1', chainId: 4663, verifyingContract: program });
  a.close();
  const b = fixture({ path });
  expect((await b.indexer.indexTransaction(txHash)).status).toBe('duplicate');
  expect((await b.indexer.exportAttestation({ trader, validUntil: expiry })).digest).toBe(exported.digest);
  b.close();
});

test('concurrent replay credits one transaction once', async () => {
  const { indexer } = fixture();
  const results = await Promise.all(Array.from({ length: 6 }, () => indexer.indexTransaction(txHash)));
  expect(results.filter(row => row.status === 'indexed')).toHaveLength(1);
  expect((await indexer.exportAttestation({ trader, validUntil: expiry })).typedData.message.cumulativeFees).toBe(30n);
});

test('cumulative totals grow once per receipt and previously signed vouchers remain verifiable', async () => {
  const { indexer, state } = fixture();
  await indexer.indexTransaction(txHash);
  const original = await indexer.attest({ trader, validUntil: expiry, signer: attestor });
  const secondHash = hash(1001), secondBlock = hash(101);
  state.transactions.set(secondHash, { ...state.tx, hash: secondHash, blockNumber: 101n, blockHash: secondBlock });
  state.receipts.set(secondHash, { ...state.receipt, transactionHash: secondHash, blockNumber: 101n, blockHash: secondBlock,
    logs: state.receipt.logs.map(log => ({ ...log, transactionHash: secondHash, blockNumber: 101n, blockHash: secondBlock })) });
  await indexer.indexTransaction(secondHash);
  expect((await indexer.exportAttestation({ trader, validUntil: expiry })).typedData.message.cumulativeFees).toBe(60n);
  expect((await indexer.verifyVoucher(original)).valid).toBe(true);
  await indexer.indexTransaction(secondHash);
  expect((await indexer.exportAttestation({ trader, validUntil: expiry })).typedData.message.cumulativeFees).toBe(60n);
});

test('fees above JavaScript safe-integer range retain every base unit', async () => {
  const { indexer, state } = fixture(), amountIn = 10n ** 24n, fee = 30000000000000000000001n;
  state.tx.input = encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: [key, true, amountIn, 1n, trader] });
  state.receipt.logs = [
    event('FeeAccrued', { poolId, currency, amount: fee, isBuy: true }, hook, 0),
    event('Swap', { id: poolId, sender: router, amount0: -(amountIn - fee), amount1: 500n, sqrtPriceX96: 1n << 96n, liquidity: 10000n, tick: 0, fee: 0 }, poolManager, 1),
    event('Transfer', { from: trader, to: poolManager, value: amountIn }, currency, 2),
    event('Traded', { key, trader, recipient: trader, zeroForOne: true, amountIn, amountOut: 500n }, router, 3),
  ];
  await indexer.indexTransaction(txHash);
  expect((await indexer.exportAttestation({ trader, validUntil: expiry })).typedData.message.cumulativeFees).toBe(fee);
});

test('database cannot be reopened under a different chain, program, allowlist or code policy', async () => {
  const dir = mkdtempSync(join(temp, 'plugged-cashback-policy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fees.sqlite'), a = fixture({ path });
  a.close();
  for (const policy of [{ chainId: 1 }, { program: other }, { codeHashes: { ...config.codeHashes, hook: hash(1) } }, { startBlock: 91 }]) {
    expect(() => fixture({ path, policy })).toThrow('configuration mismatch');
  }
});

test('configured pins and pools are immutable and missing pins fail closed', () => {
  const { indexer } = fixture();
  expect(() => { indexer.config.codeHashes.hook = hash(99); }).toThrow();
  expect(() => { indexer.config.pools[0].currency0 = other; }).toThrow();
  expect(() => fixture({ policy: { codeHashes: {} } })).toThrow('code hash');
  expect(() => fixture({ policy: { pools: [] } })).toThrow('allowlist');
});

const cases = [
  ['reverted receipt', s => { s.receipt.status = 'reverted'; }, 'reverted'],
  ['wrong RPC chain', s => { s.chainId = 1; }, 'chain mismatch'],
  ['wrong transaction chain', s => { s.tx.chainId = 1; }, 'configured chain'],
  ['aggregator top-level call', s => { s.tx.to = other; }, 'direct router'],
  ['receipt sender mismatch', s => { s.receipt.from = other; }, 'direct router'],
  ['transaction identity mismatch', s => { s.tx.hash = hash(9999); }, 'identity mismatch'],
  ['native value', s => { s.tx.value = 1n; }, 'direct router'],
  ['not finalized', s => { s.finalized = 99n; }, 'finalized eligible'],
  ['insufficient confirmations', s => { s.head = 101n; }, 'finalized eligible'],
  ['noncanonical block', s => { s.canonicalHash = hash(991); }, 'Canonical block'],
  ['wrong router bytecode', s => { s.code[router] = '0x6002'; }, 'code hash'],
  ['wrong hook bytecode', s => { s.code[hook] = '0x6002'; }, 'code hash'],
  ['wrong manager bytecode', s => { s.code[poolManager] = '0x6002'; }, 'code hash'],
  ['wrong program bytecode', s => { s.code[program] = '0x6002'; }, 'code hash'],
  ['wrong fee currency bytecode', s => { s.code[currency] = '0x6002'; }, 'code hash'],
  ['wrong program currency', s => { s.reads.CURRENCY = token; }, 'currency or attestor'],
  ['wrong program attestor', s => { s.reads.ATTESTOR = stranger.address; }, 'currency or attestor'],
  ['wrong engine manager', s => { s.reads.poolManager = other; }, 'manager mismatch'],
  ['delegated trader', s => { s.code[trader] = '0xef0100' + other.slice(2); }, 'Smart/delegated'],
  ['unsupported multicall selector', s => { s.tx.input = '0xac9650d8'; }, 'Unsupported router'],
  ['appended calldata', s => { s.tx.input += '00'; }, 'Noncanonical'],
  ['removed log', s => { s.receipt.logs[0].removed = true; }, 'log identity'],
  ['foreign transaction log', s => { s.receipt.logs[0].transactionHash = hash(999); }, 'log identity'],
  ['foreign block log', s => { s.receipt.logs[0].blockHash = hash(999); }, 'log identity'],
  ['duplicate log index', s => { s.receipt.logs[1].logIndex = 0; }, 'log identity'],
  ['forged fee emitter', s => { s.receipt.logs[0].address = other; }, 'missing'],
  ['duplicate fee accrual', s => { s.receipt.logs.push({ ...s.receipt.logs[0], logIndex: 4 }); }, 'Ambiguous'],
  ['missing trader payment', s => { s.receipt.logs.splice(2, 1); }, 'missing'],
  ['fee for wrong pool', s => { s.receipt.logs[0] = event('FeeAccrued', { poolId: hash(999), currency, amount: 30n, isBuy: true }, hook, 0); }, 'Fee event'],
  ['fee in wrong currency', s => { s.receipt.logs[0] = event('FeeAccrued', { poolId, currency: token, amount: 30n, isBuy: true }, hook, 0); }, 'Fee event'],
  ['sell fee', s => { s.receipt.logs[0] = event('FeeAccrued', { poolId, currency, amount: 30n, isBuy: false }, hook, 0); }, 'Fee event'],
  ['fee amount forged against swap', s => { s.receipt.logs[0] = event('FeeAccrued', { poolId, currency, amount: 31n, isBuy: true }, hook, 0); }, 'swap amount'],
  ['payment from another trader', s => { s.receipt.logs[2] = event('Transfer', { from: other, to: poolManager, value: 1000n }, currency, 2); }, 'Trader payment'],
  ['payment short of claimed input', s => { s.receipt.logs[2] = event('Transfer', { from: trader, to: poolManager, value: 999n }, currency, 2); }, 'Trader payment'],
  ['out-of-order settlement', s => { s.receipt.logs[0].logIndex = 4; }, 'event order'],
  ['third-party recipient', s => { s.tx.input = encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: [key, true, 1000n, 1n, other] }); }, 'Recipient'],
  ['unapproved pool key', s => { s.tx.input = encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: [{ ...key, tickSpacing: 120 }, true, 1000n, 1n, trader] }); }, 'Pool is not approved'],
];
for (const [name, mutate, error] of cases) test(`rejects ${name} without recording fees`, async () => {
  const { state, indexer } = fixture(); mutate(state);
  await expect(indexer.indexTransaction(txHash)).rejects.toThrow(error);
  expect(indexer.rows(trader)).toHaveLength(0);
});

test('zero-address recipient follows actual TradeRouter event semantics', async () => {
  const { state, indexer } = fixture();
  state.tx.input = encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: [key, true, 1000n, 1n, addr(0)] });
  state.receipt.logs[3] = event('Traded', { key, trader, recipient: addr(0), zeroForOne: true, amountIn: 1000n, amountOut: 500n }, router, 3);
  expect((await indexer.indexTransaction(txHash)).record.fees).toBe('30');
});

test('signing requires the real attestor and verifies exact EIP-712 message on chain', async () => {
  const { indexer } = fixture();
  await indexer.indexTransaction(txHash);
  await expect(indexer.attest({ trader, validUntil: expiry, signer: stranger })).rejects.toThrow('attestor');
  const signed = await indexer.attest({ trader, validUntil: expiry, signer: attestor });
  expect(signed.status).toBe('signed');
  expect(signed.signerUnavailable).toBe(false);
  expect((await indexer.verifyVoucher(JSON.parse(cashbackJson(signed)))) .valid).toBe(true);
  const tampered = structuredClone(signed);
  tampered.typedData.message.cumulativeFees = 300000n;
  await expect(indexer.verifyVoucher(tampered)).rejects.toThrow('attestor');
  const foreignDomain = structuredClone(signed);
  foreignDomain.typedData.domain.chainId = 1;
  await expect(indexer.verifyVoucher(foreignDomain)).rejects.toThrow('domain');
});

test('even an authorized signer cannot inject fee amounts unsupported by receipt evidence', async () => {
  const { indexer } = fixture(); await indexer.indexTransaction(txHash);
  const voucher = await indexer.exportAttestation({ trader, validUntil: expiry });
  voucher.typedData.message.cumulativeFees = 999999n;
  voucher.signature = await attestor.signTypedData(voucher.typedData);
  delete voucher.digest;
  await expect(indexer.verifyVoucher(voucher)).rejects.toThrow('verified cumulative');
});

test('signed exports reject duplicated or tampered receipt evidence', async () => {
  const { indexer } = fixture(); await indexer.indexTransaction(txHash);
  const signed = await indexer.attest({ trader, validUntil: expiry, signer: attestor });
  const duplicate = structuredClone(signed); duplicate.receipts.push(duplicate.receipts[0]);
  await expect(indexer.verifyVoucher(duplicate)).rejects.toThrow('Duplicated');
  const forged = structuredClone(signed); forged.receipts[0].fees = '999';
  await expect(indexer.verifyVoucher(forged)).rejects.toThrow('canonical ledger');
});

test('signer mutation cannot alter verified payload; receipt change while signing blocks export', async () => {
  const a = fixture(); await a.indexer.indexTransaction(txHash);
  const signer = { signTypedData: async data => { data.message.cumulativeFees = 1n; return attestor.signTypedData(data); } };
  await expect(a.indexer.attest({ trader, validUntil: expiry, signer })).rejects.toThrow('attestor');
  const b = fixture(); await b.indexer.indexTransaction(txHash);
  await expect(b.indexer.attest({ trader, validUntil: expiry, signer: { signTypedData: async data => {
    b.state.canonicalHash = hash(888); return attestor.signTypedData(data);
  } } })).rejects.toThrow('Canonical block');
  expect(b.indexer.meta('halted')).toBeTruthy();
});

test('reorg after indexing halts signing and persists quarantine across restart', async () => {
  const dir = mkdtempSync(join(temp, 'plugged-cashback-reorg-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fees.sqlite'), a = fixture({ path });
  await a.indexer.indexTransaction(txHash);
  a.state.canonicalHash = hash(777);
  await expect(a.indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('Canonical block');
  a.close();
  const b = fixture({ path });
  await expect(b.indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('halted');
  b.close();
});

test('stored amount tampering is detected by receipt revalidation before attestation', async () => {
  const { indexer } = fixture(); await indexer.indexTransaction(txHash);
  const row = indexer.rows(trader)[0], record = JSON.parse(row.record); record.fees = '999999';
  indexer.db.query('UPDATE cashback_fees SET record=? WHERE tx_hash=?').run(cashbackJson(record), txHash);
  await expect(indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('differs from canonical');
  expect(indexer.meta('halted')).toBeTruthy();
});

test('expiry, empty ledger, historical RPC failure and onchain digest mismatch block vouchers', async () => {
  const { indexer, state, client } = fixture();
  await expect(indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('No eligible fees');
  await indexer.indexTransaction(txHash);
  for (const validUntil of [1000n, 999n, 999999999n]) await expect(indexer.exportAttestation({ trader, validUntil })).rejects.toThrow('expiry');
  state.reads.voucherDigest = hash(999);
  await expect(indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('EIP-712 digest');
  delete state.reads.voucherDigest;
  client.getCode = async () => { throw new Error('archive unavailable'); };
  await expect(indexer.exportAttestation({ trader, validUntil: expiry })).rejects.toThrow('archive unavailable');
  expect(indexer.meta('halted')).toBeUndefined();
});

test('scan uses finalized bounded ranges and persists replay-safe cursor', async () => {
  const { indexer, state } = fixture();
  const result = await indexer.scan({ maxBlocks: 21 });
  expect(result.indexed).toBe(1);
  expect(result.caughtUp).toBe(true);
  expect(state.getLogsCalls[0].fromBlock).toBe(90n);
  expect(state.getLogsCalls[0].toBlock).toBe(110n);
  expect((await indexer.scan()).caughtUp).toBe(true);
  expect(state.getLogsCalls).toHaveLength(1);
});

test('scan does not advance cursor on RPC failure', async () => {
  const { indexer, client } = fixture();
  client.getTransactionReceipt = async () => { throw new Error('RPC unavailable'); };
  await expect(indexer.scan()).rejects.toThrow('RPC unavailable');
  expect(indexer.meta('cursor')).toBeUndefined();
});

test('CLI documents unsigned mode and rejects unknown options before any network access', async () => {
  expect((await runCashbackTool(['--help'])).signer).toContain('unsigned');
  await expect(runCashbackTool(['index', '--private-key', '0x123'])).rejects.toThrow('Unknown');
});
