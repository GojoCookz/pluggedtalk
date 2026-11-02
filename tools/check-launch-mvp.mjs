import { writeFile } from 'node:fs/promises';
import { parseEther } from '../../app/node_modules/viem/_esm/index.js';
import { LaunchService,publicClient } from '../lib/launch-service.mjs';
import { LaunchStore } from '../lib/launch-store.mjs';
import { prepareFunding } from '../lib/funding-service.mjs';
const client=publicClient(),store=new LaunchStore(':memory:');
const account='0x1111111111111111111111111111111111111111',quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const launch=await new LaunchService({client,store}).prepare({account,quote,name:'Read only smoke fixture',symbol:'SMOKE',imageCid:'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm',openingBuy:'1',feeBps:200,creatorBps:7500});
// eth_estimateGas override is ephemeral, not a funded account and not a transaction.
const simulationClient={...client,estimateGas:args=>client.estimateGas({...args,stateOverride:[{address:account,balance:parseEther('1')}]})};
const funding=await prepareFunding({account,quote,amountEth:'0.001',slippageBps:50},{client:simulationClient});
const report={checkedAt:new Date().toISOString(),launch:{next:launch.next,fees:launch.fees,price:launch.price,predicted:launch.predicted},funding:{executable:funding.executable,minimumOutput:funding.minimumOutput,gas:funding.transaction.gas,to:funding.transaction.to,selector:funding.transaction.data.slice(0,10)},simulation:'RPC gas estimation with temporary 1 ETH balance override. No transaction broadcast.'};
await writeFile(new URL('../artifacts/launch-mvp-smoke.json',import.meta.url),JSON.stringify(report,null,2));store.close();console.log(JSON.stringify(report,null,2));
