import { createPublicClient, http, encodeFunctionData, parseAbi, keccak256, toFunctionSelector } from '../../app/node_modules/viem/_esm/index.js';
import { readFile } from 'node:fs/promises';

const deployment = JSON.parse(await readFile(new URL('../data/carbon-deployment.json', import.meta.url)));
const client = createPublicClient({ transport: http(process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com') });
const blockNumber = process.argv[2] ? BigInt(process.argv[2]) : await client.getBlockNumber();
const hook = deployment.deployment.feeHook;
const code = await client.getCode({ address: hook, blockNumber });
const abi = parseAbi(['function poolConfig(bytes32)', 'function stuckFeesOf(address,address) view returns(uint256)', 'function stuckFees(address,address) view returns(uint256)', 'function stuckTotal(address) view returns(uint256)', 'function claimStuckFees(address) returns(uint256)']);
const raw = await client.call({ to: hook, blockNumber, data: encodeFunctionData({ abi, functionName: 'poolConfig', args: [`0x${'00'.repeat(32)}`] }) });
console.log(JSON.stringify({ blockNumber: String(blockNumber), blockHash: (await client.getBlock({ blockNumber })).hash, hookCodeHash: keccak256(code), poolConfigBytes: (raw.data.length - 2) / 2, poolConfigWords: (raw.data.length - 2) / 64, selectors: Object.fromEntries(['poolConfig(bytes32)', 'sweep((address,address,uint24,int24,address))', 'stuckFeesOf(address,address)', 'stuckFees(address,address)', 'stuckTotal(address)', 'claimStuckFees(address)'].map(sig => [sig, { selector: toFunctionSelector(sig), presentInBytecode: code.includes(toFunctionSelector(sig).slice(2)) }])) }, null, 2));
for (const functionName of ['stuckFeesOf', 'stuckFees', 'stuckTotal', 'claimStuckFees']) {
  try {
    const args = functionName === 'stuckFeesOf' || functionName === 'stuckFees' ? [deployment.deployment.launcher, deployment.deployment.launcher] : [deployment.deployment.launcher];
    const result = await client.call({ to: hook, blockNumber, data: encodeFunctionData({ abi, functionName, args }) });
    console.log(functionName, result.data);
  } catch (error) { console.log(functionName, error.shortMessage, error.cause?.data || ''); }
}
