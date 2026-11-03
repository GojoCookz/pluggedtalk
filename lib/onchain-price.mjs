import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from './config.mjs';

// Independent on-chain reference for the LI.FI price (audit M2). Uniswap v4 StateView on 4663,
// listed at https://docs.uniswap.org/contracts/v4/deployments and code-hash checked by tools/rh-chain-probe.mjs.
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
// Deepest hookless native ETH/USDG pool measured on 2026-11-03 (0.05%, tick spacing 10).
export const REFERENCE_POOL = Object.freeze({ currency0: NATIVE, currency1: USDG, fee: 500, tickSpacing: 10, hooks: NATIVE });
export const REFERENCE_POOL_ID = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [REFERENCE_POOL.currency0, REFERENCE_POOL.currency1, REFERENCE_POOL.fee, REFERENCE_POOL.tickSpacing, REFERENCE_POOL.hooks]));
export const MIN_REFERENCE_LIQUIDITY = 10n ** 15n;
export const FUNDING_DEVIATION_BPS = 500;
export const VALUATION_DEVIATION_BPS = 1000;
const ABI = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)']);
const ONE = 10n ** 18n;
let shared;
const defaultClient = () => shared ??= createPublicClient({ transport: http(process.env.PLUGGED_RPC_URL || NETWORK.rpc, { timeout: 10000, retryCount: 1 }) });

// Raw USDG units per 1 ETH from the reference pool's current price. A spot price can be moved inside one
// transaction, so it is only a sanity band for an off-chain quote: a moved pool makes Plugged refuse, never pay more.
export async function poolEthInUsdg(client = defaultClient()) {
  const [[sqrtPriceX96], liquidity] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: ABI, functionName: 'getSlot0', args: [REFERENCE_POOL_ID] }),
    client.readContract({ address: STATE_VIEW, abi: ABI, functionName: 'getLiquidity', args: [REFERENCE_POOL_ID] })]);
  if (!sqrtPriceX96 || liquidity < MIN_REFERENCE_LIQUIDITY) throw new Error('Independent on-chain price is unavailable; retry later.');
  return (sqrtPriceX96 * sqrtPriceX96 * ONE) >> 192n;
}

// Quote-asset raw units per 1 ETH, or null when no independent on-chain reference exists for the asset.
export async function ethReference(quoteAddress, client) {
  const address = String(quoteAddress).toLowerCase();
  if (address === WETH || address === NATIVE) return ONE;
  if (address === USDG) return poolEthInUsdg(client);
  return null;
}

export function assertNear(actual, reference, bps, message) {
  actual = BigInt(actual); reference = BigInt(reference);
  if (reference <= 0n) throw new Error(message);
  const diff = actual > reference ? actual - reference : reference - actual;
  if (diff * 10000n > reference * BigInt(bps)) throw new Error(message);
}

export async function checkFundingOutput({ quote, amount, outputAmount }, client) {
  const perEth = await ethReference(quote, client);
  if (perEth === null) return { checked: false };
  const expected = perEth * BigInt(amount) / ONE;
  assertNear(outputAmount, expected, FUNDING_DEVIATION_BPS, 'Funding route output differs from the on-chain reference price by more than 5%.');
  return { checked: true, expected: expected.toString(), deviationLimitBps: FUNDING_DEVIATION_BPS };
}

// Checks LI.FI's ETH (or WETH) USD price against the pool price in USDG times LI.FI's own USDG price.
// This catches a bad ETH price from one provider response; it cannot detect both prices being wrong together.
export async function checkEthUsd({ ethPriceUsd, usdgPriceUsd }, client) {
  const perEth = await poolEthInUsdg(client); // USDG has 6 decimals, so this is USDG micro-units per ETH
  const micros = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid provider price.'); return BigInt(Math.round(n * 1e6)); };
  const reference = perEth * micros(usdgPriceUsd) / 10n ** 6n;
  assertNear(micros(ethPriceUsd), reference, VALUATION_DEVIATION_BPS,
    'ETH price differs from the on-chain reference by more than 10%; retry pricing.');
  return { checked: true, referenceUsdMicros: reference.toString() };
}
