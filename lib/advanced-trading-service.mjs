import { erc20Abi, keccak256 } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_ENGINE } from './advanced-abi.mjs';
import { NETWORK } from './config.mjs';
import { TradingService } from './trading-service.mjs';
import { TRADING_ABI, TRADING_ROUTER_HASH } from './trading-abi.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = (message, code = 'TRADING_DEPLOYMENT') => { throw Object.assign(new Error(message), { code }); };

/**
 * Per-pool trading for plugged-advanced-v1 tokens. Same review/prepare/submit/replacement flow as
 * the baseline service; only the snapshot differs: the user names the quote pool, and the pool key
 * (sorted currencies, fee 0, tick spacing 60, the profile's FeeHook) must hash to the confirmed
 * pool id. Swaps go through the profile's TradeRouter, which must carry the same pinned runtime
 * bytecode as the baseline Carbon router (hook-agnostic swap-first exact-input router).
 */
export class AdvancedTradingService extends TradingService {
  // routerHash is a server-side injection point for tests only; production uses the pinned hash.
  constructor({ launchService, marketService, now = Date.now, routerHash = TRADING_ROUTER_HASH } = {}) {
    super({ launchService, now });
    if (!marketService) fail('Advanced trading requires the advanced market service.');
    this.routerHash = routerHash; this.markets = marketService; this.client = marketService.client; this.engine = ADVANCED_ENGINE;
  }
  get quoteFields() { return [...super.quoteFields, 'pool']; }
  get balanceFields() { return [...super.balanceFields, 'pool']; }
  async snapshot(token, account, context = {}) {
    const blockNumber = await this.client.getBlockNumber();
    if (context.pool === undefined) fail('Choose one of this token’s quote pools.', 'TRADING_INVALID');
    let v;
    try { v = await this.markets.market(token, context.pool, blockNumber); }
    catch (error) {
      if (!error.code) error.code = /Quote pool|quote pools|nonzero EVM/.test(error.message) ? 'TRADING_INVALID' : /profile|deployment|artifact/i.test(error.message) ? 'TRADING_DEPLOYMENT' : 'TRADING_UNVERIFIED';
      throw error;
    }
    const d = v.profile.deployment, market = v.market;
    const router = d.tradeRouter?.toLowerCase();
    if (!router || v.profile.hashes?.tradeRouter?.codeHash !== this.routerHash) fail('Advanced trade router is not the pinned Carbon router. Trading is unavailable.');
    const code = await this.client.getCode({ address: router, blockNumber });
    if (!code || keccak256(code) !== this.routerHash) fail('Trading router bytecode changed. Re-verification required.');
    const read = (target, abi, functionName, args = []) => this.client.readContract({ address: target, abi, functionName, args, blockNumber });
    const [manager, tokenDecimals, quoteDecimals, tokenBalance, quoteBalance, tokenAllowance, quoteAllowance, nativeBalance, block] = await Promise.all([
      read(router, TRADING_ABI, 'poolManager'), read(token, erc20Abi, 'decimals'), read(market.pool, erc20Abi, 'decimals'),
      read(token, erc20Abi, 'balanceOf', [account]), read(market.pool, erc20Abi, 'balanceOf', [account]),
      read(token, erc20Abi, 'allowance', [account, router]), read(market.pool, erc20Abi, 'allowance', [account, router]),
      this.client.getBalance({ address: account, blockNumber }), this.client.getBlock({ blockNumber }),
    ]);
    if (!same(manager, d.poolManager) || Number(tokenDecimals) !== 18 || Number(quoteDecimals) !== market.decimals) fail('Pool deployment or token precision changed. Re-verification required.');
    if (!block.hash || Math.abs(this.now() / 1000 - Number(block.timestamp)) > 120) fail('RPC head is stale. Retry with a healthy Robinhood RPC.', 'TRADING_STALE_RPC');
    return { launch: v.record, key: market.key, poolId: market.poolId, router, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
      extra: { engine: ADVANCED_ENGINE, pool: market.pool, chainId: NETWORK.id },
      token: { address: v.token, symbol: v.record.canonical?.symbol ?? v.record.input.symbol, decimals: 18, balance: tokenBalance, allowance: tokenAllowance },
      quote: { address: market.pool, symbol: market.symbol, decimals: market.decimals, balance: quoteBalance, allowance: quoteAllowance }, nativeBalance };
  }
}
