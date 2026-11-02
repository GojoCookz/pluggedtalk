import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const forward = p => p.replaceAll('\\', '/');
const temporary = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : '/tmp';
await mkdir(temporary, { recursive: true });
const project = await mkdtemp(path.join(temporary, 'carbon-rewards-fork-'));
await mkdir(path.join(project, 'test'));
await copyFile(new URL('./rewards-fork.t.sol', import.meta.url), path.join(project, 'test', 'RewardsFork.t.sol'));
await copyFile(new URL('../artifacts/carbon-fork-fixtures.json', import.meta.url), path.join(project, 'fixture.json'));
await writeFile(path.join(project, 'foundry.toml'), `[profile.default]
src = "src"
test = "test"
out = "out"
cache_path = "cache"
solc_version = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
via_ir = true
ffi = false
fs_permissions = [{ access = "read", path = "./fixture.json" }]
remappings = ["forge-std/=${forward(path.join(root, 'contracts/lib/forge-std/src/'))}"]
`);
let pin = process.argv[2] || '102763698';
if (pin === '--fresh-pin') {
  const rpc = process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const request = async (method, params) => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await response.json();
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  const block = await request('eth_getBlockByNumber', ['latest', false]);
  pin = BigInt(block.number).toString();
  console.log(`Pinned block: ${pin}; hash: ${block.hash}`);
}
const env = { ...process.env, REWARDS_FIXTURE: forward(path.join(project, 'fixture.json')), REWARDS_FORK_BLOCK: pin };
console.log(`Isolated Foundry project: ${project}`);
// This machine's WSL /usr/local/bin/forge is a shim to this Windows binary.
// Invoke it directly so --root, remappings, and environment use matching paths.
const forge = process.env.REWARDS_FORGE || (process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.foundry/bin/forge.exe') : 'forge');
const result = spawnSync(forge, ['test', '--root', project, '-vvv'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
const output = (result.stdout || '') + (result.stderr || '');
await writeFile(path.join(project, 'run.log'), output);
console.log(output.split(/\r?\n/).filter(line => !/[│├└]/.test(line)).join('\n'));
console.log(`Full execution evidence: ${path.join(project, 'run.log')}`);
if (result.error) throw result.error;
// Fail closed if Foundry discovers no tests (a misconfigured --root can exit zero).
process.exitCode = result.status === 0 && /4 tests passed, 0 failed, 0 skipped/.test(output) ? 0 : (result.status || 1);
