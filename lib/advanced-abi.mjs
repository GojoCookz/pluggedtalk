import { readFile } from 'node:fs/promises';
import { parseAbi, encodeFunctionData, toFunctionSelector, toEventSelector } from '../../app/node_modules/viem/_esm/index.js';

// Positional tuples from contracts/src/PluggedAdvancedFactory.sol. Tests and every preparation
// compare this encoder with the compiled Foundry artifact; a drift fails closed.
export const ADVANCED_ENGINE = 'plugged-advanced-v1';
export const MARKET_TUPLE = '(address pair,uint256 openingMarketCap,uint256 graduationThreshold,uint256 devBuyPairAmount,uint256 minPushPayout,int24 tickSpacing,uint16 feeBps,uint16 sellFeeBps,uint16 burnBps,uint16 creatorBps,uint32 openingWindow,uint16 openingFeeBps)';
export const ADVANCED_LAUNCH_TUPLE = `(string name,string symbol,uint256 supply,uint64 vestDuration,uint64 vestCliff,uint16 capToleranceBps,bytes32 salt,uint256 minShareForQueue,(bytes32 imageCid,bytes32 bannerCid,bytes32 infoCid) metadata,${MARKET_TUPLE}[] markets,address[] recipients,uint16[] sharesBps)`;
export const ADVANCED_FACTORY_ABI = parseAbi([
  `function launch(${ADVANCED_LAUNCH_TUPLE} p) returns (address token,uint8 priceableMarkets)`,
  `function economicsHash(${ADVANCED_LAUNCH_TUPLE} p) view returns (bytes32)`,
  'function predictTokenAddressFor(address creator,bytes32 salt) view returns (address)',
  'function minDevBuyFor(address pair) view returns (uint256)',
  'function registry() view returns (address)',
  'function feeHook() view returns (address)',
  'function pairRegistry() view returns (address)',
  'function MAX_WALLET_BPS() view returns (uint16)',
  'function MAX_MARKETS() view returns (uint256)',
  'function isOurs(address token) view returns (bool)',
  'function poolsOf(address token) view returns (bytes32[])',
  'function pairsOf(address token) view returns (address[])',
  'function ledgerOf(address token) view returns (address)',
  'function splitterOf(address token,address pair) view returns (address)',
  'event AdvancedLaunched(address indexed token,address indexed creator,bytes32 indexed economics,address ledger,uint8 marketCount,uint8 priceableMarkets)',
  'event MarketOpened(address indexed token,address indexed pair,bytes32 poolId,address feed,address splitter)',
  'event VaultCreated(address indexed token,address indexed vault,address indexed beneficiary,uint64 vestCliff,uint64 vestDuration)',
  'error InvalidEconomics()', 'error InvalidRecipients()', 'error PairNotApproved(address pair)', 'error DuplicateMarket(address pair)',
  'error OpeningBuyRequired(uint256 given,uint256 minimum)', 'error OpeningPriceOutOfRange()', 'error OpeningsDiverge()',
  'error UnsupportedTokenBehavior()', 'error BornGraduated(uint256 threshold,uint256 marketCap)', 'error DevBuyTooLarge(uint256 bought,uint256 cap)',
]);
export const LAUNCH_REGISTRY_ABI = parseAbi([
  'function FACTORY() view returns (address)',
  'function canonicalName(string name) pure returns (string)',
  'function canonicalTicker(string symbol) pure returns (string)',
  'function fingerprint(string ticker,string name,bytes32 settingsHash) pure returns (bytes32)',
  'function tokenFor(bytes32 key) view returns (address)',
  'event Registered(bytes32 indexed key,address indexed token,string ticker,string name,bytes32 settingsHash)',
  'error DuplicateLaunch(bytes32 key,address token)', 'error InvalidTicker()', 'error InvalidName()',
]);
export const ADVANCED_TOKEN_ABI = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)', 'function MAX_WALLET_BPS() view returns (uint16)',
]);

// Selectors cover canonical argument types; outputs, mutability and indexing are compared too.
const signature = item => JSON.stringify([item.type, item.type === 'event' ? toEventSelector(item) : toFunctionSelector(item),
  item.stateMutability === 'pure' || item.stateMutability === 'view' ? 'read' : item.stateMutability ?? null,
  (item.outputs ?? []).map(o => o.type), (item.inputs ?? []).map(i => Boolean(i.indexed))]);
/** Every hand-written item must exist in the compiled ABI with identical canonical types. */
export function assertAbiMatchesArtifact(handAbi, artifactAbi) {
  const compiled = new Set(artifactAbi.filter(item => ['function', 'event', 'error'].includes(item.type)).map(signature));
  for (const item of handAbi) if (!compiled.has(signature(item))) throw new Error(`Advanced ABI drift: ${item.type} ${item.name} is not in the compiled artifact.`);
  return true;
}
const artifactUrl = name => new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url);
export async function loadAdvancedArtifacts({ factoryPath = artifactUrl('PluggedAdvancedFactory'), registryPath = artifactUrl('PluggedLaunchRegistry') } = {}) {
  const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')).abi; } catch { throw new Error('Compiled advanced factory artifact is unavailable; advanced launch stays disabled.'); } };
  const [factory, registry] = await Promise.all([read(factoryPath), read(registryPath)]);
  assertAbiMatchesArtifact(ADVANCED_FACTORY_ABI, factory);
  assertAbiMatchesArtifact(LAUNCH_REGISTRY_ABI, registry);
  return Object.freeze({ factory, registry });
}
/** Encodes with the runtime ABI and requires byte-identical calldata from the compiled ABI. */
export function encodeAdvancedLaunch(params, artifacts) {
  const data = encodeFunctionData({ abi: ADVANCED_FACTORY_ABI, functionName: 'launch', args: [params] });
  if (!artifacts?.factory || encodeFunctionData({ abi: artifacts.factory, functionName: 'launch', args: [params] }) !== data)
    throw new Error('Advanced launch calldata differs from the compiled artifact.');
  return data;
}
