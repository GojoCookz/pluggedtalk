import { readFile } from 'node:fs/promises';
import { getAddress, getContractAddress, isAddress, keccak256, parseAbi, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_DEFAULT } from './carbon-abi.mjs';

export const CHAIN_ID = 4663;
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const COMPROMISED = '0xc286b1956c7691d678520e370727d8ab57328556';
const BASELINE = 'carbon-baseline-v1';
const ADVANCED = 'plugged-advanced-v1';
const legacyProfiles = new WeakSet();
const ROLES = ['launcher', 'pairRegistry', 'feeHook', 'tradeRouter', 'poolManager', 'tokenImplementation'];
const ABI = parseAbi([
  'function poolManager() view returns (address)', 'function feeHook() view returns (address)',
  'function pairRegistry() view returns (address)', 'function tokenImplementation() view returns (address)',
  'function launcher() view returns (address)', 'function platformRecipient() view returns (address)',
  'function owner() view returns (address)', 'function pendingOwner() view returns (address)',
  'function referralVault() view returns (address)', 'function rewardConverter() view returns (address)',
  'function PLATFORM_VOLUME_BPS() view returns (uint16)', 'function MAX_FEE_BPS() view returns (uint16)',
  'function registry() view returns (address)', 'function deployer() view returns (address)',
  'function FACTORY() view returns (address)',
  'function MAX_WALLET_BPS() view returns (uint16)',
]);

export function deploymentCapabilities(engine) {
  if (engine !== BASELINE && engine !== ADVANCED) throw new Error(`Unsupported deployment engine: ${engine}`);
  return Object.freeze({
    launchAbi: engine === BASELINE ? 'carbon-launch-v1' : 'plugged-advanced-v1',
    atomicDuplicateRejection: engine === ADVANCED,
    strictWalletCap: engine === ADVANCED,
    maxWalletBps: 300,
    multiPool: engine === ADVANCED,
    multiRecipient: engine === ADVANCED,
    maxPools: engine === ADVANCED ? 4 : 1,
    poolAllocation: engine === ADVANCED ? 'equal-supply' : 'single-pool',
    maxRecipients: engine === ADVANCED ? 100 : 1,
    creatorNamespacedSalt: engine === ADVANCED,
    referrals: false,
  });
}

export function deploymentAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress || value.toLowerCase() === COMPROMISED)
    throw new Error(`Invalid ${label}: supply a nonzero, non-compromised public address`);
  // getAddress additionally rejects invalid mixed-case checksums.
  return getAddress(value);
}

export function validateDeploymentOwner(input) {
  if (!input || input.chainId !== CHAIN_ID) throw new Error('Deployment owner chainId must be 4663');
  return Object.freeze({ chainId: CHAIN_ID,
    ownerAddress: deploymentAddress(input.ownerAddress, 'ownerAddress'),
    platformRecipientAddress: deploymentAddress(input.platformRecipientAddress, 'platformRecipientAddress'),
  });
}

export function validateDeploymentProfile(input, { allowSimulation = false, allowLegacyOwner = false } = {}) {
  if (!input || input.schemaVersion !== 1 || input.chainId !== CHAIN_ID) throw new Error('Invalid deployment profile schema or chain');
  if (input.status !== 'deployed' && !(allowSimulation && input.status === 'simulated'))
    throw new Error('Deployment profile is not deployed; a template or simulation cannot activate runtime');
  const capabilities = deploymentCapabilities(input.engine);
  if (input.independent === false && !allowLegacyOwner) throw new Error('Legacy exceptions require the built-in pinned Carbon loader');
  const ownerAddress = allowLegacyOwner && input.ownerAddress == null ? null : deploymentAddress(input.ownerAddress, 'ownerAddress');
  const platformRecipientAddress = deploymentAddress(input.platformRecipientAddress, 'platformRecipientAddress');
  const deployment = { chainId: CHAIN_ID }, hashes = {};
  const roles = input.engine === ADVANCED ? [...ROLES, 'factory', 'launchRegistry', 'satellites'] : ROLES;
  for (const role of roles) {
    const address = deploymentAddress(input.deployment?.[role], `deployment.${role}`);
    const entry = input.hashes?.[role];
    if (!entry || entry.address?.toLowerCase() !== address.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(entry.codeHash) ||
        /^0x0{64}$/.test(entry.codeHash) || !Number.isSafeInteger(entry.codeBytes) || entry.codeBytes <= 0)
      throw new Error(`Invalid code manifest: ${role}`);
    deployment[role] = address;
    hashes[role] = Object.freeze({ address, codeHash: entry.codeHash.toLowerCase(), codeBytes: entry.codeBytes });
  }
  if (deployment.poolManager.toLowerCase() !== POOL_MANAGER.toLowerCase()) throw new Error('Noncanonical Robinhood PoolManager');
  if ((BigInt(deployment.feeHook) & 0x3fffn) !== 0x20ccn) throw new Error('Hook address permissions must be 0x20cc');
  if (new Set(ROLES.map(role => deployment[role].toLowerCase())).size !== ROLES.length) throw new Error('Deployment roles must be distinct');
  if (input.engine === ADVANCED && (deployment.factory !== deployment.launcher ||
      new Set([...ROLES, 'launchRegistry', 'satellites'].map(role => deployment[role].toLowerCase())).size !== ROLES.length + 2))
    throw new Error('Advanced factory must be the launcher; registry and satellites must be distinct');
  if (input.platformVolumeBps !== 100 || input.maxFeeBps !== 1000) throw new Error('Unsupported Carbon fee policy');
  if (input.independent === false) {
    for (const [role, address] of Object.entries(CARBON_DEFAULT).filter(([role]) => role !== 'chainId')) {
      if (deployment[role].toLowerCase() !== address.toLowerCase()) throw new Error('Legacy profile must match the pinned Carbon deployment');
    }
    if (input.engine !== BASELINE || deployment.tokenImplementation.toLowerCase() !== '0x9199b12d5abf3488bb2160fbfef4e552d3d9ca34')
      throw new Error('Legacy implementation mismatch');
  }
  const provenance = {};
  if (input.deployerAddress != null || input.startingNonce != null || input.hookSalt != null || input.hookInitCodeHash != null) {
    provenance.deployerAddress = deploymentAddress(input.deployerAddress, 'deployerAddress');
    if (!Number.isSafeInteger(input.startingNonce) || input.startingNonce < 0 || !/^0x[0-9a-fA-F]{64}$/.test(input.hookSalt))
      throw new Error('Invalid deployment nonce or hook salt');
    provenance.startingNonce = input.startingNonce;
    provenance.hookSalt = input.hookSalt.toLowerCase();
    const offsets = input.engine === BASELINE ? { pairRegistry: 0, tokenImplementation: 1, launcher: 3, tradeRouter: 4 } :
      { pairRegistry: 0, tokenImplementation: 1, satellites: 2, launcher: 4, tradeRouter: 5 };
    for (const [role, offset] of Object.entries(offsets)) {
      if (getContractAddress({ from: provenance.deployerAddress, nonce: BigInt(input.startingNonce) + BigInt(offset) }) !== deployment[role])
        throw new Error(`CREATE provenance mismatch: ${role}`);
    }
    if (input.engine === ADVANCED && getContractAddress({ from: deployment.factory, nonce: 1n }) !== deployment.launchRegistry)
      throw new Error('Identity registry CREATE provenance mismatch');
    if (input.hookInitCodeHash != null) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(input.hookInitCodeHash)) throw new Error('Invalid hook init code hash');
      provenance.hookInitCodeHash = input.hookInitCodeHash.toLowerCase();
      if (getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: provenance.hookSalt, bytecodeHash: provenance.hookInitCodeHash }) !== deployment.feeHook)
        throw new Error('Hook CREATE2 provenance mismatch');
    }
  }
  return Object.freeze({ schemaVersion: 1, engine: input.engine, status: input.status, chainId: CHAIN_ID,
    ownerAddress, platformRecipientAddress, deployment: Object.freeze(deployment), hashes: Object.freeze(hashes),
    platformVolumeBps: 100, maxFeeBps: 1000, capabilities, verified: false,
    independent: input.independent !== false,
    ...provenance,
    blockNumber: input.blockNumber == null ? null : String(input.blockNumber),
  });
}

export async function loadDeploymentProfile({ profilePath, baselinePath = new URL('../data/carbon-deployment.json', import.meta.url) } = {}) {
  const input = JSON.parse(await readFile(profilePath ?? baselinePath, 'utf8'));
  if (profilePath) return validateDeploymentProfile(input);
  const profile = validateDeploymentProfile({ ...input, schemaVersion: 1, engine: BASELINE, status: 'deployed',
    independent: false, chainId: CHAIN_ID, ownerAddress: null,
    platformRecipientAddress: input.platformRecipient,
    deployment: { ...input.deployment, tokenImplementation: input.hashes?.tokenImplementation?.address },
  }, { allowLegacyOwner: true });
  legacyProfiles.add(profile);
  return profile;
}

export async function verifyDeploymentProfile(profile, { client, blockNumber } = {}) {
  if (!client) throw new Error('A read-only public client is required');
  const trustedLegacy = legacyProfiles.has(profile);
  const p = validateDeploymentProfile(profile, { allowLegacyOwner: trustedLegacy });
  if (await client.getChainId() !== CHAIN_ID) throw new Error('RPC chain mismatch');
  const pin = blockNumber == null ? await client.getBlockNumber({ cacheTime: 0 }) : BigInt(blockNumber);
  const d = p.deployment;
  const read = (address, functionName, abi = ABI) => client.readContract({ address, abi, functionName, blockNumber: pin });
  for (const [role, expected] of Object.entries(p.hashes)) {
    const code = await client.getCode({ address: d[role], blockNumber: pin });
    if (!code || code === '0x' || keccak256(code) !== expected.codeHash || (code.length - 2) / 2 !== expected.codeBytes)
      throw new Error(`Runtime code mismatch: ${role}`);
  }
  const links = [
    [d.launcher, 'poolManager', d.poolManager], [d.launcher, 'feeHook', d.feeHook],
    [d.launcher, 'pairRegistry', d.pairRegistry], [d.launcher, 'tokenImplementation', d.tokenImplementation],
    [d.feeHook, 'poolManager', d.poolManager], [d.feeHook, 'launcher', d.launcher],
    [d.feeHook, 'platformRecipient', p.platformRecipientAddress], [d.tradeRouter, 'poolManager', d.poolManager],
  ];
  for (const [address, getter, expected] of links) {
    if ((await read(address, getter)).toLowerCase() !== expected.toLowerCase()) throw new Error(`Immutable link mismatch: ${getter} at ${address}`);
  }
  const owner = await read(d.pairRegistry, 'owner');
  if (p.ownerAddress && owner.toLowerCase() !== p.ownerAddress.toLowerCase()) throw new Error('Registry owner mismatch');
  if (p.independent && (await read(d.pairRegistry, 'pendingOwner')).toLowerCase() !== zeroAddress) throw new Error('Registry has a pending ownership transfer');
  if (Number(await read(d.feeHook, 'PLATFORM_VOLUME_BPS')) !== 100 || Number(await read(d.feeHook, 'MAX_FEE_BPS')) !== 1000)
    throw new Error('On-chain fee policy mismatch');
  if (p.independent && p.engine === BASELINE) {
    if ((await read(d.launcher, 'referralVault')).toLowerCase() !== zeroAddress || (await read(d.launcher, 'rewardConverter')).toLowerCase() !== zeroAddress)
      throw new Error('Independent baseline optional wiring differs from reviewed no-referral/native-quote profile');
  }
  if (p.engine === ADVANCED) {
    if (Number(await read(d.factory, 'MAX_WALLET_BPS')) !== 300 || Number(await read(d.tokenImplementation, 'MAX_WALLET_BPS')) !== 300)
      throw new Error('Advanced strict wallet policy mismatch');
    for (const [address, getter, expected] of [
      [d.factory, 'registry', d.launchRegistry], [d.factory, 'deployer', d.satellites],
      [d.launchRegistry, 'FACTORY', d.factory],
    ]) {
      if ((await read(address, getter)).toLowerCase() !== expected.toLowerCase()) throw new Error(`Advanced immutable link mismatch: ${getter}`);
    }
  }
  const verified = Object.freeze({ ...p, ownerAddress: getAddress(owner), verified: true, verifiedBlock: pin.toString() });
  if (trustedLegacy) legacyProfiles.add(verified);
  return verified;
}
