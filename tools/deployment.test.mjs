import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { keccak256, zeroAddress, getAddress, getContractAddress, decodeFunctionData, parseAbi } from '../../app/node_modules/viem/_esm/index.js';
import { loadDeploymentProfile, validateDeploymentProfile, verifyDeploymentProfile, validateDeploymentOwner,
  deploymentCapabilities, POOL_MANAGER } from '../lib/deployment-profile.mjs';
import { preparePairApprovals, main } from './deployment.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const platform = '0x2222222222222222222222222222222222222222';
const code = '0x60006000f3';
function fixture() {
  const deployment = { launcher: '0x0000000000000000000000000000000000000011', pairRegistry: '0x0000000000000000000000000000000000000012',
    feeHook: '0x00000000000000000000000000000000000020cc', tradeRouter: '0x0000000000000000000000000000000000000013',
    tokenImplementation: '0x0000000000000000000000000000000000000014', poolManager: POOL_MANAGER };
  const hashes = Object.fromEntries(Object.entries(deployment).map(([role, address]) => [role, { address, codeHash: keccak256(code), codeBytes: 5 }]));
  return { schemaVersion: 1, engine: 'carbon-baseline-v1', status: 'deployed', chainId: 4663, ownerAddress: owner,
    platformRecipientAddress: platform, deployment, hashes, platformVolumeBps: 100, maxFeeBps: 1000 };
}
function mock(profile = fixture(), overrides = {}) {
  const d = profile.deployment;
  return {
    getChainId: async () => 4663, getBlockNumber: async () => 1234n, getCode: async () => code,
    readContract: async ({ address, functionName, blockNumber }) => {
      assert.equal(blockNumber, 1234n, 'all verification reads pinned');
      if (functionName === 'owner') return owner;
      if (['pendingOwner', 'referralVault', 'rewardConverter'].includes(functionName)) return zeroAddress;
      if (functionName === 'platformRecipient') return platform;
      if (functionName === 'PLATFORM_VOLUME_BPS') return 100;
      if (functionName === 'MAX_FEE_BPS') return 1000;
      if (functionName === 'MAX_WALLET_BPS') return 300;
      if (functionName === 'decimals') return 6;
      if (functionName === 'pairConfig') return { approved: false, tokenDecimals: 0 };
      if (functionName === 'isApproved' || functionName === 'isDenied') return false;
      if (functionName === 'registry') return d.launchRegistry;
      if (functionName === 'deployer') return d.satellites;
      if (functionName === 'FACTORY') return d.factory;
      if (functionName in d) return d[functionName];
      throw new Error(`${address}:${functionName}`);
    }, ...overrides,
  };
}

test('pinned baseline loads without falsely advertising advanced capabilities', async () => {
  const p = await loadDeploymentProfile();
  assert.equal(p.engine, 'carbon-baseline-v1');
  assert.equal(p.verified, false);
  assert.equal(p.independent, false);
  assert.equal(p.capabilities.strictWalletCap, false);
  assert.equal(p.capabilities.atomicDuplicateRejection, false);
});
test('Merc templates remain blank and cannot activate runtime', async () => {
  for (const file of ['../deployment-owner.example.json', '../data/deployment-profile.example.json']) {
    const p = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.equal(p.ownerAddress, ''); assert.equal(p.platformRecipientAddress, '');
    assert.throws(() => validateDeploymentOwner(p));
  }
  assert.throws(() => validateDeploymentProfile({ ...fixture(), status: 'simulated' }), /not deployed/);
  assert.equal(validateDeploymentProfile({ ...fixture(), status: 'simulated' }, { allowSimulation: true }).verified, false);
});
test('owner and platform validation rejects empty, zero, malformed and compromised addresses', () => {
  for (const bad of ['', zeroAddress, '0x1234', '0xc286b1956c7691d678520e370727d8ab57328556']) {
    assert.throws(() => validateDeploymentOwner({ chainId: 4663, ownerAddress: bad, platformRecipientAddress: platform }));
    assert.throws(() => validateDeploymentOwner({ chainId: 4663, ownerAddress: owner, platformRecipientAddress: bad }));
  }
  assert.throws(() => validateDeploymentOwner({ chainId: 1, ownerAddress: owner, platformRecipientAddress: platform }));
  assert.equal(validateDeploymentOwner({ chainId: 4663, ownerAddress: owner, platformRecipientAddress: platform }).ownerAddress, owner);
});
test('manifest binds addresses, code size, hook permissions and fee policy', () => {
  for (const mutate of [
    p => p.hashes.launcher.address = platform, p => p.hashes.launcher.codeHash = '0x00',
    p => p.hashes.launcher.codeBytes = 0, p => p.deployment.feeHook = owner,
    p => p.platformVolumeBps = 30, p => p.maxFeeBps = 3000, p => p.chainId = 1,
  ]) { const p = fixture(); mutate(p); assert.throws(() => validateDeploymentProfile(p)); }
  const p = validateDeploymentProfile({ ...fixture(), capabilities: { strictWalletCap: true } });
  assert.equal(p.capabilities.strictWalletCap, false);
  assert.throws(() => deploymentCapabilities('made-up-engine'));
});
test('verification checks every code hash and immutable relationship at one block', async () => {
  const p = fixture();
  const verified = await verifyDeploymentProfile(p, { client: mock(p) });
  assert.equal(verified.verified, true); assert.equal(verified.verifiedBlock, '1234');
  await assert.rejects(verifyDeploymentProfile(p, { client: mock(p, { getCode: async () => '0x' }) }), /code mismatch/);
  await assert.rejects(verifyDeploymentProfile(p, { client: mock(p, { getChainId: async () => 1 }) }), /chain mismatch/);
  for (const getter of ['poolManager', 'feeHook', 'pairRegistry', 'tokenImplementation', 'launcher', 'platformRecipient', 'owner', 'pendingOwner', 'referralVault', 'rewardConverter']) {
    const original = mock(p);
    await assert.rejects(verifyDeploymentProfile(p, { client: mock(p, { readContract: args => args.functionName === getter ? Promise.resolve('0x3333333333333333333333333333333333333333') : original.readContract(args) }) }));
  }
});
test('unsigned pair approval binds actual registry owner, decimals and address', async () => {
  const p = fixture(), address = '0x4444444444444444444444444444444444444444';
  const result = await preparePairApprovals(p, { client: mock(p), pairs: [{ address, decimals: 6 }] });
  const tx = result.pairs[0].setupTransaction;
  assert.equal(tx.from, owner); assert.equal(tx.to, getAddress(p.deployment.pairRegistry));
  const decoded = decodeFunctionData({ abi: parseAbi(['function approvePairWithoutOracle(address,uint8)']), data: tx.data });
  assert.deepEqual(decoded.args, [address, 6]);
  await assert.rejects(preparePairApprovals(p, { client: mock(p), pairs: [{ address, decimals: 18 }] }), /decimals mismatch/);
  await assert.rejects(preparePairApprovals(p, { client: mock(p), pairs: [{ address, decimals: 6 }, { address, decimals: 6 }] }), /Duplicate quote/);
  const original = mock(p);
  const approved = mock(p, { readContract: args => args.functionName === 'pairConfig' ? Promise.resolve({ approved: true, tokenDecimals: 6 }) : args.functionName === 'isApproved' ? Promise.resolve(true) : original.readContract(args) });
  assert.equal((await preparePairApprovals(p, { client: approved, pairs: [{ address, decimals: 6 }] })).pairs[0].setupTransaction, null);
  const denied = { ...approved, readContract: args => args.functionName === 'isDenied' ? Promise.resolve(true) : approved.readContract(args) };
  await assert.rejects(preparePairApprovals(p, { client: denied, pairs: [{ address, decimals: 6 }] }), /explicitly denied/);
});
test('CLI rejects broadcast, private keys and unknown switches before RPC', async () => {
  for (const flag of ['--broadcast', '--private-key', '--account', '--unknown']) await assert.rejects(main(['simulate', flag, 'value']), /never broadcasts/);
});
test('manifest cannot grant itself legacy verification exceptions', async () => {
  const p = fixture();
  assert.throws(() => validateDeploymentProfile({ ...p, independent: false }), /Legacy exceptions/);
  await assert.rejects(verifyDeploymentProfile({ ...p, independent: false }, { client: mock(p) }), /Legacy exceptions/);
  const baseline = await loadDeploymentProfile();
  await assert.rejects(verifyDeploymentProfile({ ...baseline }, { client: mock() }), /Legacy exceptions/);
});
test('deployment provenance survives validation and promotion', () => {
  const input = { ...fixture(), deployerAddress: owner, startingNonce: 42, hookSalt: '0x' + 'ab'.repeat(32) };
  for (const [role, offset] of Object.entries({ pairRegistry: 0, tokenImplementation: 1, launcher: 3, tradeRouter: 4 })) {
    input.deployment[role] = getContractAddress({ from: owner, nonce: 42n + BigInt(offset) });
    input.hashes[role].address = input.deployment[role];
  }
  const p = validateDeploymentProfile(input);
  assert.equal(p.deployerAddress, owner); assert.equal(p.startingNonce, 42); assert.equal(p.hookSalt, input.hookSalt);
  assert.throws(() => validateDeploymentProfile({ ...input, startingNonce: -1 }));
  assert.throws(() => validateDeploymentProfile({ ...input, hookSalt: '0x00' }));
  assert.throws(() => validateDeploymentProfile({ ...input, startingNonce: 43 }), /CREATE provenance mismatch/);
});
test('advanced capabilities require separate factory, registry and satellite verification', async () => {
  const p = fixture(); p.engine = 'plugged-advanced-v1';
  Object.assign(p.deployment, { factory: p.deployment.launcher,
    launchRegistry: '0x0000000000000000000000000000000000000015', satellites: '0x0000000000000000000000000000000000000016' });
  for (const role of ['factory', 'launchRegistry', 'satellites']) p.hashes[role] = { address: p.deployment[role], codeHash: keccak256(code), codeBytes: 5 };
  const verified = await verifyDeploymentProfile(p, { client: mock(p) });
  assert.equal(verified.capabilities.strictWalletCap, true);
  assert.equal(verified.capabilities.atomicDuplicateRejection, true);
  assert.equal(verified.capabilities.launchAbi, 'plugged-advanced-v1');
  for (const getter of ['registry', 'deployer', 'FACTORY']) {
    const original = mock(p);
    await assert.rejects(verifyDeploymentProfile(p, { client: mock(p, {
      readContract: args => args.functionName === getter ? Promise.resolve(owner) : original.readContract(args),
    }) }), /Advanced immutable link mismatch/);
  }
  const incomplete = structuredClone(p); delete incomplete.hashes.satellites;
  assert.throws(() => validateDeploymentProfile(incomplete), /code manifest/);
  const original = mock(p);
  await assert.rejects(verifyDeploymentProfile(p, { client: mock(p, {
    readContract: args => args.functionName === 'MAX_WALLET_BPS' ? Promise.resolve(1000) : original.readContract(args),
  }) }), /strict wallet policy mismatch/);
});
test('full-catalog approval preparation preserves every quote and decimal assignment', async () => {
  const p = fixture();
  const pairs = Array.from({ length: 469 }, (_, i) => ({ address: getAddress('0x' + (0x100000n + BigInt(i)).toString(16).padStart(40, '0')),
    decimals: [6, 8, 18][i % 3] }));
  const decimalsByAddress = new Map(pairs.map(pair => [pair.address.toLowerCase(), pair.decimals]));
  const original = mock(p);
  const client = mock(p, { readContract: args => args.functionName === 'decimals' ?
    Promise.resolve(decimalsByAddress.get(args.address.toLowerCase())) : original.readContract(args) });
  const report = await preparePairApprovals(p, { client, pairs });
  assert.equal(report.pairs.length, 469);
  assert.deepEqual(report.pairs.map(({ address, decimals }) => ({ address, decimals })), pairs);
  const abi = parseAbi(['function approvePairWithoutOracle(address,uint8)']);
  for (const pair of report.pairs) {
    assert.deepEqual(decodeFunctionData({ abi, data: pair.setupTransaction.data }).args, [pair.address, pair.decimals]);
    assert.equal(pair.setupTransaction.from, owner);
  }
});
