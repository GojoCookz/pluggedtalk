import { readFile } from 'node:fs/promises';
import { parseAbi, encodeAbiParameters, parseAbiParameters, keccak256 } from '../../app/node_modules/viem/_esm/index.js';
import { assertAbiMatchesArtifact } from './advanced-abi.mjs';
import { POOL_KEY, TRADING_ABI } from './trading-abi.mjs';

// Hand-written subsets of the Carbon FeeHook and the Plugged advanced adapters. Every item must
// match the compiled Foundry artifacts (contracts/out); a missing artifact or drift fails closed.
export const ADVANCED_HOOK_ABI = parseAbi([
  `function sweep(${POOL_KEY} key) returns (uint256)`,
  'function poolConfig(bytes32) view returns (address distributor,address pairCurrency,uint16 feeBps,address creator,uint16 creatorBps,bool configured,uint16 sellFeeBps,uint16 burnBps,uint16 platformShareBps,uint16 sellPlatformShareBps,uint32 openingFeeEndsAt,uint32 openingWindow,uint16 openingFeeBps,address rewardCurrency)',
  'function pendingFees(bytes32) view returns (uint256)',
  'function pendingTokenFees(bytes32) view returns (uint256)',
  'function marketCapOf(bytes32) view returns (uint256)',
  'function graduationProgressBps(bytes32) view returns (uint256)',
  'function hasGraduated(bytes32) view returns (bool)',
  'function stuckFeesOf(address currency,address who) view returns (uint256)',
  'function poolManager() view returns (address)',
  'event FeeTaken(bytes32 indexed poolId,uint256 total,uint256 toHolders,uint256 toCreator,uint256 toPlatform)',
]);
export const ADVANCED_SPLITTER_ABI = parseAbi([
  'function currency() view returns (address)', 'function planHash() view returns (bytes32)', 'function hook() view returns (address)',
  'function recipientCount() view returns (uint256)', 'function recipients(uint256) view returns (address)',
  'function sharesBps(address) view returns (uint256)', 'function released(address) view returns (uint256)',
  'function claimable(address) view returns (uint256)', 'function release(address recipient) returns (uint256)',
  'function recoverStuckFees() returns (uint256)',
  'event Released(address indexed recipient,address indexed currency,uint256 amount)', 'event StuckFeesRecovered(uint256 amount)',
]);
export const ADVANCED_FEED_ABI = parseAbi([
  'function currency() view returns (address)', 'function hook() view returns (address)', 'function ledger() view returns (address)',
  'function recoverStuckFees() returns (uint256)', 'event StuckFeesRecovered(uint256 amount)',
]);
export const DEAD = '0x000000000000000000000000000000000000dead';

export function advancedPoolKey(token, pair, tickSpacing, hook) {
  const [currency0, currency1] = [token.toLowerCase(), pair.toLowerCase()].sort();
  const key = { currency0, currency1, fee: 0, tickSpacing, hooks: hook.toLowerCase() };
  return { key, poolId: keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY), [key])) };
}

const artifactUrl = name => new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url);
/** Loads FeeHook, TradeRouter, splitter and feed artifacts and asserts the runtime ABIs match. */
export async function loadAdvancedMarketArtifacts(paths = {}) {
  const read = async name => {
    try { return JSON.parse(await readFile(paths[name] ?? artifactUrl(name), 'utf8')).abi; }
    catch { throw new Error(`Compiled ${name} artifact is unavailable; advanced markets stay disabled.`); }
  };
  const [hook, router, splitter, feed] = await Promise.all(['FeeHook', 'TradeRouter', 'PluggedAdvancedSplitter', 'PluggedAdvancedFeed'].map(read));
  assertAbiMatchesArtifact(ADVANCED_HOOK_ABI, hook);
  assertAbiMatchesArtifact(TRADING_ABI.filter(item => item.type !== 'error'), router);
  assertAbiMatchesArtifact(ADVANCED_SPLITTER_ABI, splitter);
  assertAbiMatchesArtifact(ADVANCED_FEED_ABI, feed);
  return Object.freeze({ hook, router, splitter, feed });
}
