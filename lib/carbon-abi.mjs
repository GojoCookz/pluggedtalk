import { parseAbi } from '../../app/node_modules/viem/_esm/index.js';

// Same positional tuple as Carbon app/src/lib/abi.ts. Tests compare both encoders.
export const LAUNCH_TUPLE='(string name,string symbol,uint256 supply,address pair,uint256 openingMarketCap,uint256 graduationThreshold,uint16 feeBps,uint16 sellFeeBps,uint16 burnBps,uint64 vestDuration,uint64 vestCliff,uint16 creatorBps,uint16 maxWalletBps,int24 tickSpacing,uint256 devBuyPairAmount,bytes32 salt,uint256 minPushPayout,uint256 minShareForQueue,address rewardCurrency,address feeRecipient,address referrer,uint32 openingWindow,uint16 openingFeeBps,(bytes32 imageCid,bytes32 bannerCid,bytes32 infoCid) metadata)';
export const CARBON_ABI=parseAbi([
  `function launch(${LAUNCH_TUPLE} p) returns (address token,bytes32 poolId)`,
  'function poolManager() view returns (address)',
  'function feeHook() view returns (address)',
  'function pairRegistry() view returns (address)',
  'function tokenImplementation() view returns (address)',
  'function predictTokenAddress(bytes32 salt) view returns (address)',
  'event Launched(address indexed token,address indexed creator,address indexed pair,bytes32 poolId,uint256 supply,uint256 openingMarketCap,uint16 feeBps)',
]);
export const REGISTRY_ABI=parseAbi([
  'function owner() view returns (address)',
  'function isApproved(address pair) view returns (bool)',
  'function pairConfig(address pair) view returns ((bool approved,address feed,uint32 maxStaleness,uint8 feedDecimals,uint8 tokenDecimals))',
  'function approvePairWithoutOracle(address pair,uint8 tokenDecimals)',
]);
export const HOOK_ABI=parseAbi([
  'function launcher() view returns (address)',
  'function platformRecipient() view returns (address)',
  'function PLATFORM_VOLUME_BPS() view returns (uint16)',
  'function MAX_FEE_BPS() view returns (uint16)',
]);
export const CARBON_DEFAULT=Object.freeze({chainId:4663,
  launcher:'0xcc491f9962ca5545163ac425210b69e24ac29a96',
  pairRegistry:'0xdff0a6ffd11eb1494e8a57dd5ef92b23122baec0',
  feeHook:'0xdc0244274f0b4e60ec4433bfa9d3ff0632caa0cc',
  tradeRouter:'0xd6edcd3cc28c40b42d6fe31b054ebb93a944a3a6',
  poolManager:'0x8366a39cc670b4001a1121b8f6a443a643e40951'});
