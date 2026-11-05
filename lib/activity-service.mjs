import { decodeEventLog, isAddress, parseAbiItem } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_DEFAULT as engine } from './carbon-abi.mjs';
import { QUOTES } from './config.mjs';
import { HttpError } from './http-api.mjs';

// Read-only activity for verified Plugged launches, built from Robinhood Chain logs.
// Nothing here creates a listing: every token must already be a confirmed Plugged launch.
export const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)');
export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const SUPPLY = 10n ** 27n; // 1,000,000,000 tokens with 18 decimals, fixed by the launch params.
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const abs = v => (v < 0n ? -v : v);

export function tokenAddress(value) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || same(value, ZERO)) throw new HttpError(422, 'Provide a token address.');
  return value.toLowerCase();
}

/** Quote units per token from a v4 sqrtPriceX96, given which side the token is on. */
export function priceFromSqrt(sqrtPriceX96, tokenIsCurrency0, quoteDecimals) {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // raw currency1 per raw currency0
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return tokenIsCurrency0 ? ratio * 10 ** (18 - quoteDecimals) : 1 / (ratio * 10 ** (quoteDecimals - 18));
}

/** v4 Swap amounts are the swapper's balance deltas: positive token delta means the swapper received tokens. */
export function swapView(log, meta) {
  const { amount0, amount1, sqrtPriceX96 } = log.args;
  const tokenDelta = meta.tokenIsCurrency0 ? amount0 : amount1, quoteDelta = meta.tokenIsCurrency0 ? amount1 : amount0;
  return { side: tokenDelta > 0n ? 'buy' : 'sell', tokenAmount: abs(tokenDelta).toString(), quoteAmount: abs(quoteDelta).toString(),
    price: priceFromSqrt(sqrtPriceX96, meta.tokenIsCurrency0, meta.quoteDecimals), blockNumber: log.blockNumber.toString(),
    txHash: log.transactionHash, logIndex: log.logIndex };
}

export class ActivityService {
  constructor({ launchService, client, now = Date.now, chunk = 1_000_000n, maxChunks = 40, feedWindow = 1_000_000n, confirmations = 2n, maxIndexes = 200 } = {}) {
    Object.assign(this, { launchService, now, chunk, maxChunks, feedWindow, confirmations, maxIndexes });
    this.clientOverride = client;
    this.indexes = new Map(); this.txFrom = new Map(); this.blockTime = new Map(); this.feedCache = null; this.headCache = null;
  }
  get client() { return this.clientOverride ?? this.launchService.client; }
  get store() { return this.launchService.store; }

  /** Highest block with the platform's two-block soft finality; shared by concurrent callers for one second. */
  head() {
    if (this.headCache && this.now() - this.headCache.at < 1000) return this.headCache.value;
    const value = this.client.getBlockNumber().then(n => n - this.confirmations);
    this.headCache = { at: this.now(), value };
    value.catch(() => { if (this.headCache?.value === value) this.headCache = null; });
    return value;
  }

  meta(address) {
    const token = tokenAddress(address), record = this.store.confirmedByToken(token);
    if (!record?.poolId || !record.blockNumber) throw new HttpError(404, 'Not a confirmed Plugged launch.');
    const quote = QUOTES.find(q => same(q.address, record.input.quote));
    if (!quote) throw new HttpError(503, 'Launch quote is no longer configured.');
    return { token, name: record.input.name, symbol: record.input.symbol, creator: record.input.account.toLowerCase(), poolId: record.poolId.toLowerCase(),
      quote: quote.address, quoteSymbol: quote.symbol, quoteDecimals: quote.decimals, tokenIsCurrency0: token < quote.address.toLowerCase(),
      launchBlock: BigInt(record.blockNumber), launchedAt: record.launchedAt ?? null };
  }

  /**
   * Incremental, bounded log index. Each refresh scans at most maxChunks ranges up to the
   * finalised head; one refresh per key runs at a time. `complete` is false while catching up.
   */
  async index(key, fromBlock, fetchLogs, apply, initial) {
    let entry = this.indexes.get(key);
    if (!entry) {
      if (this.indexes.size >= this.maxIndexes) this.indexes.delete(this.indexes.keys().next().value);
      entry = { next: fromBlock, state: initial(), pending: null, head: null };
      this.indexes.set(key, entry);
    }
    const head = await this.head();
    if (entry.next > head) { entry.head = head; return entry; }
    entry.pending ??= (async () => {
      try {
        for (let i = 0; i < this.maxChunks && entry.next <= head; i++) {
          const to = entry.next + this.chunk - 1n < head ? entry.next + this.chunk - 1n : head;
          apply(entry.state, await fetchLogs(entry.next, to));
          entry.next = to + 1n;
        }
        entry.head = head;
      } finally { entry.pending = null; }
    })();
    await entry.pending;
    return entry;
  }

  swapLogs(meta) {
    return (fromBlock, toBlock) => this.client.getLogs({ address: engine.poolManager, event: SWAP_EVENT, args: { id: meta.poolId }, fromBlock, toBlock, strict: true })
      .then(logs => logs.filter(l => same(l.args.id, meta.poolId)));
  }

  async enrich(rows) {
    const txs = [...new Set(rows.filter(r => !this.txFrom.has(r.txHash)).map(r => r.txHash))];
    const blocks = [...new Set(rows.filter(r => !this.blockTime.has(r.blockNumber)).map(r => r.blockNumber))];
    await Promise.all([
      ...txs.map(async hash => { try { const tx = await this.client.getTransaction({ hash }); this.remember(this.txFrom, hash, tx.from.toLowerCase()); } catch {} }),
      ...blocks.map(async n => { try { const b = await this.client.getBlock({ blockNumber: BigInt(n) }); this.remember(this.blockTime, n, Number(b.timestamp)); } catch {} }),
    ]);
    return rows.map(r => ({ ...r, trader: this.txFrom.get(r.txHash) ?? null, timestamp: this.blockTime.get(r.blockNumber) ?? null }));
  }
  remember(map, key, value) { if (map.size >= 20000) map.delete(map.keys().next().value); map.set(key, value); }

  publicMeta(meta) {
    const { launchBlock, ...rest } = meta;
    return { ...rest, launchBlock: launchBlock.toString() };
  }

  /** Trade tape and price series for one verified launch. */
  async trades(address, limit = 50) {
    const meta = this.meta(address);
    const entry = await this.index(`swaps:${meta.poolId}`, meta.launchBlock, this.swapLogs(meta), (state, logs) => {
      for (const log of logs) state.rows.push(swapView(log, meta));
      state.count += logs.length;
      if (state.rows.length > 2000) state.rows.splice(0, state.rows.length - 2000);
    }, () => ({ rows: [], count: 0 }));
    const rows = entry.state.rows, recent = rows.slice(-Math.min(Math.max(1, limit), 50)).reverse();
    return { token: this.publicMeta(meta), trades: await this.enrich(recent), totalSwaps: entry.state.count,
      series: rows.slice(-300).filter(r => r.price !== null).map(r => ({ blockNumber: r.blockNumber, price: r.price, side: r.side })),
      indexedTo: (entry.next - 1n).toString(), head: entry.head?.toString() ?? null, complete: entry.next > entry.head, source: 'robinhood-rpc', chainId: 4663 };
  }

  /** Holder balances replayed from every Transfer since the launch block. */
  async holders(address) {
    const meta = this.meta(address);
    const entry = await this.index(`holders:${meta.token}`, meta.launchBlock,
      (fromBlock, toBlock) => this.client.getLogs({ address: meta.token, event: TRANSFER_EVENT, fromBlock, toBlock, strict: true }),
      (state, logs) => {
        for (const { args: { from, to, value } } of logs) {
          const f = from.toLowerCase(), t = to.toLowerCase();
          if (f !== ZERO) state.balances.set(f, (state.balances.get(f) ?? 0n) - value);
          if (t !== ZERO) state.balances.set(t, (state.balances.get(t) ?? 0n) + value);
        }
      }, () => ({ balances: new Map() }));
    const holders = [...entry.state.balances].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    const label = a => same(a, engine.poolManager) ? 'pool' : same(a, meta.creator) ? 'creator' : null;
    const top = holders.slice(0, 20).map(([holder, balance]) => ({ address: holder, balance: balance.toString(), bps: Number(balance * 10000n / SUPPLY), label: label(holder) }));
    const wallets = holders.filter(([a]) => !same(a, engine.poolManager));
    const top10 = wallets.slice(0, 10).reduce((sum, [, v]) => sum + v, 0n);
    return { token: this.publicMeta(meta), holderCount: holders.length, top, top10WalletBps: Number(top10 * 10000n / SUPPLY), supply: SUPPLY.toString(),
      indexedTo: (entry.next - 1n).toString(), head: entry.head?.toString() ?? null, complete: entry.next > entry.head, source: 'robinhood-rpc', chainId: 4663 };
  }

  /** New verified launches plus recent swaps across them, cached per finalised block. */
  async feed() {
    const launches = this.store.list('confirmed', 50).filter(r => r.token && r.poolId);
    const base = launches.map(r => ({ token: r.token, name: r.input.name, symbol: r.input.symbol, creator: r.input.account.toLowerCase(), launchedAt: r.launchedAt ?? null,
      quoteSymbol: QUOTES.find(q => same(q.address, r.input.quote))?.symbol ?? null, blockNumber: r.blockNumber }));
    if (!launches.length) return { launches: [], trades: [], mostActive: [], windowBlocks: this.feedWindow.toString(), head: null, source: 'plugged', chainId: 4663 };
    const head = await this.head();
    if (this.feedCache?.head === head && this.feedCache.count === launches.length) return this.feedCache.value;
    const metas = new Map(launches.map(r => { try { return [r.poolId.toLowerCase(), this.meta(r.token)]; } catch { return null; } }).filter(Boolean));
    const from = head > this.feedWindow ? head - this.feedWindow + 1n : 0n;
    const logs = (await this.client.getLogs({ address: engine.poolManager, event: SWAP_EVENT, args: { id: [...metas.keys()] }, fromBlock: from, toBlock: head, strict: true }))
      .filter(l => metas.has(l.args.id.toLowerCase()));
    const counts = new Map();
    for (const l of logs) counts.set(l.args.id.toLowerCase(), (counts.get(l.args.id.toLowerCase()) ?? 0) + 1);
    const recent = logs.slice(-25).reverse().map(l => { const m = metas.get(l.args.id.toLowerCase()); return { ...swapView(l, m), token: m.token, symbol: m.symbol, quoteSymbol: m.quoteSymbol, quoteDecimals: m.quoteDecimals }; });
    const mostActive = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pool, swaps]) => { const m = metas.get(pool); return { token: m.token, name: m.name, symbol: m.symbol, swaps }; });
    let windowSeconds = null;
    try { const [a, b] = await Promise.all([this.client.getBlock({ blockNumber: from }), this.client.getBlock({ blockNumber: head })]); windowSeconds = Number(b.timestamp - a.timestamp); } catch {}
    const value = { launches: base, trades: await this.enrich(recent), mostActive, windowBlocks: (head - from + 1n).toString(), windowSeconds, head: head.toString(), source: 'robinhood-rpc', chainId: 4663 };
    this.feedCache = { head, count: launches.length, value };
    return value;
  }

  creator(address) {
    const account = tokenAddress(address);
    const launches = this.store.byCreator(account).map(r => ({ token: r.token, name: r.input.name, symbol: r.input.symbol, launchedAt: r.launchedAt ?? null,
      quoteSymbol: QUOTES.find(q => same(q.address, r.input.quote))?.symbol ?? null, feeBps: r.input.feeBps, txHash: r.txHash }));
    return { account, launches, source: 'plugged', chainId: 4663 };
  }
}
