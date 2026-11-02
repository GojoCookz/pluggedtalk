import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, stringToHex,
} from '../../app/node_modules/viem/_esm/index.js';

const ZERO = '0x' + '00'.repeat(20);
const UINT256 = (1n << 256n) - 1n;
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
export const CASHBACK_POOL_TUPLE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const CASHBACK_INDEX_ABI = parseAbi([
  `function swap(${CASHBACK_POOL_TUPLE} key,bool zeroForOne,uint256 amountIn,uint256 minAmountOut,address recipient) returns (uint256 amountOut)`,
  `event Traded(${CASHBACK_POOL_TUPLE} key,address indexed trader,address indexed recipient,bool zeroForOne,uint256 amountIn,uint256 amountOut)`,
  'event FeeAccrued(bytes32 indexed poolId,address currency,uint256 amount,bool isBuy)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function poolManager() view returns (address)',
  'function CURRENCY() view returns (address)',
  'function ATTESTOR() view returns (address)',
  'function voucherDigest(address trader,uint256 cumulativeFees,uint256 validUntil,bytes32 evidence) view returns (bytes32)',
]);
export const FEE_VOUCHER_TYPES = Object.freeze({ FeeVoucher: Object.freeze([
  Object.freeze({ name: 'trader', type: 'address' }),
  Object.freeze({ name: 'cumulativeFees', type: 'uint256' }),
  Object.freeze({ name: 'validUntil', type: 'uint256' }),
  Object.freeze({ name: 'evidence', type: 'bytes32' }),
]) });
export const cashbackJson = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const digest = value => keccak256(stringToHex(cashbackJson(value)));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function address(value, name) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) throw new Error(`Invalid ${name} address`);
  return value.toLowerCase();
}
function bytes32(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw new Error(`Invalid ${name} bytes32`);
  return value.toLowerCase();
}
function uint(value, name) {
  if (!['string', 'bigint', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error(`Invalid ${name}`);
  const n = BigInt(value);
  if (n < 0n || n > UINT256) throw new Error(`Invalid ${name}`);
  return n;
}
export function cashbackPoolId(key) {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}
class Ineligible extends Error {
  constructor(message, code = 'INELIGIBLE') { super(message); this.name = 'CashbackEligibilityError'; this.code = code; }
}
function requireEligible(condition, message, code) { if (!condition) throw new Ineligible(message, code); }

function configuration(input) {
  const config = { schema: 'plugged.cashback-index.v1', chainId: Number(input.chainId),
    startBlock: uint(input.startBlock, 'startBlock').toString(), confirmations: input.confirmations ?? 12,
    maxValiditySeconds: input.maxValiditySeconds ?? 3600 };
  if (!Number.isSafeInteger(config.chainId) || config.chainId < 1) throw new Error('Invalid chainId');
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw new Error('confirmations must be positive');
  if (!Number.isSafeInteger(config.maxValiditySeconds) || config.maxValiditySeconds < 1 || config.maxValiditySeconds > 86400) throw new Error('Invalid maxValiditySeconds');
  for (const role of ['program', 'currency', 'attestor', 'router', 'hook', 'poolManager']) {
    config[role] = address(input[role], role);
    if (config[role] === ZERO) throw new Error(`${role} must be nonzero; only ERC-20 input is supported`);
  }
  config.codeHashes = {};
  for (const role of ['program', 'currency', 'router', 'hook', 'poolManager']) config.codeHashes[role] = bytes32(input.codeHashes?.[role], `${role} code hash`);
  if (!Array.isArray(input.pools) || !input.pools.length) throw new Error('Explicit pool allowlist required');
  config.pools = input.pools.map(key => {
    const p = { currency0: address(key.currency0, 'currency0'), currency1: address(key.currency1, 'currency1'),
      fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: address(key.hooks, 'hooks') };
    if (BigInt(p.currency0) >= BigInt(p.currency1) || !same(p.hooks, config.hook) ||
        ![p.currency0, p.currency1].includes(config.currency) ||
        !Number.isInteger(p.fee) || p.fee < 0 || p.fee > 0xffffff ||
        !Number.isInteger(p.tickSpacing) || p.tickSpacing < 1 || p.tickSpacing > 32767) throw new Error('Invalid approved pool key');
    return { ...p, id: cashbackPoolId(p) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(config.pools.map(p => p.id)).size !== config.pools.length) throw new Error('Duplicate approved pool');
  return config;
}

/** Receipt-only fee ledger. Deployment pins and pool allowlist are trusted operator policy.
 * The RPC must provide honest finalized blocks, historical bytecode and historical eth_call.
 * No native-input, sell conversion, aggregator, proxy-policy or multicall support is inferred.
 */
export class CashbackIndexer {
  constructor({ client, path = ':memory:', now = () => Math.floor(Date.now() / 1000), ...input }) {
    this.client = client;
    this.now = now;
    const config = configuration(input);
    for (const p of config.pools) Object.freeze(p);
    Object.freeze(config.pools); Object.freeze(config.codeHashes);
    this.config = Object.freeze(config);
    this.configHash = digest(config);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cashback_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cashback_fees (
        tx_hash TEXT PRIMARY KEY, trader TEXT NOT NULL, record_hash TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cashback_trader ON cashback_fees(trader);
      CREATE TABLE IF NOT EXISTS cashback_attestations (
        digest TEXT PRIMARY KEY, trader TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT);
    `);
    try {
      this.atomic(() => {
        const old = this.meta('config');
        if (old && old !== this.configHash) throw new Error('Cashback database configuration mismatch');
        this.db.query('INSERT OR IGNORE INTO cashback_meta VALUES (?,?)').run('config', this.configHash);
      });
    } catch (error) { this.db.clearQueryCache(); this.db.close(); throw error; }
    this.queue = Promise.resolve();
  }
  close() { this.db.clearQueryCache(); this.db.close(); }
  atomic(fn) {
    // Explicit SQL avoids Bun 1.3's transaction-controller statements retaining a
    // Windows file handle after Database.close(). No awaits may enter this scope.
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key) { return this.db.query('SELECT value FROM cashback_meta WHERE key=?').get(key)?.value; }
  assertOpen() { const reason = this.meta('halted'); if (reason) throw new Error(`Cashback index halted: ${reason}`); }
  halt(reason) { this.db.query('INSERT OR REPLACE INTO cashback_meta VALUES (?,?)').run('halted', reason); }
  exclusive(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async anchor() {
    this.assertOpen();
    requireEligible(await this.client.getChainId() === this.config.chainId, 'RPC chain mismatch');
    // Fail closed when the network/RPC does not implement finalized block semantics.
    const [finalized, head] = await Promise.all([this.client.getBlock({ blockTag: 'finalized' }), this.client.getBlockNumber()]);
    requireEligible(typeof finalized.number === 'bigint' && finalized.hash && typeof finalized.timestamp === 'bigint', 'Finalized block unavailable');
    const safe = head - BigInt(this.config.confirmations) + 1n;
    requireEligible(safe >= 0n, 'Insufficient confirmations');
    const number = finalized.number < safe ? finalized.number : safe;
    const block = number === finalized.number ? finalized : await this.client.getBlock({ blockNumber: number });
    requireEligible(block.number === number && block.hash, 'Invalid canonical anchor');
    return block;
  }
  async canonical(number, hash) {
    const block = await this.client.getBlock({ blockNumber: number });
    requireEligible(block.number === number && same(block.hash, hash), 'Canonical block changed', 'REORG');
    return block;
  }
  async deployment(blockNumber) {
    const c = this.config;
    await Promise.all(Object.entries(c.codeHashes).map(async ([role, expected]) => {
      const code = await this.client.getCode({ address: c[role], blockNumber });
      requireEligible(code && code !== '0x' && same(keccak256(code), expected), `${role} code hash mismatch`);
    }));
    const read = (target, functionName) => this.client.readContract({ address: target, abi: CASHBACK_INDEX_ABI, functionName, blockNumber });
    const [currency, attestor, routerManager, hookManager] = await Promise.all([
      read(c.program, 'CURRENCY'), read(c.program, 'ATTESTOR'), read(c.router, 'poolManager'), read(c.hook, 'poolManager'),
    ]);
    requireEligible(same(currency, c.currency) && same(attestor, c.attestor), 'Program currency or attestor mismatch');
    requireEligible(same(routerManager, c.poolManager) && same(hookManager, c.poolManager), 'Engine manager mismatch');
  }
  events(receipt, target, eventName) {
    const event = CASHBACK_INDEX_ABI.find(x => x.type === 'event' && x.name === eventName);
    return receipt.logs.filter(log => same(log.address, target)).flatMap(log => {
      try {
        const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true });
        return [{ ...decoded.args, logIndex: log.logIndex }];
      } catch { return []; }
    });
  }
  async verifyReceipt(transactionHash, anchor) {
    const hash = bytes32(transactionHash, 'transaction hash'), c = this.config;
    const [receipt, tx] = await Promise.all([
      this.client.getTransactionReceipt({ hash }), this.client.getTransaction({ hash }),
    ]);
    requireEligible(receipt.status === 'success', 'Transaction reverted');
    requireEligible(typeof receipt.blockNumber === 'bigint' && receipt.blockNumber >= BigInt(c.startBlock) && receipt.blockNumber <= anchor.number, 'Transaction outside finalized eligible range');
    requireEligible(same(receipt.transactionHash, hash) && same(tx.hash, hash) && same(tx.blockHash, receipt.blockHash) && tx.blockNumber === receipt.blockNumber, 'Receipt/transaction identity mismatch');
    requireEligible(tx.chainId === c.chainId && same(tx.to, c.router) && same(receipt.to, c.router) && same(tx.from, receipt.from) && tx.value === 0n, 'Not a direct router transaction on the configured chain');
    const trader = address(tx.from, 'trader');
    requireEligible(trader !== ZERO && trader !== c.program, 'Invalid trader');
    requireEligible(Number.isSafeInteger(receipt.transactionIndex) && receipt.transactionIndex >= 0 && tx.transactionIndex === receipt.transactionIndex, 'Transaction index mismatch');
    await this.canonical(receipt.blockNumber, receipt.blockHash);
    await this.deployment(receipt.blockNumber);
    const traderCode = await Promise.all([receipt.blockNumber, receipt.blockNumber > 0n ? receipt.blockNumber - 1n : 0n]
      .map(blockNumber => this.client.getCode({ address: trader, blockNumber })));
    requireEligible(traderCode.every(code => !code || code === '0x'), 'Smart/delegated accounts are not eligible');
    let decoded;
    try { decoded = decodeFunctionData({ abi: CASHBACK_INDEX_ABI, data: tx.input }); }
    catch { throw new Ineligible('Unsupported router calldata'); }
    requireEligible(decoded.functionName === 'swap', 'Only direct swap is eligible');
    requireEligible(same(encodeFunctionData({ abi: CASHBACK_INDEX_ABI, functionName: 'swap', args: decoded.args }), tx.input), 'Noncanonical router calldata');
    const [key, zeroForOne, amountIn, minAmountOut, recipient] = decoded.args;
    const poolId = cashbackPoolId(key);
    requireEligible(c.pools.some(p => same(p.id, poolId)), 'Pool is not approved');
    requireEligible(same(zeroForOne ? key.currency0 : key.currency1, c.currency), 'Only program-currency buys are eligible');
    requireEligible(same(recipient, trader) || same(recipient, ZERO), 'Recipient must be the paying trader');
    requireEligible(amountIn > 0n && amountIn < (1n << 127n), 'Invalid exact input');
    const indices = new Set();
    for (const log of receipt.logs) {
      requireEligible(!log.removed && same(log.transactionHash, hash) && same(log.blockHash, receipt.blockHash) &&
        log.blockNumber === receipt.blockNumber && log.transactionIndex === receipt.transactionIndex &&
        Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !indices.has(log.logIndex), 'Invalid or duplicated receipt log identity');
      indices.add(log.logIndex);
    }
    const fees = this.events(receipt, c.hook, 'FeeAccrued');
    const trades = this.events(receipt, c.router, 'Traded');
    const swaps = this.events(receipt, c.poolManager, 'Swap');
    const payments = this.events(receipt, c.currency, 'Transfer');
    requireEligible(fees.length === 1 && trades.length === 1 && swaps.length === 1 && payments.length === 1, 'Ambiguous or missing fee/trade/swap/payment events');
    const [fee] = fees, [trade] = trades, [swap] = swaps, [payment] = payments;
    requireEligible(same(fee.poolId, poolId) && same(fee.currency, c.currency) && fee.isBuy === true && fee.amount > 0n && fee.amount < amountIn, 'Fee event does not match eligible buy');
    requireEligible(same(trade.trader, trader) && same(trade.recipient, recipient) && same(cashbackPoolId(trade.key), poolId) &&
      trade.zeroForOne === zeroForOne && trade.amountIn === amountIn && trade.amountOut >= minAmountOut && trade.amountOut > 0n, 'Router trade attribution mismatch');
    requireEligible(same(swap.id, poolId) && same(swap.sender, c.router) &&
      (zeroForOne ? swap.amount0 : swap.amount1) === -(amountIn - fee.amount) &&
      (zeroForOne ? swap.amount1 : swap.amount0) === trade.amountOut, 'Pool swap amount or router mismatch');
    requireEligible(same(payment.from, trader) && same(payment.to, c.poolManager) && payment.value === amountIn, 'Trader payment does not settle the fee-bearing input');
    requireEligible(fee.logIndex < swap.logIndex && swap.logIndex < payment.logIndex && payment.logIndex < trade.logIndex, 'Unexpected settlement event order');
    await this.canonical(receipt.blockNumber, receipt.blockHash);
    return { schema: 'plugged.eligible-fee.v1', configHash: this.configHash, chainId: c.chainId, program: c.program,
      txHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase(), transactionIndex: receipt.transactionIndex,
      feeLogIndex: fee.logIndex, tradeLogIndex: trade.logIndex, swapLogIndex: swap.logIndex, paymentLogIndex: payment.logIndex,
      trader, router: c.router, hook: c.hook, poolManager: c.poolManager, poolId, currency: c.currency,
      amountIn: amountIn.toString(), amountOut: trade.amountOut.toString(), fees: fee.amount.toString(),
      calldataHash: keccak256(tx.input), receiptLogsHash: digest(receipt.logs.map(l => ({ address: l.address.toLowerCase(), data: l.data.toLowerCase(), topics: l.topics.map(t => t.toLowerCase()), logIndex: l.logIndex }))),
      codeHashes: c.codeHashes };
  }
  indexTransaction(transactionHash) {
    return this.exclusive(async () => {
      const hash = bytes32(transactionHash, 'transaction hash');
      const old = this.db.query('SELECT * FROM cashback_fees WHERE tx_hash=?').get(hash);
      let record;
      try { record = await this.verifyReceipt(hash, await this.anchor()); }
      catch (error) { if (old && error.code === 'REORG') this.halt(`${hash}: ${error.message}`); throw error; }
      const recordHash = digest(record);
      return this.atomic(() => {
        this.assertOpen();
        const current = this.db.query('SELECT * FROM cashback_fees WHERE tx_hash=?').get(hash);
        if (current && (current.record_hash !== recordHash || current.record !== cashbackJson(record))) {
          // Persist the halt outside the transaction rollback below.
          throw new Ineligible('Previously indexed receipt changed', 'REORG');
        }
        this.db.query('INSERT OR IGNORE INTO cashback_fees VALUES (?,?,?,?)').run(hash, record.trader, recordHash, cashbackJson(record));
        return { status: current ? 'duplicate' : 'indexed', record, recordHash };
      });
    }).catch(error => { if (error.code === 'REORG') this.halt(error.message); throw error; });
  }
  async scan({ maxBlocks = 1000 } = {}) {
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10000) throw new Error('maxBlocks must be 1..10000');
    const anchor = await this.anchor();
    const cursor = this.meta('cursor');
    if (cursor) { const checkpoint = JSON.parse(cursor); await this.canonical(BigInt(checkpoint.number), checkpoint.hash).catch(error => { if (error.code === 'REORG') this.halt(error.message); throw error; }); }
    const fromBlock = cursor ? BigInt(JSON.parse(cursor).number) + 1n : BigInt(this.config.startBlock);
    if (fromBlock > anchor.number) return { indexed: 0, duplicates: 0, skipped: [], caughtUp: true };
    const toBlock = fromBlock + BigInt(maxBlocks) - 1n < anchor.number ? fromBlock + BigInt(maxBlocks) - 1n : anchor.number;
    const end = await this.client.getBlock({ blockNumber: toBlock });
    const logs = await this.client.getLogs({ address: this.config.hook,
      event: CASHBACK_INDEX_ABI.find(x => x.type === 'event' && x.name === 'FeeAccrued'), fromBlock, toBlock, strict: true });
    const result = { fromBlock, toBlock, indexed: 0, duplicates: 0, skipped: [], caughtUp: toBlock === anchor.number };
    for (const hash of new Set(logs.map(log => bytes32(log.transactionHash, 'log transaction hash')))) {
      try { const item = await this.indexTransaction(hash); result[item.status === 'indexed' ? 'indexed' : 'duplicates']++; }
      catch (error) { if (error.code !== 'INELIGIBLE') throw error; result.skipped.push({ txHash: hash, reason: error.message }); }
    }
    await this.canonical(toBlock, end.hash);
    this.atomic(() => {
      this.assertOpen();
      if (this.meta('cursor') !== cursor) throw new Error('Concurrent scan advanced cursor; retry');
      this.db.query('INSERT OR REPLACE INTO cashback_meta VALUES (?,?)').run('cursor', cashbackJson({ number: toBlock, hash: end.hash }));
    });
    return result;
  }
  rows(trader) {
    return this.db.query('SELECT * FROM cashback_fees WHERE trader=?').all(trader).sort((a, b) => {
      const x = JSON.parse(a.record), y = JSON.parse(b.record);
      return BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : BigInt(x.blockNumber) > BigInt(y.blockNumber) ? 1 :
        x.transactionIndex - y.transactionIndex || x.feeLogIndex - y.feeLogIndex;
    });
  }
  async checkedRows(trader, anchor) {
    const rows = this.rows(trader);
    for (const row of rows) {
      let verified;
      try { verified = await this.verifyReceipt(row.tx_hash, anchor); }
      catch (error) { if (error.code === 'REORG') this.halt(error.message); throw error; }
      if (digest(verified) !== row.record_hash || cashbackJson(verified) !== row.record || verified.trader !== trader) {
        this.halt('Stored receipt evidence differs from canonical receipt');
        throw new Error('Stored receipt evidence differs from canonical receipt');
      }
    }
    return rows;
  }
  typedData(message) {
    return { domain: { name: 'PluggedCashback', version: '1', chainId: this.config.chainId, verifyingContract: this.config.program },
      types: FEE_VOUCHER_TYPES, primaryType: 'FeeVoucher', message };
  }
  async buildAttestation({ trader, validUntil }) {
    trader = address(trader, 'trader');
    requireEligible(trader !== ZERO && trader !== this.config.program, 'Invalid trader');
    const anchor = await this.anchor();
    await this.deployment(anchor.number);
    const expires = uint(validUntil, 'validUntil'), now = uint(this.now(), 'now');
    requireEligible(expires > now && expires > anchor.timestamp && expires <= now + BigInt(this.config.maxValiditySeconds), 'Voucher expiry outside allowed window');
    const rows = await this.checkedRows(trader, anchor);
    const records = rows.map(row => JSON.parse(row.record));
    const cumulativeFees = records.reduce((total, row) => total + BigInt(row.fees), 0n);
    requireEligible(cumulativeFees > 0n && cumulativeFees <= UINT256, 'No eligible fees or cumulative overflow');
    const evidence = digest({ schema: 'plugged.cashback-evidence.v1', configHash: this.configHash, trader, records: rows.map(row => row.record_hash) });
    const typedData = this.typedData({ trader, cumulativeFees, validUntil: expires, evidence });
    const voucherDigest = hashTypedData(typedData);
    const onchain = await this.client.readContract({ address: this.config.program, abi: CASHBACK_INDEX_ABI, functionName: 'voucherDigest',
      args: [trader, cumulativeFees, expires, evidence], blockNumber: anchor.number });
    requireEligible(same(onchain, voucherDigest), 'On-chain EIP-712 digest mismatch');
    await this.canonical(anchor.number, anchor.hash);
    this.assertOpen();
    return { status: 'unsigned', signerUnavailable: true, typedData, digest: voucherDigest, attestor: this.config.attestor,
      configHash: this.configHash, anchor: { number: anchor.number.toString(), hash: anchor.hash }, receipts: records };
  }
  exportAttestation(input) {
    return this.exclusive(async () => {
      const result = await this.buildAttestation(input);
      this.atomic(() => {
        this.assertOpen();
        this.db.query('INSERT OR IGNORE INTO cashback_attestations VALUES (?,?,?,NULL)').run(result.digest, result.typedData.message.trader, cashbackJson(result));
      });
      return result;
    });
  }
  async verifyVoucher(voucher) {
    const t = voucher.typedData;
    requireEligible(t && cashbackJson(t.domain) === cashbackJson(this.typedData({}).domain) &&
      cashbackJson(t.types) === cashbackJson(FEE_VOUCHER_TYPES) && t.primaryType === 'FeeVoucher', 'Voucher domain or types mismatch');
    const message = { trader: address(t.message.trader, 'trader'), cumulativeFees: uint(t.message.cumulativeFees, 'cumulativeFees'),
      validUntil: uint(t.message.validUntil, 'validUntil'), evidence: bytes32(t.message.evidence, 'evidence') };
    const signature = voucher.signature;
    requireEligible(/^0x[0-9a-fA-F]{130}$/.test(signature ?? '') && ['1b', '1c'].includes(signature.slice(-2).toLowerCase()) &&
      BigInt('0x' + signature.slice(66, 130)) <= HALF_ORDER, 'Invalid canonical ECDSA signature');
    requireEligible(same(await recoverTypedDataAddress({ ...this.typedData(message), signature }), this.config.attestor), 'Signature does not match program attestor');
    const anchor = await this.anchor();
    await this.deployment(anchor.number);
    const now = uint(this.now(), 'now');
    requireEligible(message.validUntil > now && message.validUntil > anchor.timestamp &&
      message.validUntil <= now + BigInt(this.config.maxValiditySeconds), 'Voucher expiry outside allowed window');
    requireEligible(Array.isArray(voucher.receipts) && voucher.receipts.length > 0, 'Receipt evidence required');
    const verifiedRows = await this.checkedRows(message.trader, anchor);
    const selected = new Set(voucher.receipts.map(record => record.txHash));
    requireEligible(selected.size === voucher.receipts.length, 'Duplicated voucher receipt');
    const rows = verifiedRows.filter(row => selected.has(row.tx_hash));
    requireEligible(rows.length === voucher.receipts.length && rows.every((row, i) => row.record === cashbackJson(voucher.receipts[i])), 'Voucher receipt evidence does not match canonical ledger');
    const total = rows.reduce((sum, row) => sum + BigInt(JSON.parse(row.record).fees), 0n);
    const evidence = digest({ schema: 'plugged.cashback-evidence.v1', configHash: this.configHash, trader: message.trader, records: rows.map(row => row.record_hash) });
    const voucherDigest = hashTypedData(this.typedData(message));
    requireEligible(total > 0n && total === message.cumulativeFees && same(evidence, message.evidence) &&
      (!voucher.digest || same(voucher.digest, voucherDigest)), 'Voucher does not match verified cumulative receipt evidence');
    const onchain = await this.client.readContract({ address: this.config.program, abi: CASHBACK_INDEX_ABI, functionName: 'voucherDigest',
      args: [message.trader, total, message.validUntil, evidence], blockNumber: anchor.number });
    requireEligible(same(onchain, voucherDigest), 'On-chain EIP-712 digest mismatch');
    await this.canonical(anchor.number, anchor.hash);
    this.assertOpen();
    return { valid: true, digest: voucherDigest, attestor: this.config.attestor };
  }
  attest({ trader, validUntil, signer } = {}) {
    if (!signer) return this.exportAttestation({ trader, validUntil });
    return this.exclusive(async () => {
      if (typeof signer.signTypedData !== 'function') throw new Error('Injected signer must expose signTypedData(typedData)');
      const result = await this.buildAttestation({ trader, validUntil });
      // A signer only sees an isolated copy, never a reference to the verified export.
      const signature = await signer.signTypedData(structuredClone(result.typedData));
      const signed = { ...result, status: 'signed', signerUnavailable: false, signature };
      await this.verifyVoucher(signed);
      this.atomic(() => {
        this.assertOpen();
        this.db.query(`INSERT INTO cashback_attestations VALUES (?,?,?,?) ON CONFLICT(digest)
          DO UPDATE SET payload=excluded.payload,signature=excluded.signature`).run(signed.digest, signed.typedData.message.trader, cashbackJson(signed), signature);
      });
      return signed;
    });
  }
}
