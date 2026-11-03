import { afterEach, expect, test } from 'bun:test';
import { FEE_VAULT_ABI, FeeVaultService, feeVaultManifestFromEnv } from '../lib/fee-vault-service.mjs';
import { decodeFunctionData, keccak256, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { serverError, registerLocale } from '../web/i18n.js';
import es from '../web/locales/es.js';
registerLocale('es', es);
import { createPlatformServer } from '../server.ts';

const account = '0x1111111111111111111111111111111111111111';
const vault = '0x2222222222222222222222222222222222222222';
const manifest = { address: vault, codeHash: `0x${'ab'.repeat(32)}`, chainId: 4663 };
const platforms = [];
afterEach(async () => { for (const p of platforms.splice(0)) await p.shutdown(); });

async function serve(options = {}) {
  const platform = createPlatformServer({ dbPath: ':memory:', launchEnabled: false, programsEnabled: false, ...options });
  platforms.push(platform);
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  return { get: path => fetch(base + path), post: (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('undeployed vault is status-only and fails closed', async () => {
  const s = new FeeVaultService({ client: null, manifest: null });
  expect(s.status()).toMatchObject({ deployed: false, address: null, windows: { minDays: 7, defaultDays: 30, maxDays: 365 } });
  expect(await s.containers({ account, chainId: 4663 })).toMatchObject({ deployed: false, recipient: [], allocator: [] });
  await expect(s.prepare({ account, chainId: 4663, action: 'accept', id: '1' })).rejects.toMatchObject({ status: 503 });
  await expect(s.submit({ account, chainId: 4663, txHash: `0x${'1'.repeat(64)}` })).rejects.toMatchObject({ status: 503 });
});

test('manifest comes only from server configuration and is validated', () => {
  expect(feeVaultManifestFromEnv({})).toBeNull();
  expect(feeVaultManifestFromEnv({ PLUGGED_FEE_VAULT_ADDRESS: vault, PLUGGED_FEE_VAULT_CODEHASH: manifest.codeHash })).toEqual(manifest);
  expect(() => new FeeVaultService({ manifest: { ...manifest, codeHash: '0x12' } })).toThrow('Invalid fee vault manifest');
  expect(() => new FeeVaultService({ manifest: { ...manifest, chainId: 1 } })).toThrow('Invalid fee vault manifest');
});

test('code hash mismatch disables reads and actions', async () => {
  const client = { getBlockNumber: async () => 10n, getChainId: async () => 4663, getCode: async () => '0x6000', getBlock: async () => ({ timestamp: 1n }) };
  const s = new FeeVaultService({ client, manifest });
  await expect(s.containers({ account, chainId: 4663 })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('verification failed') });
  await expect(s.prepare({ account, chainId: 4663, action: 'claim', id: '1' })).rejects.toMatchObject({ status: 503 });
  const wrongChain = new FeeVaultService({ client: { ...client, getChainId: async () => 1 }, manifest });
  await expect(wrongChain.containers({ account, chainId: 4663 })).rejects.toMatchObject({ status: 503 });
});

test('input is an explicit allowlist', async () => {
  const s = new FeeVaultService({ client: {}, manifest });
  await expect(s.containers({ account, chainId: 4663, vault })).rejects.toThrow('Unsupported vault input: vault');
  await expect(s.containers({ account, chainId: 1 })).rejects.toThrow('Select chain 4663');
  await expect(s.containers({ account: '0x0000000000000000000000000000000000000000', chainId: 4663 })).rejects.toThrow('nonzero');
  await expect(s.prepare({ account, chainId: 4663, action: 'drain', id: '1' })).rejects.toThrow('Unknown vault action');
  await expect(s.prepare({ account, chainId: 4663, action: 'claim', id: '1', to: account })).rejects.toThrow('Unsupported vault input: to');
  await expect(s.prepare({ account, chainId: 4663, action: 'claim', id: '1', deadline: 5 })).rejects.toThrow('Only extend');
  await expect(s.submit({ account, chainId: 4663, txHash: 'nope' })).rejects.toThrow('transaction hash');
  await expect(s.submit({ account, chainId: 4663, txHash: `0x${'1'.repeat(64)}`, id: 'missing' })).rejects.toThrow('Preparation not found');
});

const runtime = '0x6000';
const token = '0x3333333333333333333333333333333333333333';
const payee = '0x4444444444444444444444444444444444444444';
const inbox = '0x5555555555555555555555555555555555555555';
function createClient(overrides = {}) {
  const calls = [];
  const client = {
    calls, getBlockNumber: async () => 10n, getChainId: async () => 4663, getBlock: async () => ({ timestamp: 1000n }),
    getCode: async ({ address: a }) => (a.toLowerCase() === vault || a.toLowerCase() === token ? runtime : '0x'),
    readContract: async ({ functionName }) => ({ containerCount: 4n, decimals: 6, predictInbox: inbox })[functionName],
    simulateContract: async call => { calls.push(call); return { result: [5n, inbox] }; },
    estimateContractGas: async () => 100000n, ...overrides,
  };
  return client;
}
const createManifest = { ...manifest, codeHash: keccak256(runtime) };
const createInput = (extra = {}) => ({ account, chainId: 4663, action: 'create', recipient: payee, currency: token, windowDays: 30, ...extra });

test('create validates recipient, currency, window and field set', async () => {
  const s = new FeeVaultService({ client: createClient(), manifest: createManifest });
  await expect(s.prepare(createInput({ recipient: account }))).rejects.toThrow('must differ from the creating wallet');
  await expect(s.prepare(createInput({ windowDays: 6 }))).rejects.toThrow('7 to 365');
  await expect(s.prepare(createInput({ windowDays: 366 }))).rejects.toThrow('7 to 365');
  await expect(s.prepare(createInput({ windowDays: 7.5 }))).rejects.toThrow('7 to 365');
  await expect(s.prepare(createInput({ currency: 'usdc' }))).rejects.toThrow('ETH or a token contract');
  await expect(s.prepare(createInput({ currency: '0x6666666666666666666666666666666666666666' }))).rejects.toThrow('ETH or a token contract');
  await expect(s.prepare(createInput({ id: '1' }))).rejects.toThrow('Unsupported vault input: id');
  await expect(s.prepare({ account, chainId: 4663, action: 'claim', id: '1', recipient: payee })).rejects.toThrow('Unsupported vault input: recipient');
  await expect(new FeeVaultService({ client: null, manifest: null }).prepare(createInput())).rejects.toMatchObject({ status: 503 });
});

test('create prepares a pinned simulation and predicts id and inbox', async () => {
  const client = createClient(), s = new FeeVaultService({ client, manifest: createManifest, symbols: { [token]: 'USDC' } });
  const prep = await s.prepare(createInput({ windowDays: 14 }));
  expect(prep).toMatchObject({ action: 'create', containerId: null, transaction: { from: account, to: vault, value: '0x0' },
    expected: { event: 'ContainerCreated', recipient: payee, currency: token, symbol: 'USDC', decimals: 6, windowDays: 14, predictedId: '5', predictedInbox: inbox } });
  expect(client.calls[0]).toMatchObject({ functionName: 'createContainer', blockNumber: 10n, args: [payee, token, 14n * 86400n, zeroAddress, `0x${'0'.repeat(64)}`, prep.expected.salt] });
  expect(prep.expected.salt).toMatch(/^0x[0-9a-f]{64}$/);
  const other = await s.prepare(createInput({ windowDays: 14 }));
  expect(other.expected.salt).not.toBe(prep.expected.salt);
  const decoded = decodeFunctionData({ abi: FEE_VAULT_ABI, data: prep.transaction.data });
  expect(decoded.functionName).toBe('createContainer');
  const shifted = new FeeVaultService({ client: createClient({ simulateContract: async () => ({ result: [7n, inbox] }) }), manifest: createManifest });
  await expect(shifted.prepare(createInput())).rejects.toThrow('vault prediction');
  const captured = new FeeVaultService({ client: createClient({ simulateContract: async () => ({ result: [5n, '0x' + '7'.repeat(40)] }) }), manifest: createManifest });
  await expect(captured.prepare(createInput())).rejects.toThrow('vault prediction');
  const reverting = new FeeVaultService({ client: createClient({ simulateContract: async () => { const e = new Error('reverted'); e.cause = { data: { errorName: 'InvalidRecipient' } }; throw e; } }), manifest: createManifest });
  await expect(reverting.prepare(createInput())).rejects.toThrow('Vault rejected create (InvalidRecipient).');
});

test('ES UI maps known server errors and keeps unknown text', () => {
  expect(serverError('Fee vault is not deployed or not configured on this server.', 'es')).toBe('La bóveda de comisiones no está desplegada ni configurada en este servidor.');
  expect(serverError('Recipient: enter a nonzero EVM address.', 'es')).toBe('Recipient: introduce una dirección EVM distinta de cero.');
  expect(serverError('Market 2: choose a configured ERC-20 quote. Native ETH is not a quote token.', 'es')).toContain('Mercado 2');
  expect(serverError('Vault signing is disabled by the operator.', 'es')).toBe('La firma (Vault) está desactivada por el operador.');
  expect(serverError('Fee vault is not deployed or not configured on this server.', 'en')).toBe('Fee vault is not deployed or not configured on this server.');
  expect(serverError('Something new.', 'es')).toBe('Something new.');
  expect(serverError(undefined, 'es')).toBe('');
});

test('HTTP routes expose honest undeployed state and gate preparation', async () => {
  const api = await serve();
  const status = await (await api.get('/api/vault/status')).json();
  expect(status).toMatchObject({ deployed: false, chainId: 4663 });
  const list = await api.post('/api/vault/containers', { account, chainId: 4663 });
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ deployed: false, recipient: [] });
  const prep = await api.post('/api/vault/prepare', { account, chainId: 4663, action: 'accept', id: '1' });
  expect(prep.status).toBe(503);
  const enabled = await serve({ launchEnabled: true });
  const prep2 = await enabled.post('/api/vault/prepare', { account, chainId: 4663, action: 'accept', id: '1' });
  expect(prep2.status).toBe(503);
  expect((await prep2.json()).error).toContain('not deployed');
  expect((await api.post('/api/vault/submit', { account, chainId: 4663, txHash: `0x${'1'.repeat(64)}` })).status).toBe(503);
  expect((await api.get('/api/vault/containers')).status).toBe(405);
});
