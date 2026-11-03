import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight, publicOrigin } from '../tools/operations-preflight.mjs';
import { checkHealth } from '../tools/operations-health.mjs';
import { cleanInstall, releasePath } from '../tools/operations-clean-install.mjs';
import { sha256 } from '../tools/operations-sqlite.mjs';

function releaseFixture() {
  const temporary = join(tmpdir(), 'opencode'); mkdirSync(temporary, { recursive: true });
  const dir = mkdtempSync(join(temporary, 'plugged-ops-release-')), source = join(dir, 'release'); mkdirSync(source);
  const required = preflight({ directory: source }).checks.filter(c => c.name.startsWith('file:')).map(c => c.name.slice(5));
  const files = [...required, 'deployment-owner.example.json', 'bun.lock', 'build.mjs', 'test/smoke.test.mjs', 'fixture-dependency/package.json', 'fixture-dependency/index.js'];
  for (const file of files) {
    const path = join(source, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '// fixture\n');
  }
  writeFileSync(join(source, 'deployment-owner.example.json'), JSON.stringify({ ownerAddress: '', platformRecipientAddress: '' }));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'operations-clean-install-fixture', type: 'module', scripts: { build: 'bun build.mjs' }, dependencies: { 'operations-local-fixture': 'file:./fixture-dependency' } }));
  writeFileSync(join(source, 'fixture-dependency/package.json'), JSON.stringify({ name: 'operations-local-fixture', version: '1.0.0', main: 'index.js' }));
  rmSync(join(source, 'bun.lock'));
  const lock = Bun.spawnSync([process.execPath, '--no-env-file', 'install', '--lockfile-only', '--ignore-scripts'], { cwd: source, stdout: 'pipe', stderr: 'pipe' });
  if (lock.exitCode !== 0) throw new Error('Unable to generate empty fixture lockfile: ' + lock.stderr.toString());
  writeFileSync(join(source, 'build.mjs'), "await Bun.write('build-ran.txt', 'ok');");
  writeFileSync(join(source, 'test/smoke.test.mjs'), "import {test,expect} from 'bun:test'; test('isolated clean install',()=>expect(process.env.PLUGGED_PRIVATE_KEY).toBeUndefined());");
  return { dir, source, files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('preflight is fail-closed for missing release, placeholder domain, private runtime, signer and mutable DB location', () => {
  const f = releaseFixture();
  try {
    const env = { NODE_ENV: 'production', PORT: '4317', PLUGGED_PUBLIC_ORIGIN: 'https://plugged.operator-domain.com',
      PLUGGED_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com', PLUGGED_LAUNCH_ENABLED: 'false', PLUGGED_DB_PATH: join(f.dir, 'launches.sqlite') };
    expect(preflight({ directory: f.source, mode: 'production', env }).ok).toBe(true);
    for (const changed of [{ PLUGGED_PUBLIC_ORIGIN: 'https://plugged.example.invalid' }, { PLUGGED_DB_PATH: join(f.source, 'launches.sqlite') },
      { PORT: '8080' }, { NODE_ENV: 'development' }, { PLUGGED_RPC_URL: '' }, { PLUGGED_PRIVATE_KEY: 'never-log-this' }]) {
      const result = preflight({ directory: f.source, mode: 'production', env: { ...env, ...changed } });
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('never-log-this');
    }
    writeFileSync(join(f.source, '.env'), 'private'); expect(preflight({ directory: f.source }).ok).toBe(false);
    rmSync(join(f.source, '.env')); rmSync(join(f.source, 'server.bundle.js')); expect(preflight({ directory: f.source }).ok).toBe(false);
  } finally { f.cleanup(); }
});
test('public origins reject credentials, paths, IPs and example domains', () => {
  for (const value of ['http://production.com', 'https://' + 'user:secret@production.com', 'https://production.com/app',
    'https://production.com?x=1', 'https://localhost', 'https://127.0.0.1', 'https://example.com', 'https://foo.test']) expect(publicOrigin(value)).toBeNull();
  expect(publicOrigin('https://plugged.operator-domain.com')).toBe('https://plugged.operator-domain.com');
});
test('health distinguishes process availability from catalog readiness and rejects bad responses', async () => {
  const fetcher = async url => Response.json(url.pathname === '/api/config' ? { network: { id: 4663 } } : { chainId: 4663, ready: false, blockers: ['PAIR_REGISTRY_OWNER_APPROVALS'] });
  const result = await checkHealth({ url: 'http://127.0.0.1:4317', fetcher });
  expect(result.ok).toBe(true); expect(result.live).toBe(true); expect(result.ready).toBe(false);
  expect((await checkHealth({ url: 'http://127.0.0.1:4317', fetcher, requireReady: true })).ok).toBe(false);
  for (const response of [new Response('bad'), Response.json({}, { status: 503 }), Response.json({ network: { id: 1 }, chainId: 1, ready: true })]) {
    expect((await checkHealth({ url: 'http://127.0.0.1:4317', fetcher: async () => response.clone() })).ok).toBe(false);
  }
  expect((await checkHealth({ url: 'http://127.0.0.1:4317', fetcher: async () => { throw new Error('private upstream token'); } })).ok).toBe(false);
  await expect(checkHealth({ url: 'http://remote-host.com' })).rejects.toThrow();
});
test('package allowlist rejects traversal, credentials and runtime database files', () => {
  for (const path of ['../secret', 'a/../secret', '/etc/passwd', 'C:/secret', 'a\\secret', 'a//b', '.env', '.env.production',
    'runtime/deployment-owner.json', 'backups/manifest.json', 'credentials.key', 'db.sqlite-wal', 'secrets.env', 'node_modules/a.js']) expect(() => releasePath(path)).toThrow();
  for (const path of ['ops/secrets.env.example', '.env.example', 'lib/launch-store.mjs', 'bun.lock']) expect(releasePath(path)).toBe(path);
});
test('clean install runs frozen install, tests and build in new isolated directory; refuses tampering and reuse', async () => {
  const f = releaseFixture();
  try {
    const files = [];
    for (const path of f.files) files.push({ path, bytes: readFileSync(join(f.source, path)).length, sha256: await sha256(join(f.source, path)) });
    writeFileSync(join(f.source, 'PACKAGE-MANIFEST.json'), JSON.stringify({ files }));
    const work = join(f.dir, 'clean');
    const result = await cleanInstall({ source: f.source, work });
    expect(result).toMatchObject({ ok: true, installed: true, tested: true, built: true, deployed: false });
    expect(readFileSync(join(work, 'build-ran.txt'), 'utf8')).toBe('ok');
    await expect(cleanInstall({ source: f.source, work })).rejects.toThrow();
    writeFileSync(join(f.source, 'server.bundle.js'), 'tampered');
    const rejected = join(f.dir, 'rejected'); await expect(cleanInstall({ source: f.source, work: rejected })).rejects.toThrow('manifest');
    expect(existsSync(rejected)).toBe(false);
  } finally { f.cleanup(); }
});
