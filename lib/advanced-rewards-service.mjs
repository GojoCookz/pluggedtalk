import { randomUUID } from 'node:crypto';
import { erc20Abi, encodeFunctionData, decodeEventLog, toHex } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_ENGINE } from './advanced-abi.mjs';
import { ADVANCED_HOOK_ABI as H, ADVANCED_SPLITTER_ABI as S, ADVANCED_FEED_ABI as F, DEAD } from './advanced-market-abi.mjs';
import { advancedAddress } from './advanced-market-service.mjs';
import { RewardsStore } from './rewards-store.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const safe = x => JSON.parse(JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const fail = message => { throw Object.assign(new Error(message), { advanced: true }); };
const ACTIONS = ['sweep', 'release', 'recover-splitter', 'recover-feed'];
const POSITION_LIMIT = 25;
function fields(raw, allowed) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Provide a JSON object.');
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) fail(`Unsupported rewards input: ${k}.`);
}
function binding(raw) { if (raw.chainId !== 4663) fail('Select Robinhood chain 4663.'); return advancedAddress(raw.account, 'Wallet'); }
const logs = (receipt, target, abi) => receipt.logs.filter(l => same(l.address, target)).flatMap(l => { try { return [decodeEventLog({ abi, data: l.data, topics: l.topics, strict: true })]; } catch { return []; } });
export const HOLDER_LEDGER_NOTE = 'Holder fees are forwarded to the advanced basket ledger. Ledger holder claims are not integrated in this runtime.';

/**
 * Per-quote rewards for plugged-advanced-v1 tokens: permissionless hook sweeps, fixed-recipient
 * splitter releases and recoverStuckFees on the splitter (creator share) or feed (holder share).
 * Every position and preparation re-verifies the launch and its splitter (code, currency, fixed
 * hook, plan hash = confirmed economics hash, recipients and shares) at one pinned block.
 */
export class AdvancedRewardsService {
  constructor({ marketService, store, now = Date.now } = {}) {
    if (!marketService) fail('Advanced rewards require the advanced market service.');
    this.markets = marketService; this.client = marketService.client; this.now = now;
    this.store = store ?? new RewardsStore(marketService.store.db);
  }
  read(target, abi, functionName, args, blockNumber) { return this.client.readContract({ address: target, abi, functionName, args, blockNumber }); }
  async chain() { if (await this.client.getChainId() !== 4663) fail('Rewards RPC must be Robinhood chain 4663.'); }
  async splitter(v, market, blockNumber) {
    const p = v.record.params, target = market.splitter, hook = v.profile.deployment.feeHook;
    const [code, currency, planHash, splitterHook, count] = await Promise.all([this.client.getCode({ address: target, blockNumber }), this.read(target, S, 'currency', [], blockNumber),
      this.read(target, S, 'planHash', [], blockNumber), this.read(target, S, 'hook', [], blockNumber), this.read(target, S, 'recipientCount', [], blockNumber)]);
    if (!code || code === '0x' || !same(currency, market.pool) || !same(planHash, v.record.settings) || !same(splitterHook, hook) || BigInt(count) !== BigInt(p.recipients.length))
      fail('Splitter deployment verification failed.');
    const rows = await Promise.all(p.recipients.map(async (address, i) => {
      const [who, bps, claimable, released] = await Promise.all([this.read(target, S, 'recipients', [BigInt(i)], blockNumber), this.read(target, S, 'sharesBps', [address], blockNumber),
        this.read(target, S, 'claimable', [address], blockNumber), this.read(target, S, 'released', [address], blockNumber)]);
      if (!same(who, address) || BigInt(bps) !== BigInt(p.sharesBps[i])) fail('Splitter recipient verification failed.');
      return { address: address.toLowerCase(), bps: Number(bps), claimable, released };
    }));
    return { address: target, recipients: rows };
  }
  async pool(v, market, account, blockNumber) {
    const hook = v.profile.deployment.feeHook;
    const [pendingQuote, pendingToken, feedStuck, splitterStuck] = await Promise.all([this.read(hook, H, 'pendingFees', [market.poolId], blockNumber),
      this.read(hook, H, 'pendingTokenFees', [market.poolId], blockNumber), this.read(hook, H, 'stuckFeesOf', [market.pool, market.feed], blockNumber),
      market.splitter ? this.read(hook, H, 'stuckFeesOf', [market.pool, market.splitter], blockNumber) : 0n]);
    const split = market.splitter ? await this.splitter(v, market, blockNumber) : null, mine = split?.recipients.find(r => same(r.address, account)) ?? null;
    return { pool: market.pool, symbol: market.symbol, decimals: market.decimals, poolId: market.poolId, feed: market.feed, creatorBps: market.creatorBps,
      pendingQuote, pendingToken, feedStuck, splitterStuck, splitter: split, account: mine,
      holder: { status: 'unavailable', reason: HOLDER_LEDGER_NOTE },
      actions: { sweep: pendingQuote > 0n || pendingToken > 0n, release: !!mine && mine.claimable > 0n, 'recover-splitter': splitterStuck > 0n, 'recover-feed': feedStuck > 0n } };
  }
  async positions(raw) {
    fields(raw, ['account', 'chainId']); const account = binding(raw); await this.chain();
    const blockNumber = await this.client.getBlockNumber();
    let profile;
    try { profile = await this.markets.context(blockNumber); }
    catch (error) { return safe({ chainId: 4663, account, blockNumber, engine: ADVANCED_ENGINE, available: false, reason: error.message, positions: [], truncated: false }); }
    const records = this.markets.records(POSITION_LIMIT + 1), positions = [];
    for (const record of records.slice(0, POSITION_LIMIT)) {
      try {
        const v = await this.markets.verify(record, profile, blockNumber);
        positions.push({ token: v.token, name: v.record.canonical?.name ?? v.record.input.name, symbol: v.record.canonical?.symbol ?? v.record.input.symbol, status: 'verified',
          pools: await Promise.all(v.markets.map(m => this.pool(v, m, account, blockNumber))) });
      } catch (error) { positions.push({ token: record.token, symbol: record.canonical?.symbol ?? record.input?.symbol, status: 'unavailable', error: error.shortMessage ?? error.message }); }
    }
    return safe({ chainId: 4663, account, blockNumber, engine: ADVANCED_ENGINE, available: true, reason: null, positions, truncated: records.length > POSITION_LIMIT });
  }
  async prepare(raw) {
    fields(raw, ['account', 'chainId', 'action', 'token', 'pool', 'recipient']); const account = binding(raw);
    if (!ACTIONS.includes(raw.action)) fail('Unknown reward action.');
    if (raw.action !== 'release' && raw.recipient !== undefined) fail('Only splitter releases name a recipient.');
    await this.chain(); const preparedBlock = await this.client.getBlockNumber();
    const v = await this.markets.market(raw.token, raw.pool, preparedBlock), m = v.market, hook = v.profile.deployment.feeHook;
    const p = await this.pool(v, m, account, preparedBlock);
    if (!p.actions[raw.action] && raw.action !== 'release') fail('Nothing available for this action. Refresh after fees accrue.');
    let target, abi, functionName, args, expected;
    if (raw.action === 'sweep') { target = hook; abi = H; functionName = 'sweep'; args = [m.key]; expected = { poolId: m.poolId, amount: p.pendingQuote, creator: m.creatorBps ? m.splitter : DEAD, feed: m.feed }; }
    else if (raw.action === 'release') {
      if (!p.splitter) fail('This pool has no creator splitter (creator share is 0).');
      const recipient = advancedAddress(raw.recipient ?? account, 'Recipient'), r = p.splitter.recipients.find(x => same(x.address, recipient));
      if (!r) fail('Recipient is not a fixed beneficiary. Redirects are not supported.');
      if (r.claimable <= 0n) fail('Nothing to claim for this recipient.');
      target = m.splitter; abi = S; functionName = 'release'; args = [recipient]; expected = { recipient, amount: r.claimable };
    } else {
      target = raw.action === 'recover-splitter' ? m.splitter : m.feed; abi = raw.action === 'recover-splitter' ? S : F; functionName = 'recoverStuckFees'; args = [];
      expected = { amount: raw.action === 'recover-splitter' ? p.splitterStuck : p.feedStuck };
    }
    const call = { account, address: target, abi, functionName, args };
    const { result } = await this.client.simulateContract({ ...call, blockNumber: preparedBlock });
    if (raw.action !== 'sweep' && (typeof result !== 'bigint' || result <= 0n)) fail('Simulation returned no payout.');
    const gas = await this.client.estimateContractGas(call), createdAt = this.now();
    const record = safe({ id: randomUUID(), engine: ADVANCED_ENGINE, account, chainId: 4663, action: raw.action, status: 'prepared', createdAt, expiresAt: createdAt + 120000, preparedBlock,
      token: v.token, pool: m.pool, transaction: { from: account, to: target.toLowerCase(), chainId: '0x1237', value: '0x0', data: encodeFunctionData({ abi, functionName, args }), gas: toHex(gas * 120n / 100n) },
      expected: { ...expected, currency: m.pool, symbol: m.symbol, decimals: m.decimals, hook }, simulation: { result, gas },
      notes: ['Simulation is not a payout guarantee.', 'Sweeps and releases pay only the fixed configured recipients; recovery funds the fixed splitter or holder ledger.', HOLDER_LEDGER_NOTE] });
    this.store.save(record); return record;
  }
  async submit(raw) {
    fields(raw, ['preparation', 'txHash', 'account', 'chainId']); const account = binding(raw); await this.chain();
    const id = raw.preparation?.id; if (typeof id !== 'string' || id.length > 100) fail('Provide a preparation ID.');
    const r = this.store.get(id); if (!r || r.engine !== ADVANCED_ENGINE || !same(r.account, account)) fail('Preparation not found for this wallet.');
    if (!/^0x[0-9a-f]{64}$/i.test(raw.txHash ?? '')) fail('Provide a transaction hash.');
    if (r.txHash && !same(r.txHash, raw.txHash)) fail('A different transaction is already attached.');
    const tx = await this.client.getTransaction({ hash: raw.txHash }), t = r.transaction;
    if (!same(tx.from, account) || !same(tx.to, t.to) || !same(tx.input, t.data) || tx.value !== 0n || tx.chainId !== 4663) fail('Transaction differs from the prepared wallet, chain, target or calldata.');
    if (tx.blockNumber !== null && tx.blockNumber < BigInt(r.preparedBlock)) fail('Transaction predates preparation.');
    const response = (status, extra = {}) => ({ status, txHash: raw.txHash, chainId: 4663, account, engine: ADVANCED_ENGINE, verified: status === 'confirmed', ...extra });
    Object.assign(r, this.store.attach(r.id, raw.txHash));
    let receipt; try { receipt = await this.client.getTransactionReceipt({ hash: raw.txHash }); } catch (e) { if (e.name === 'TransactionReceiptNotFoundError') return response('pending'); throw e; }
    if (!same(receipt.transactionHash, raw.txHash) || !same(receipt.from, account) || !same(receipt.to, t.to) || !same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber)
      fail('Receipt does not match the submitted transaction.');
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber }), latest = await this.client.getBlockNumber();
    if (!same(block.hash, receipt.blockHash)) return response('reorg');
    if (latest < receipt.blockNumber + 2n) return response('confirming', { confirmations: Number(latest - receipt.blockNumber + 1n), requiredConfirmations: 3 });
    if (receipt.status !== 'success') { r.status = 'reverted'; this.store.save(r); return response('reverted'); }
    const e = r.expected, at = safe({ blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
    const transfers = from => logs(receipt, e.currency, erc20Abi).filter(x => x.eventName === 'Transfer' && same(x.args.from, from));
    const finish = (status, extra) => { r.status = status; r.receipt = { ...at, ...extra }; this.store.save(r); return response(status, { receipt: r.receipt }); };
    if (r.action === 'sweep') {
      const taken = logs(receipt, t.to, H).filter(x => x.eventName === 'FeeTaken' && same(x.args.poolId, e.poolId));
      if (!taken.length) return finish('no-op', { reason: 'No matching fee distribution; another sweep may have emptied the pool.' });
      if (taken.length !== 1 || taken[0].args.total <= 0n) fail('Expected exactly one fee distribution for this pool.');
      const paid = taken[0].args, out = transfers(e.hook);
      for (const [recipient, allocation] of [[e.creator, paid.toCreator], [e.feed, paid.toHolders]]) {
        if (!allocation) continue;
        const delivered = recipient ? out.filter(x => same(x.args.to, recipient)).reduce((n, x) => n + x.args.value, 0n) : 0n;
        // FeeHook defers a failed payout into stuckFees; recoverStuckFees on the splitter or feed collects it.
        if (delivered < allocation) return finish('payment-deferred', { event: 'FeeTaken', args: safe(paid), reason: 'A configured payout was not delivered and was deferred by the hook. Use recover stuck fees on this pool.' });
      }
      return finish('confirmed', { event: 'FeeTaken', args: safe(paid) });
    }
    const name = r.action === 'release' ? 'Released' : 'StuckFeesRecovered', abi = r.action === 'recover-feed' ? F : S;
    const events = logs(receipt, t.to, abi).filter(x => x.eventName === name && (r.action !== 'release' || same(x.args.recipient, e.recipient) && same(x.args.currency, e.currency)));
    if (events.length !== 1 || events[0].args.amount <= 0n) fail('Expected exactly one matching payout event. Inspect the receipt.');
    const amount = events[0].args.amount, source = r.action === 'release' ? t.to : e.hook, sink = r.action === 'release' ? e.recipient : t.to;
    if (transfers(source).filter(x => same(x.args.to, sink)).reduce((n, x) => n + x.args.value, 0n) !== amount) fail('Payout transfer does not match the event amount.');
    return finish('confirmed', { event: name, args: safe(events[0].args) });
  }
}
