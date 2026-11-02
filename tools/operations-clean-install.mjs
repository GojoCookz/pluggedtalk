import { mkdirSync, copyFileSync, readFileSync, lstatSync, constants } from 'node:fs';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { argumentsFor, cli, regular, sha256 } from './operations-sqlite.mjs';
import { preflight } from './operations-preflight.mjs';

// Only the package manifest allowlist enters the clean directory. Never copy node_modules,
// runtime, credentials, local ownership choices or undeclared files from an operator's host.
export function releasePath(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes(':') ||
      name.split('/').some(part => !part || part === '.' || part === '..') ||
      /(^|\/)(node_modules|runtime|backups|\.git|\.ssh|keystores?)(\/|$)/i.test(name) ||
      /(^|\/)\.env(?!\.example$)/i.test(name) ||
      /(^|\/)(secrets\.env|service\.env|deployment-owner\.json)$|\.(sqlite(?:3)?|db|pem|key|p12|pfx)(?:-|$)/i.test(name)) {
    throw new Error('Package manifest contains an unsafe or private path.');
  }
  return name;
}
function noSymlinkPath(root, name) {
  let current = root;
  for (const part of name.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Package files must not traverse symlinks.');
  }
  regular(current); return current;
}
export async function cleanInstall({ source, work }) {
  if (!source || !work) throw new Error('Usage: bun tools/operations-clean-install.mjs --source EXTRACTED_RELEASE --work NEW_SCRATCH_DIRECTORY');
  if (Bun.version !== '1.3.9') throw new Error('Use pinned Bun 1.3.9.');
  source = resolve(source); work = resolve(work);
  const rel = relative(source, work);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Scratch directory must be outside the source release.');
  regular(join(source, 'PACKAGE-MANIFEST.json'));
  const manifest = JSON.parse(readFileSync(join(source, 'PACKAGE-MANIFEST.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Package file manifest is missing.');
  const names = new Set();
  for (const file of manifest.files) {
    releasePath(file.path);
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate package path.'); names.add(key);
    const path = noSymlinkPath(source, file.path);
    if (!/^[0-9a-f]{64}$/.test(file.sha256) || file.bytes !== lstatSync(path).size || await sha256(path) !== file.sha256) {
      throw new Error('Package content does not match its manifest.');
    }
  }
  if (!names.has('bun.lock') && !names.has('bun.lockb')) throw new Error('A frozen Bun lockfile is required.');
  mkdirSync(work, { mode: 0o700 });
  for (const file of manifest.files) {
    const target = join(work, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(source, file.path), target, constants.COPYFILE_EXCL);
    if (await sha256(target) !== file.sha256) throw new Error('Copied package changed during verification.');
  }
  const before = preflight({ directory: work });
  if (!before.ok) throw new Error('Release preflight failed: ' + before.checks.filter(c => !c.ok).map(c => c.name).join(', '));
  // Allow host paths/cert stores/proxies but exclude application keys and signing secrets.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)));
  for (const args of [['install', '--frozen-lockfile', '--ignore-scripts'], ['test', 'test/'], ['run', 'build']]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', ...args], { cwd: work, env, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error(`Clean release command failed: bun ${args.join(' ')}`);
  }
  const result = preflight({ directory: work });
  if (!result.ok) throw new Error('Rebuilt release preflight failed.');
  return { ok: true, directory: work, copied: manifest.files.length, installed: true, tested: true, built: true, deployed: false };
}
if (import.meta.main) await cli(() => {
  const args = argumentsFor(process.argv.slice(2), ['--source', '--work']);
  return cleanInstall({ source: args['--source'], work: args['--work'] });
});
