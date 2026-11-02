import { accessSync, constants, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, cli, exists } from './operations-sqlite.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
function within(parent, child) {
  const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !url.hostname.includes('.') || /(^|\.)(localhost|invalid|test|example|local)$/.test(url.hostname) ||
        /(^|\.)example\.(com|net|org)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return url.origin;
  } catch { return null; }
}
export function preflight({ directory = root, env = process.env, mode = 'release' } = {}) {
  if (!['release', 'production'].includes(mode)) throw new Error('Mode must be release or production.');
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  directory = realpathSync(directory);
  check('bun-version', Bun.version === '1.3.9', 'Validated runtime is Bun 1.3.9; requalify before changing the pin.');
  for (const name of ['server.bundle.js', 'dist/index.html', 'dist/app.js', 'dist/style.css', 'dist/mark.svg', 'package.json',
    'tools/backup-sqlite.mjs', 'tools/restore-sqlite.mjs', 'tools/operations-sqlite.mjs',
    'tools/operations-preflight.mjs', 'tools/operations-health.mjs', 'tools/operations-backup-job.mjs',
    'tools/operations-clean-install.mjs', 'ops/plugged.service', 'ops/Caddyfile',
    'ops/plugged-backup.service', 'ops/plugged-backup.timer', 'ops/plugged-health.service', 'ops/plugged-health.timer']) {
    check(`file:${name}`, exists(join(directory, name)) && lstatSync(join(directory, name)).isFile() && lstatSync(join(directory, name)).size > 0, 'Required packaged release artifact.');
  }
  for (const name of ['.env', '.env.production', '.env.local', 'runtime']) {
    check(`excluded:${name}`, !exists(join(directory, name)), 'Runtime/private configuration must be outside the release.');
  }
  try {
    const template = JSON.parse(readFileSync(join(directory, 'deployment-owner.example.json'), 'utf8'));
    check('owner-neutral', template.ownerAddress === '' && template.platformRecipientAddress === '', 'Handoff ownership addresses must be blank.');
  } catch { check('owner-neutral', false, 'Missing or invalid owner template.'); }
  if (mode === 'production') {
    check('environment', env.NODE_ENV === 'production', 'NODE_ENV must be production.');
    check('port', String(env.PORT) === '4317', 'Service and reverse proxy require loopback port 4317.');
    check('public-origin', publicOrigin(env.PLUGGED_PUBLIC_ORIGIN), 'Configure a real HTTPS origin; no placeholder domain. This does not verify DNS or TLS.');
    let rpc;
    try { rpc = new URL(env.PLUGGED_RPC_URL); } catch {}
    check('rpc-configured', rpc?.protocol === 'https:' && !/(example|invalid|replace|your[_-])/i.test(rpc?.hostname ?? ''), 'Explicit HTTPS RPC is required; credentials are never printed. Chain ID is checked separately.');
    check('launch-flag', ['true', 'false'].includes(env.PLUGGED_LAUNCH_ENABLED), 'Explicit true or false required.');
    const dbPath = env.PLUGGED_DB_PATH;
    let persistent = false;
    if (dbPath && isAbsolute(dbPath)) {
      try {
        const parent = realpathSync(dirname(dbPath));
        persistent = !within(directory, parent) && (!exists(dbPath) || (lstatSync(dbPath).isFile() && !within(directory, realpathSync(dbPath))));
        accessSync(parent, constants.W_OK | constants.R_OK);
        if (exists(dbPath)) accessSync(dbPath, constants.W_OK | constants.R_OK);
      } catch { persistent = false; }
    }
    check('persistent-db', persistent, 'PLUGGED_DB_PATH must be absolute in an existing writable directory outside the release; no database symlink.');
    check('no-server-signer', !Object.keys(env).some(key => /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|KEYSTORE_PASSWORD)/i.test(key) && env[key]), 'Hosted service must not receive signing credentials.');
  }
  return { ok: checks.every(check => check.ok), mode, deployed: false, checks };
}
if (import.meta.main) await cli(() => {
  const args = argumentsFor(process.argv.slice(2), ['--root', '--mode']);
  const result = preflight({ directory: args['--root'] ?? root, mode: args['--mode'] ?? 'release' });
  if (!result.ok) process.exitCode = 1;
  return result;
});
