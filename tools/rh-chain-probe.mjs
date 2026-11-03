// Read-only Robinhood Chain (4663) standards probe. Verifies chain id, ArbOS version, EVM opcode
// support, code size limit and the code hashes of every external contract Plugged relies on.
// Usage: bun tools/rh-chain-probe.mjs [--json]. Exits 1 on any mismatch. Sends no transactions.
import { keccak256 } from '../../app/node_modules/viem/_esm/index.js';

const RPC = process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  return j.error ? { error: j.error.message } : j.result;
}
// Measured 2026-11-03 against block ~105,340,675. A change means an upgrade or a wrong address: re-review before use.
export const PINNED = {
  PoolManager: ['0x8366a39CC670B4001A1121B8F6A443A643e40951', 24009, '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626'],
  PositionManager: ['0x58daec3116aae6d93017baaea7749052e8a04fa7', 23877, '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2'],
  V4Quoter: ['0x8dc178efb8111bb0973dd9d722ebeff267c98f94', 6118, '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6'],
  StateView: ['0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', 3531, '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6'],
  UniversalRouter: ['0x8876789976dEcBfCbBbe364623C63652db8C0904', 24546, '0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde'],
  Permit2: ['0x000000000022D473030F116dDEE9F6B43aC78BA3', 9152, '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca'],
  CREATE2Deployer: ['0x4e59b44847b379578588920cA78FbF26c0B4956C', 69, '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989'],
  Multicall3: ['0xcA11bde05977b3631167028862bE2a173976CA11', 3808, '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891'],
  WETH: ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 2202, '0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353'],
  USDGProxy: ['0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 170, '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6'],
  CarbonTokenImplementation: ['0x9199b12d5abf3488bb2160fbfef4e552d3d9ca34', 11307, '0xc7c8fb236e96f1a1eb2821db5c61b79ee5e4a761000cee281fa924cd52a82433'],
};
// Listed by Uniswap for 4663 but not used by Plugged; reported, never failed on.
const LISTED = { ReservesLens: '0x0000001b173C3bbF3984D417d8614E3eed34865B', UniversalRouter_2_1_2: '0x204FAca1764B154221e35c0d20aBb3c525710498' };
const PROBE = '0x00000000000000000000000000000000000c0de0';
const run = code => rpc('eth_call', [{ to: PROBE, data: '0x' }, 'latest', { [PROBE]: { code } }]);

const out = { rpc: RPC, failures: [] };
out.chainId = parseInt(await rpc('eth_chainId'), 16);
if (out.chainId !== 4663) out.failures.push(`chainId ${out.chainId}`);
const block = await rpc('eth_getBlockByNumber', ['latest', false]);
out.block = parseInt(block.number, 16);
out.arbOS = parseInt(String(await rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000064', data: '0x051038f2' }, 'latest'])), 16) - 55;
const gasInfo = await rpc('eth_call', [{ to: '0x000000000000000000000000000000000000006C', data: '0x612af178' }, 'latest']);
out.maxTxGasLimit = typeof gasInfo === 'string' ? parseInt(gasInfo.slice(2 + 128, 2 + 192), 16) : gasInfo;
out.opcodes = {
  PUSH0: typeof await run('0x5f5ff3') === 'string', TSTORE: typeof await run('0x60015f5d5f5c5f5260205ff3') === 'string',
  MCOPY: typeof await run('0x60205f5f5e5f5ff3') === 'string', CLZ: await run('0x60011e5f5260205ff3') === '0x' + 'ff'.padStart(64, '0'),
};
for (const k of ['PUSH0', 'TSTORE', 'MCOPY']) if (!out.opcodes[k]) out.failures.push(`opcode ${k} unsupported (cancun target needs it)`);
const size = async n => rpc('eth_estimateGas', [{ from: '0x1111111111111111111111111111111111111111', data: '0x62' + n.toString(16).padStart(6, '0') + '5ff3' }]);
out.maxCodeSize = typeof await size(98304) === 'string' && typeof await size(98305) === 'object' ? 98304 : 'changed';
if (out.maxCodeSize !== 98304) out.failures.push('max code size is no longer 98304 bytes');
out.contracts = {};
for (const [name, [address, bytes, hash]] of Object.entries(PINNED)) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  const got = typeof code === 'string' ? { bytes: (code.length - 2) / 2, hash: keccak256(code) } : { error: code.error };
  const ok = got.bytes === bytes && got.hash === hash;
  out.contracts[name] = { address, ok, ...got };
  if (!ok) out.failures.push(`${name} code changed at ${address}`);
}
out.listed = {};
for (const [name, address] of Object.entries(LISTED)) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  out.listed[name] = typeof code === 'string' ? { address, bytes: (code.length - 2) / 2, hash: keccak256(code) } : { address, error: code.error };
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`chain ${out.chainId} block ${out.block} ArbOS ${out.arbOS} maxTxGas ${out.maxTxGasLimit} maxCode ${out.maxCodeSize}`);
  console.log(`opcodes ${Object.entries(out.opcodes).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const [k, v] of Object.entries(out.contracts)) console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${k} ${v.address} ${v.bytes ?? v.error}`);
  for (const [k, v] of Object.entries(out.listed)) console.log(`info ${k} ${v.address} ${v.bytes ?? v.error} ${v.hash ?? ''}`);
  console.log(out.failures.length ? `FAILURES: ${out.failures.join('; ')}` : 'all pinned contracts and chain parameters match');
}
process.exit(out.failures.length ? 1 : 0);
