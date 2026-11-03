import { afterEach, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pngjs from '../../app/node_modules/pngjs/lib/png.js';
import { encodeAbiParameters, encodeEventTopics, keccak256, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { digestToCids } from '../../app/src/lib/cid.ts';
import { createPlatformServer } from '../server.ts';
import { LaunchStore } from '../lib/launch-store.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { MediaService } from '../lib/media-service.mjs';
import { CAMPAIGN_ABI } from '../lib/program-service-abi.mjs';

const platforms = [], directories = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.shutdown();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function serve(options = {}) {
  const platform = createPlatformServer({ dbPath: ':memory:', launchEnabled: false, programsEnabled: false, ...options });
  platforms.push(platform);
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  return { ...platform, base,
    get: path => fetch(base + path),
    post: (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}
const account = '0x1111111111111111111111111111111111111111';
const hash = digit => '0x' + digit.repeat(64);

test('all feature contracts dispatch only explicit methods with exact argument shapes', async () => {
  const seen = [];
  const methods = names => Object.fromEntries(names.map(name => [name, (...args) => { seen.push({ name, args }); return { method: name, args }; }]));
  const p = await serve({ launchEnabled: true, programsEnabled: true,
    tradingService: methods(['balances', 'quote', 'prepare', 'submit', 'status']),
    rewardsService: methods(['positions', 'prepare', 'submit']),
    programService: { ...methods(['list', 'details', 'prepare', 'submit', 'status', 'voucher']), close() {} } });
  for (const [group, names] of [['trading', ['balances', 'quote', 'prepare', 'submit', 'status']], ['rewards', ['positions', 'prepare', 'submit', 'status']]]) {
    for (const name of names) {
      const body = { account, id: 'opaque', preparation: { id: 'stored' } };
      const response = await p.post(`/api/${group}/${name}`, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: group === 'rewards' && name === 'status' ? 'submit' : name, args: [body] });
    }
  }
  for (const [path, body, args] of [
    ['prepare', { programId: 'campaign', account }, [{ programId: 'campaign', account }]],
    ['submit', { id: 'stored', txHash: hash('a') }, ['stored', hash('a')]],
    ['status', { id: 'stored' }, ['stored']], ['voucher', { programId: 'cashback', account }, [{ programId: 'cashback', account }]],
  ]) expect(await (await p.post('/api/programs/' + path, body)).json()).toEqual({ method: path, args });
  expect(await (await p.get(`/api/programs?account=${account}`)).json()).toEqual({ method: 'list', args: [{ account }] });
  expect(await (await p.get(`/api/programs/campaign?account=${account}`)).json()).toEqual({ method: 'details', args: ['campaign', { account }] });
  const before = seen.length;
  for (const group of ['trading', 'rewards']) for (const name of ['constructor', 'close', 'save', 'reconcile', '__proto__']) expect((await p.post(`/api/${group}/${name}`)).status).toBe(405);
  expect((await p.post('/api/programs/reconcile')).status).toBe(405);
  expect((await p.post('/api/programs/submit', { id: 'stored', txHash: hash('a'), calldata: '0x' })).status).toBe(422);
  expect(seen.length).toBe(before);
});

test('signing gates deny preparation before service calls, but all recovery endpoints remain accessible', async () => {
  let prepared = 0, recovered = 0;
  const service = { prepare() { prepared++; }, submit() { recovered++; return { status: 'submitted' }; }, status() { recovered++; return { status: 'submitted' }; } };
  const p = await serve({ tradingService: service, rewardsService: service, programService: { ...service, voucher() { prepared++; }, close() {} } });
  for (const path of ['launches/prepare', 'launches/funding', 'trading/prepare', 'rewards/prepare', 'programs/prepare', 'programs/voucher']) expect((await p.post('/api/' + path)).status).toBe(503);
  for (const group of ['trading', 'rewards', 'programs']) for (const method of ['submit', 'status']) expect((await p.post(`/api/${group}/${method}`, {})).status).toBe(200);
  expect(prepared).toBe(0); expect(recovered).toBe(6);
  // Launch recovery validates its durable ID rather than returning the signing gate.
  expect((await p.post('/api/launches/status', { id: '11111111-1111-1111-1111-111111111111' })).status).toBe(404);
  expect((await p.post('/api/launches/submit', { id: '11111111-1111-1111-1111-111111111111', txHash: hash('a') })).status).toBe(422);
});

test('program flag is independent of launch signing and cannot be enabled by an HTTP body', async () => {
  const p = await serve({ programsEnabled: true, programService: { prepare: () => ({ status: 'prepared' }), close() {} } });
  expect((await p.post('/api/programs/prepare')).status).toBe(200);
  expect((await p.post('/api/trading/prepare', { launchEnabled: true })).status).toBe(503);
});

test('actual services share the launch identity and durable file; availability never claims live readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugged-api-')); directories.push(dir);
  const p = await serve({ dbPath: join(dir, 'launches.sqlite'), mediaService: new MediaService({ provider: { available: false } }) });
  const launches = p.services.launches(), trading = p.services.trades(), rewards = p.services.earnings(), programs = p.services.programs();
  expect(trading.launchService).toBe(launches); expect(rewards.launchService).toBe(launches); expect(programs.launchService).toBe(launches);
  expect(trading.db).toBe(launches.store.db); expect(rewards.store.db).toBe(launches.store.db); expect(programs.store.db).toBe(launches.store.db);
  expect(launches.store.db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)).toContain('program_transactions');
  const listing = await (await p.get('/api/programs')).json(); expect(listing.status).toBe('undeployed'); expect(listing.programs).toEqual([]);
  expect((await p.get('/api/programs/missing')).status).toBe(404);
  const readiness = await (await p.get('/api/readiness')).json();
  expect(readiness.productionReady).toBe(false); expect(readiness.features.media.providerHealth).toBe('unverified'); expect(readiness.features.media.available).toBe(false);
  expect(readiness.features.programs.deploymentsConfigured).toBe(0); expect(readiness.availability.worker.lastCompletedAt).toBeNull();
  const health = await (await p.get('/api/health')).json(); expect(health.scope).toBe('process-liveness'); expect(health.ready).toBeUndefined();
});

test('real reward and trading services validate through HTTP with RPC isolated', async () => {
  let rpcCalls = 0;
  const store = new LaunchStore(':memory:');
  const client = { getChainId: async () => { rpcCalls++; return 4663; }, getBlockNumber: async () => 100n };
  const launches = new LaunchService({ store, client });
  launches.deployment = async () => {}; // Deployment verification is an injected external boundary here.
  const p = await serve({ launchService: launches });
  const result = await (await p.post('/api/rewards/positions', { account, chainId: 4663 })).json();
  expect(result.positions).toEqual([]); expect(result.social.oauthAvailable).toBe(false); expect(rpcCalls).toBe(1);
  expect((await p.post('/api/rewards/positions', { account, chainId: 1 })).status).toBe(422);
  expect((await p.post('/api/trading/quote', { account, token: account, side: 'buy', amount: '1', recipient: account })).status).toBe(422);
  expect((await p.post('/api/trading/balances', { account, token: account })).status).toBe(422);
  expect(rpcCalls).toBe(1);
});

test('real campaign HTTP flow verifies mocked chain, stores calldata, confirms exact receipt, recovers after gate disable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugged-campaign-api-')); directories.push(dir);
  const dbPath = join(dir, 'launches.sqlite'), code = '0x60006000', address = '0x3333333333333333333333333333333333333333';
  const timestamp = 1800000000n, beneficiary = '0x2222222222222222222222222222222222222222';
  const entry = { id: 'campaign', kind: 'campaign', chainId: 31337, localTest: true, address, codeHash: keccak256(code), deploymentBlock: '1', deploymentBlockHash: hash('1'), currency: zeroAddress, decimals: 18, beneficiary, goal: '2000000000000000000', deadline: String(timestamp + 3600n) };
  let tx, receipt;
  const client = {
    getChainId: async () => 31337, getCode: async () => code,
    getBlock: async ({ blockNumber = 100n } = {}) => ({ number: blockNumber, timestamp, hash: blockNumber === 1n ? hash('1') : hash('b') }),
    getBlockNumber: async () => 103n,
    readContract: async ({ functionName }) => ({ CURRENCY: zeroAddress, BENEFICIARY: beneficiary, GOAL: BigInt(entry.goal), DEADLINE: BigInt(entry.deadline), totalContributed: 0n, totalRefunded: 0n, paid: false, contributions: 0n })[functionName],
    simulateContract: async () => ({}), estimateGas: async () => 50000n,
    getTransaction: async () => tx, getTransactionReceipt: async () => receipt,
  };
  const make = enabled => serve({ dbPath, launchService: new LaunchService({ store: new LaunchStore(dbPath), client }), programManifest: [entry], programsEnabled: enabled });
  const p = await make(true);
  const response = await p.post('/api/programs/prepare', { programId: 'campaign', account, action: 'contribute', amount: '1' });
  expect(response.status).toBe(200); const prepared = await response.json();
  expect(prepared.transaction.from).toBe(account); expect(prepared.transaction.chainId).toBe('0x7a69');
  tx = { from: account, to: address, input: prepared.transaction.data, value: 10n ** 18n, chainId: 31337, blockNumber: 101n };
  receipt = { transactionHash: hash('c'), from: account, to: address, blockNumber: 101n, blockHash: hash('b'), status: 'success', logs: [{ address, topics: encodeEventTopics({ abi: CAMPAIGN_ABI, eventName: 'Contributed', args: { contributor: account } }), data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 18n]) }] };
  const confirmed = await (await p.post('/api/programs/submit', { id: prepared.id, txHash: hash('c') })).json(); expect(confirmed.status).toBe('confirmed');
  await p.shutdown();
  const restarted = await make(false);
  expect((await restarted.post('/api/programs/prepare', { programId: 'campaign', account, action: 'contribute', amount: '1' })).status).toBe(503);
  expect((await (await restarted.post('/api/programs/status', { id: prepared.id })).json()).status).toBe('confirmed');
});

function image() {
  const png = new pngjs.PNG({ width: 128, height: 128 });
  // Deterministic incompressible-ish fixture: body exceeds ordinary 32 KB boundary.
  let seed = 1; for (let i = 0; i < png.data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; png.data[i] = seed >>> 24; }
  return { filename: 'fixture.png', contentType: 'image/png', base64: pngjs.PNG.sync.write(png).toString('base64') };
}
test('media uses larger bounded JSON reader, actual PNG normalization and provider-confirmed CID', async () => {
  let calls = 0;
  const media = new MediaService({ provider: { available: true, pin: async ({ bytes, signal }) => { calls++; expect(signal.aborted).toBe(false); return { cid: digestToCids('0x' + createHash('sha256').update(bytes).digest('hex')).find(cid => cid.startsWith('bafkrei')) }; } } });
  const p = await serve({ mediaService: media }), input = image();
  expect(JSON.stringify(input).length).toBeGreaterThan(32000);
  const response = await p.post('/api/media/pin', input); expect(response.status).toBe(200);
  const result = await response.json(); expect(result.cid).toMatch(/^bafkrei/); expect(result.width).toBe(128); expect(result.filename).not.toBe('fixture.png'); expect(calls).toBe(1);
  expect((await p.post('/api/media/pin', { ...input, base64: 'x'.repeat(2800001) })).status).toBe(413); expect(calls).toBe(1);
  expect((await p.post('/api/trading/quote', input)).status).toBe(413);
});

test('media safe formatter never reflects provider secrets and disabled status is honest', async () => {
  const p = await serve({ mediaService: { status: () => ({ available: true }), pin: async () => { throw new Error('RAW_PRIVATE_PROVIDER_ERROR secret=should-not-escape'); } } });
  const response = await p.post('/api/media/pin', {}); expect(response.status).toBe(502);
  const result = await response.json(); expect(result.code).toBe('provider_failure'); expect(JSON.stringify(result)).not.toContain('RAW_PRIVATE');
  const unavailable = await serve({ mediaService: new MediaService({ provider: { available: false } }) });
  const denied = await unavailable.post('/api/media/pin'); expect(denied.status).toBe(503); expect((await denied.json()).code).toBe('unavailable');
});

test('media disconnect aborts provider work and drain waits until request cleanup', async () => {
  let started, aborted;
  const beginning = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const p = await serve({ mediaService: new MediaService({ provider: { available: true, pin: ({ signal }) => { started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true })); } } }) });
  const body = JSON.stringify(image());
  const socket = createConnection({ host: '127.0.0.1', port: p.server.address().port });
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /api/media/pin HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  await beginning; socket.destroy(); await cancelled; await p.shutdown();
});

test('configured public origin overrides Host and untrusted forwarding headers for every write API', async () => {
  let calls = 0;
  const p = await serve({ publicOrigin: 'https://platform.example', tradingService: { quote: () => { calls++; return {}; } } });
  for (const origin of ['null', p.base, 'https://evil.example', 'https://platform.example/path']) expect((await p.post('/api/trading/quote', {}, { origin, 'x-forwarded-host': 'evil.example' })).status).toBe(403);
  expect((await p.post('/api/trading/quote', {}, { origin: 'https://platform.example' })).status).toBe(200); expect(calls).toBe(1);
  for (const path of ['/api/plans/validate', '/api/routes/quote', '/api/media/pin', '/api/rewards/positions', '/api/programs/prepare']) expect((await p.post(path, {}, { origin: 'https://evil.example' })).status).toBe(403);
});

test('slow streamed body times out and streamed oversize is rejected before provider calls', async () => {
  let calls = 0;
  const p = await serve({ bodyTimeoutMs: 30, tradingService: { quote() { calls++; return {}; } } });
  const raw = body => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: p.server.address().port });
    socket.on('error', reject);
    socket.once('connect', () => socket.write('POST /api/trading/quote HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' + body));
    socket.once('data', data => { resolve(Number(data.toString().split(' ')[1])); socket.destroy(); });
  });
  expect(await raw('1\r\n{\r\n')).toBe(408);
  expect(await raw((32001).toString(16) + '\r\n' + 'x'.repeat(32001) + '\r\n0\r\n\r\n')).toBe(413); expect(calls).toBe(0);
});

test('bounded upload rate is checked before pinning and returns retry metadata', async () => {
  let calls = 0, clock = 0;
  const p = await serve({ now: () => clock, mediaService: { status: () => ({ available: true }), pin: () => { calls++; return {}; } } });
  for (let i = 0; i < 5; i++) expect((await p.post('/api/media/pin')).status).toBe(200);
  const denied = await p.post('/api/media/pin'); expect(denied.status).toBe(429); expect(denied.headers.get('retry-after')).toBe('60'); expect(calls).toBe(5);
  clock = 60000; expect((await p.post('/api/media/pin')).status).toBe(200);
  // Per-client daily cap (30) holds across minute windows.
  for (let minute = 2; calls < 30; minute++) { clock = minute * 60000; for (let i = 0; i < 5 && calls < 30; i++) expect((await p.post('/api/media/pin')).status).toBe(200); }
  clock += 60000; const daily = await p.post('/api/media/pin'); expect(daily.status).toBe(429); expect(Number(daily.headers.get('retry-after'))).toBeGreaterThan(60);
});

test('reconciliation never overlaps and shutdown waits for in-flight work before closing stores', async () => {
  let release, calls = 0, launchClosed = false, programClosed = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const p = await serve({ launchService: { confirm: async () => { calls++; await waiting; }, store: { list: () => [{}], close: () => { launchClosed = true; } } },
    programService: { store: { list: () => { expect(launchClosed).toBe(false); return []; } }, close: () => { programClosed = true; } } });
  const first = p.reconcile(), second = p.reconcile(); expect(first).toBe(second); expect(calls).toBe(1);
  const stopping = p.shutdown(); await Bun.sleep(10); expect(launchClosed).toBe(false); expect(programClosed).toBe(false);
  release(); await stopping; expect(launchClosed).toBe(true); expect(programClosed).toBe(true);
  await p.reconcile(); expect(calls).toBe(1);
});

test('failed reconciliation is caught and exposed as a failed cycle rather than live readiness', async () => {
  const p = await serve({ launchService: { confirm: async () => { throw new Error('upstream unavailable'); }, store: { list: () => [{}], close() {} } }, programService: { store: { list: () => [] }, close() {} } });
  await p.reconcile(); const result = await (await p.get('/api/readiness')).json();
  expect(result.availability.worker.running).toBe(false); expect(result.availability.worker.lastFailedAt).not.toBeNull();
  expect(result.availability.worker.lastCompletedAt).toBeNull(); expect(result.productionReady).toBe(false);
});

test('shutdown drains an accepted preparation before closing the shared store', async () => {
  let release, started, closed = false;
  const began = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const p = await serve({ launchEnabled: true, launchService: { store: { close: () => { closed = true; } } },
    tradingService: { prepare: async () => { started(); await pending; expect(closed).toBe(false); return { status: 'prepared' }; } } });
  const request = p.post('/api/trading/prepare'); await began;
  const stopped = p.shutdown(); expect(closed).toBe(false);
  release(); expect((await request).status).toBe(200); await stopped; expect(closed).toBe(true);
});
