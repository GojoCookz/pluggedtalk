import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPublicClient, http, getContractAddress, encodeFunctionData, erc20Abi, parseAbi, keccak256 } from '../../app/node_modules/viem/_esm/index.js';
import { CHAIN_ID, CREATE2_DEPLOYER, POOL_MANAGER, deploymentAddress, validateDeploymentOwner,
  validateDeploymentProfile, verifyDeploymentProfile } from '../lib/deployment-profile.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANAGER_HASH = '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626';
const PROXY_CODE = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const PAIR_ABI = parseAbi([
  'function pairConfig(address pair) view returns ((bool approved,address feed,uint32 maxStaleness,uint8 feedDecimals,uint8 tokenDecimals))',
  'function approvePairWithoutOracle(address pair,uint8 tokenDecimals)',
  'function isApproved(address pair) view returns (bool)',
  'function isDenied(address pair) view returns (bool)',
]);

export async function prepareDeployment({ client, ownerPlan, deployerAddress, engine = 'carbon-baseline-v1' }) {
  if (!['carbon-baseline-v1', 'plugged-advanced-v1'].includes(engine)) throw new Error('Unsupported deployment engine');
  const owner = validateDeploymentOwner(ownerPlan);
  const deployer = deploymentAddress(deployerAddress, 'deployerAddress');
  if (await client.getChainId() !== CHAIN_ID) throw new Error('RPC chain mismatch');
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [managerCode, proxyCode, nonce, pendingNonce] = await Promise.all([
    client.getCode({ address: POOL_MANAGER, blockNumber }), client.getCode({ address: CREATE2_DEPLOYER, blockNumber }),
    client.getTransactionCount({ address: deployer, blockNumber }),
    client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
  ]);
  if (!managerCode || keccak256(managerCode) !== MANAGER_HASH) throw new Error('Canonical PoolManager code mismatch');
  if (proxyCode?.toLowerCase() !== PROXY_CODE) throw new Error('Canonical CREATE2 proxy code mismatch');
  if (nonce !== pendingNonce) throw new Error('Deployer has pending transactions; reserved CREATE addresses are unstable');
  const advanced = engine === 'plugged-advanced-v1';
  const offsets = advanced ? [['pairRegistry', 0], ['tokenImplementation', 1], ['satellites', 2], ['launcher', 4], ['factory', 4], ['tradeRouter', 5]] :
    [['pairRegistry', 0], ['tokenImplementation', 1], ['launcher', 3], ['tradeRouter', 4]];
  const predicted = Object.fromEntries(offsets
    .map(([role, offset]) => [role, getContractAddress({ from: deployer, nonce: BigInt(nonce + offset) })]));
  if (advanced) predicted.launchRegistry = getContractAddress({ from: predicted.factory, nonce: 1n });
  return { schemaVersion: 1, engine, status: 'planned-not-deployed', ...owner,
    deployerAddress: deployer, blockNumber: blockNumber.toString(), startingNonce: nonce, predicted,
    sequence: advanced ? ['PairRegistry(owner)', 'PluggedAdvancedToken', 'MultiDeployer', 'CREATE2 FeeHook(factory=n+4, platformRecipient)', 'PluggedAdvancedFactory (creates identity registry internally)', 'TradeRouter'] :
      ['PairRegistry(owner)', 'LaunchToken', 'CREATE2 FeeHook(launcher=n+3, platformRecipient)', 'Launcher', 'TradeRouter'],
    note: `The CREATE2 transaction consumes nonce n+${advanced ? 3 : 2}. No referral vault or ownership transfer. Pair approvals are separate owner transactions.` };
}

export async function preparePairApprovals(profile, { client, pairs, blockNumber } = {}) {
  const verified = await verifyDeploymentProfile(profile, { client, blockNumber });
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > 1000) throw new Error('Supply 1–1000 quote addresses');
  const seen = new Set(), results = [];
  const pin = BigInt(verified.verifiedBlock);
  const checked = pairs.map(input => {
    const address = deploymentAddress(input.address, 'quote address');
    if (seen.has(address.toLowerCase())) throw new Error('Duplicate quote address');
    seen.add(address.toLowerCase());
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 18) throw new Error('Carbon quote decimals must be 0–18');
    return { address, decimals: input.decimals };
  });
  const inspect = async input => {
    const { address } = input;
    const [code, actual, cfg, approved, denied] = await Promise.all([
      client.getCode({ address, blockNumber: pin }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber: pin }),
      ...['pairConfig', 'isApproved', 'isDenied'].map(functionName => client.readContract({
        address: verified.deployment.pairRegistry, abi: PAIR_ABI, functionName, args: [address], blockNumber: pin,
      })),
    ]);
    if (!code || code === '0x') throw new Error(`Missing quote code: ${address}`);
    if (Number(actual) !== input.decimals) throw new Error(`Quote decimals mismatch: ${address}`);
    if (denied) throw new Error(`Quote is explicitly denied by registry owner: ${address}`);
    if (cfg.approved && Number(cfg.tokenDecimals) !== actual) throw new Error(`Approved quote has incorrect cached decimals: ${address}`);
    return { address, decimals: actual, codeHash: keccak256(code), approved, explicitlyApproved: cfg.approved,
      setupTransaction: approved ? null : { chainId: CHAIN_ID, from: verified.ownerAddress,
        to: verified.deployment.pairRegistry, value: '0x0', data: encodeFunctionData({ abi: PAIR_ABI,
          functionName: 'approvePairWithoutOracle', args: [address, actual] }) } };
  };
  // Bounded RPC batching avoids serially aging a 469-quote snapshot past public-node retention.
  for (let offset = 0; offset < checked.length; offset += 8)
    results.push(...await Promise.all(checked.slice(offset, offset + 8).map(inspect)));
  return { schemaVersion: 1, status: 'unsigned', chainId: CHAIN_ID, ownerAddress: verified.ownerAddress,
    pairRegistry: verified.deployment.pairRegistry, blockNumber: verified.verifiedBlock, pairs: results };
}

async function writeNew(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

function runtimeOutput(value) {
  if (!value) throw new Error('--out is required; choose a NEW file under plugged/runtime/');
  const path = resolve(value), rel = relative(resolve(ROOT, 'runtime'), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || path.endsWith('deployment-owner.json')) throw new Error('Output must be a new file under plugged/runtime/, never the owner plan');
  return path;
}

function runForge(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('forge', args, { cwd: resolve(ROOT, 'contracts'), env: { ...process.env, ...env }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`forge exited ${code}`)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const allowed = new Set(['profile', 'owner-plan', 'deployer', 'platform-recipient', 'rpc-url', 'out', 'pairs', 'engine']);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed.has(name) || options[name] != null || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error(`Unknown, duplicate or incomplete option: ${rest[i]}. This tool never broadcasts or accepts keys.`);
    options[name] = rest[i + 1];
  }
  if (command === 'help') {
    console.log('deployment.mjs plan|simulate --owner-plan PATH --deployer ADDRESS [--engine carbon-baseline-v1|plugged-advanced-v1] [--platform-recipient ADDRESS] [--out runtime/NEW.json]\n' +
      'deployment.mjs verify --profile PATH [--out runtime/NEW-deployed.json]\n' +
      'deployment.mjs pairs --profile PATH --pairs PATH --out runtime/NEW-pairs.json\n' +
      'All operations are read-only on chain. simulate runs Foundry without --broadcast. Foundry must be on PATH; use native Linux binaries inside WSL.');
    return;
  }
  if (!['plan', 'simulate', 'verify', 'pairs'].includes(command)) throw new Error('Unknown deployment command');
  const client = createPublicClient({ transport: http(options['rpc-url'] || process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', { timeout: 30000, retryCount: 1, batch: { batchSize: 40, wait: 10 } }) });
  if (command === 'plan' || command === 'simulate') {
    const ownerPlan = JSON.parse(await readFile(options['owner-plan'] || resolve(ROOT, 'runtime/deployment-owner.json'), 'utf8'));
    if (options['platform-recipient']) ownerPlan.platformRecipientAddress = options['platform-recipient'];
    const plan = await prepareDeployment({ client, ownerPlan, deployerAddress: options.deployer, engine: options.engine });
    if (command === 'plan') {
      if (options.out) await writeNew(runtimeOutput(options.out), plan);
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const output = runtimeOutput(options.out);
    try { await access(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(output), { recursive: true });
    const entrypoint = plan.engine === 'plugged-advanced-v1' ? 'script/DeployPluggedAdvanced.s.sol:DeployPluggedAdvanced' : 'script/DeployPlugged.s.sol:DeployPlugged';
    await runForge(['script', entrypoint, '--sig', 'run(address,address,address)',
      plan.ownerAddress, plan.platformRecipientAddress, plan.deployerAddress, '--sender', plan.deployerAddress,
      '--rpc-url', options['rpc-url'] || process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
      '--fork-block-number', plan.blockNumber], { PLUGGED_MANIFEST_OUT: output });
    const simulated = validateDeploymentProfile(JSON.parse(await readFile(output, 'utf8')), { allowSimulation: true });
    for (const [role, address] of Object.entries(plan.predicted)) if (simulated.deployment[role].toLowerCase() !== address.toLowerCase()) throw new Error(`Simulation reservation mismatch: ${role}`);
    console.log(`Simulation manifest: ${output}. Not a deployed/runtime profile.`);
    return;
  }
  if (!options.profile) throw new Error('--profile is required');
  const raw = JSON.parse(await readFile(options.profile, 'utf8'));
  // A simulated file is promoted only after live code, owner and immutable-link checks all pass.
  const profile = validateDeploymentProfile({ ...raw, status: raw.status === 'simulated' ? 'deployed' : raw.status });
  if (command === 'verify') {
    const verified = await verifyDeploymentProfile(profile, { client });
    if (options.out) await writeNew(runtimeOutput(options.out), verified);
    console.log(JSON.stringify(verified, null, 2));
  } else {
    if (!options.pairs) throw new Error('--pairs is required');
    const input = JSON.parse(await readFile(options.pairs, 'utf8'));
    const report = await preparePairApprovals(profile, { client, pairs: Array.isArray(input) ? input : input.pairs });
    await writeNew(runtimeOutput(options.out), report);
    console.log(JSON.stringify({ blockNumber: report.blockNumber, configured: report.pairs.length,
      pending: report.pairs.filter(p => p.setupTransaction).length }, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
