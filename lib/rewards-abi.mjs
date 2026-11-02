import { parseAbi, encodeAbiParameters, keccak256 } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_DEFAULT } from './carbon-abi.mjs';

export const POOL_KEY='(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const REWARDS_HOOK_ABI=parseAbi([
  `function sweep(${POOL_KEY} key) returns (uint256)`,
  // Deployed 14-word return verified on fork block 102763698. The older app ABI
  // omitted opening fields and incorrectly decoded a timestamp as rewardCurrency.
  'function poolConfig(bytes32) view returns (address distributor,address pairCurrency,uint16 feeBps,address creator,uint16 creatorBps,bool configured,uint16 sellFeeBps,uint16 burnBps,uint16 platformShareBps,uint16 sellPlatformShareBps,uint32 openingFeeEndsAt,uint32 openingWindow,uint16 openingFeeBps,address rewardCurrency)',
  'function pendingFees(bytes32) view returns (uint256)',
  'function pendingTokenFees(bytes32) view returns (uint256)',
  'event FeeTaken(bytes32 indexed poolId,uint256 total,uint256 toHolders,uint256 toCreator,uint256 toPlatform)',
  'event SweepBounty(bytes32 indexed poolId,address indexed caller,uint256 amount)',
]);
export const REWARDS_TOKEN_ABI=parseAbi(['function distributor() view returns (address)']);
export const REWARDS_DISTRIBUTOR_ABI=parseAbi([
  'function shareToken() view returns (address)',
  'function payoutToken() view returns (address)',
  'function controller() view returns (address)',
  'function withdrawableOf(address) view returns (uint256)',
  'function withdrawnOf(address) view returns (uint256)',
  'function shareOf(address) view returns (uint256)',
  'function streamFinish() view returns (uint64)',
  'function withdraw() returns (uint256)',
  'event PayoutSent(address indexed account,uint256 amount)',
  'event PayoutSendFailed(address indexed account,uint256 amount)',
  'event RewardConverted(address indexed to,uint256 amountIn,uint256 amountOut,address token)',
]);
export const REWARDS_SPLITTER_ABI=parseAbi([
  'function currency() view returns (address)',
  'function planHash() view returns (bytes32)',
  'function recipientCount() view returns (uint256)',
  'function recipients(uint256) view returns (address)',
  'function sharesBps(address) view returns (uint256)',
  'function released(address) view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'function release(address recipient) returns (uint256)',
  'event Released(address indexed recipient,address indexed currency,uint256 amount)',
]);
export function rewardsPool(token,quote,tickSpacing=60){
  const [currency0,currency1]=[token.toLowerCase(),quote.toLowerCase()].sort();
  const key={currency0,currency1,fee:0,tickSpacing,hooks:CARBON_DEFAULT.feeHook};
  const poolId=keccak256(encodeAbiParameters([{type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]}],[key]));
  return {key,poolId};
}
