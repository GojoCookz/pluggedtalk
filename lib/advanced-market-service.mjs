import { isAddress, zeroAddress, erc20Abi } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_ENGINE, ADVANCED_FACTORY_ABI } from './advanced-abi.mjs';
import { ADVANCED_HOOK_ABI as H, ADVANCED_FEED_ABI as F, DEAD, advancedPoolKey, loadAdvancedMarketArtifacts } from './advanced-market-abi.mjs';
import { QUOTES } from './config.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const safe = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const fail = message => { throw Object.assign(new Error(message), { advanced: true }); };
export const advancedAddress = (value, label = 'Token') => {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || same(value, zeroAddress)) fail(`${label}: enter a nonzero EVM address.`);
  return value.toLowerCase();
};
const reason = error => error?.advanced ? error.message : error?.shortMessage ?? error?.message ?? 'Verification failed.';
export const LIST_LIMIT = 50;

/**
 * Read-only market facts for confirmed plugged-advanced-v1 launches. Every listing and every
 * trade/reward snapshot re-runs AdvancedLaunchService.confirm (exact tx, events, canonical receipt,
 * factory/registry/token reads) against a freshly verified profile, then checks every pool key,
 * hook configuration and feed binding at a pinned block. Anything unverifiable is not tradable.
 */
export class AdvancedMarketService {
  constructor({ advancedService, now = Date.now, cacheMs = 30000, artifacts = null } = {}) {
    if (!advancedService?.store || !advancedService?.client) fail('Advanced markets require the advanced launch service.');
    Object.assign(this, { advancedService, store: advancedService.store, client: advancedService.client, now, cacheMs, cache: null });
    this.artifactPromise = artifacts ? Promise.resolve(artifacts) : null;
  }
  artifacts() { return this.artifactPromise ??= loadAdvancedMarketArtifacts().catch(error => { this.artifactPromise = null; throw error; }); }
  read(address, abi, functionName, args, blockNumber) { return this.client.readContract({ address, abi, functionName, args, blockNumber }); }
  records(limit = LIST_LIMIT + 1) { return this.store.list('confirmed', limit, ADVANCED_ENGINE); }
  /** Verified profile plus compiled-ABI check. Throws (fail closed) when either is unavailable. */
  async context(blockNumber) {
    const [profile] = await Promise.all([this.advancedService.deployment(blockNumber), this.artifacts()]);
    const d = profile.deployment;
    if (!d?.feeHook || !d?.factory || !d?.poolManager) fail('Advanced profile lacks hook, factory or pool manager roles.');
    return profile;
  }
  /** Re-verifies one confirmed record and all of its pools at blockNumber. */
  async verify(record, profile, blockNumber) {
    const d = profile.deployment;
    if (!same(record.deployment?.factory, d.factory) || !same(record.deployment?.launchRegistry, d.launchRegistry))
      fail('Launch was confirmed against a different advanced deployment.');
    const checked = await this.advancedService.confirm(structuredClone(record));
    if (checked.status !== 'confirmed' || !same(checked.token, record.token) || !same(checked.blockHash, record.blockHash))
      fail('Launch confirmation changed. Refresh after reconciliation.');
    const token = checked.token.toLowerCase(), p = checked.params, read = (a, abi, f, args = []) => this.read(a, abi, f, args, blockNumber);
    const [ours, pools, pairs] = await Promise.all([read(d.factory, ADVANCED_FACTORY_ABI, 'isOurs', [token]),
      read(d.factory, ADVANCED_FACTORY_ABI, 'poolsOf', [token]), read(d.factory, ADVANCED_FACTORY_ABI, 'pairsOf', [token])]);
    if (!ours || pools.length !== p.markets.length || pairs.length !== p.markets.length) fail('Factory no longer reports these pools.');
    const markets = await Promise.all(p.markets.map(async (m, i) => {
      const pair = m.pair.toLowerCase(), quote = QUOTES.find(q => same(q.address, pair) && !q.native);
      const { key, poolId } = advancedPoolKey(token, pair, m.tickSpacing, d.feeHook);
      if (!quote || m.tickSpacing !== 60 || !same(poolId, checked.poolIds[i]) || !same(pools[i], poolId) || !same(pairs[i], pair)) fail('Pool identity does not match the verified launch.');
      const [config, splitter] = await Promise.all([read(d.feeHook, H, 'poolConfig', [poolId]), read(d.factory, ADVANCED_FACTORY_ABI, 'splitterOf', [token, pair])]);
      const creator = m.creatorBps ? splitter : DEAD;
      if (!config[5] || !same(config[1], pair) || Number(config[2]) !== m.feeBps || Number(config[4]) !== m.creatorBps || !same(config[3], creator) || (m.creatorBps && same(splitter, zeroAddress)))
        fail('Hook pool configuration differs from the confirmed launch.');
      const feed = config[0].toLowerCase();
      const [feedHook, feedCurrency, feedLedger, cap, progress, graduated, decimals] = await Promise.all([read(feed, F, 'hook'), read(feed, F, 'currency'), read(feed, F, 'ledger'),
        read(d.feeHook, H, 'marketCapOf', [poolId]), read(d.feeHook, H, 'graduationProgressBps', [poolId]), read(d.feeHook, H, 'hasGraduated', [poolId]), read(pair, erc20Abi, 'decimals')]);
      if (!same(feedHook, d.feeHook) || !same(feedCurrency, pair) || !same(feedLedger, checked.ledger)) fail('Holder feed binding is invalid.');
      if (Number(decimals) !== quote.decimals) fail('Quote decimals changed. Re-verification required.');
      return { pool: pair, symbol: quote.symbol, decimals: quote.decimals, poolId: poolId.toLowerCase(), key, feed, splitter: m.creatorBps ? splitter.toLowerCase() : null,
        feeBps: m.feeBps, creatorBps: m.creatorBps, marketCapQuote: cap, graduationProgressBps: progress, graduated, graduationThreshold: m.graduationThreshold };
    }));
    return { record: checked, token, markets, profile };
  }
  summary(v) {
    const r = v.record;
    return { address: v.token, name: r.canonical?.name ?? r.input.name, symbol: r.canonical?.symbol ?? r.input.symbol, engine: ADVANCED_ENGINE, launchedAt: r.launchedAt ?? null,
      creator: r.input.account, ledger: r.ledger, maxWalletBps: 300, priceableMarkets: r.priceableMarkets ?? null, confirmedBlock: r.blockNumber,
      recipients: r.params.recipients.length, markets: v.markets.map(({ key, ...m }) => m) };
  }
  /** Discover listing. No verified profile means nothing is listed. */
  async list() {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.value;
    const base = { chainId: 4663, engine: ADVANCED_ENGINE, tokens: [], unavailable: [], truncated: false };
    let value;
    try {
      const blockNumber = await this.client.getBlockNumber(), profile = await this.context(blockNumber), records = this.records();
      value = { ...base, available: true, reason: null, blockNumber, observedAt: new Date(this.now()).toISOString(), truncated: records.length > LIST_LIMIT };
      for (const record of records.slice(0, LIST_LIMIT)) {
        try { value.tokens.push(this.summary(await this.verify(record, profile, blockNumber))); }
        catch (error) { value.unavailable.push({ address: record.token, symbol: record.canonical?.symbol ?? record.input?.symbol, reason: reason(error) }); }
      }
    } catch (error) { value = { ...base, available: false, reason: reason(error) }; }
    value = safe(value);
    this.cache = { at: this.now(), value };
    return value;
  }
  /** Fresh (uncached) verification of one token and, optionally, one of its quote pools. */
  async market(tokenInput, poolInput, blockNumber) {
    const token = advancedAddress(tokenInput), record = this.records(10000).find(r => same(r.token, token));
    if (!record) fail('This token is not a confirmed Plugged advanced launch.');
    const profile = await this.context(blockNumber), v = await this.verify(record, profile, blockNumber);
    if (poolInput === undefined) return v;
    const pool = advancedAddress(poolInput, 'Quote pool'), market = v.markets.find(m => same(m.pool, pool));
    if (!market) fail('Choose one of this token’s verified quote pools.');
    return { ...v, market };
  }
  async detail(token) {
    const blockNumber = await this.client.getBlockNumber();
    return safe({ chainId: 4663, blockNumber, ...this.summary(await this.market(token, undefined, blockNumber)) });
  }
}
