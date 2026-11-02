// Read-only deployment evidence. No signing client and no mainnet state changes.
import { publicClient } from '../lib/launch-service.mjs';
import { CARBON_DEFAULT as engine } from '../lib/carbon-abi.mjs';
import { TRADING_ABI,TRADING_ROUTER_HASH } from '../lib/trading-abi.mjs';
import { keccak256,toFunctionSelector } from '../../app/node_modules/viem/_esm/index.js';
const client=publicClient(),blockNumber=await client.getBlockNumber();
const [chainId,code,manager,block]=await Promise.all([
  client.getChainId(),client.getCode({address:engine.tradeRouter,blockNumber}),
  client.readContract({address:engine.tradeRouter,abi:TRADING_ABI,functionName:'poolManager',blockNumber}),client.getBlock({blockNumber}),
]);
if(chainId!==4663||!code||keccak256(code)!==TRADING_ROUTER_HASH||manager.toLowerCase()!==engine.poolManager)throw new Error('Live trading deployment does not match the pinned adapter.');
const selector=toFunctionSelector(TRADING_ABI.find(a=>a.name==='swap'));
if(!code.includes(selector.slice(2)))throw new Error('Expected swap selector missing from runtime.');
console.log(JSON.stringify({chainId,blockNumber:String(blockNumber),blockHash:block.hash,router:engine.tradeRouter,routerHash:keccak256(code),bytes:(code.length-2)/2,poolManager:manager,swapSelector:selector,onchainDeadline:false,checkedAt:new Date().toISOString()},null,2));
