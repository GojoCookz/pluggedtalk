import { parseAbi } from '../../app/node_modules/viem/_esm/index.js';

// Pinned deployed Carbon TradeRouter. There is deliberately NO deadline argument.
export const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const TRADING_ABI = parseAbi([
  `function swap(${POOL_KEY} key,bool zeroForOne,uint256 amountIn,uint256 minAmountOut,address recipient) returns (uint256 amountOut)`,
  'function poolManager() view returns (address)',
  `event Traded(${POOL_KEY} key,address indexed trader,address indexed recipient,bool zeroForOne,uint256 amountIn,uint256 amountOut)`,
  'error TooLittleReceived(uint256 got,uint256 minOut)',
  'error ZeroAmount()',
]);
export const TRADING_ROUTER_HASH = '0x67867a85f9694ba856fa05c374f588fb2b293127c5576424d7e35dc09f9b3246';
