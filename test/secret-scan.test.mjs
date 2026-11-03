import { test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, TEXT_FILE } from '../tools/secret-scan.mjs';

// Fixtures are assembled at runtime so this file never contains a literal secret pattern itself.
const hex = c => c.repeat(64);
const b64 = s => Buffer.from(s).toString('base64url');

test('L9: content scan flags private keys, JWTs, URL credentials and RPC keys without echoing them', () => {
  const key = hex('a');
  const jwt = [b64('{"alg":"HS256","typ":"JWT"}'), b64('{"sub":"merc-operator"}'), 'c2lnbmF0dXJlLXZhbHVlLXg'].join('.');
  const text = [
    `PLUGGED_PRIVATE_KEY=0x${key}`,
    `const privateKey = '${hex('b')}';`,
    `PINATA_JWT=${jwt}`,
    'PLUGGED_RPC_URL=https://' + 'operator:hunter2' + '@rpc.internal.net/v1',
    'https://eth-mainnet.g.alchemy.com/v2/' + 'AbCdEf0123456789XyZ_',
    '-----BEGIN ' + 'PRIVATE KEY-----',
  ].join('\n');
  const findings = scanText(text, '.env.sample');
  expect(findings.map(f => f.rule)).toEqual(['private-key', 'private-key', 'jwt', 'url-credentials', 'rpc-api-key', 'pem-private-key']);
  expect(findings.map(f => f.line)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(JSON.stringify(findings)).not.toContain(key);
});

test('L9: public Anvil keys, tx hashes, placeholders and code hashes are not findings', () => {
  const anvil = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const text = [
    `privateKey: '0x${anvil}'`,
    `txHash: '0x${hex('c')}'`,
    `codeHash = 0x${hex('d')}`,
    'https://user:pass@rpc.example.invalid',
    'https://eth-mainnet.g.alchemy.com/v2/<your-key>',
  ].join('\n');
  expect(scanText(text)).toEqual([]);
});

test('L9: the shipped source tree is clean', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const skip = /(^|\/)(node_modules|runtime|dist|out|cache|broadcast|artifacts|data|\.git)(\/|$)/;
  const findings = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (skip.test(name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (TEXT_FILE.test(name)) findings.push(...scanText(await readFile(path, 'utf8'), name));
    }
  }
  await walk(root);
  expect(findings).toEqual([]);
});
