import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from '../../app/node_modules/viem/_esm/index.js';
import { CashbackIndexer, cashbackJson } from '../lib/cashback-index.mjs';
import { claimVoucherFromAttestation } from '../lib/cashback-provider.mjs';

export async function runCashbackTool(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === '--help' || !command) {
    return { usage: 'bun plugged/tools/cashback-index.mjs <index|scan|export|attest|verify> --config policy.json --db ledger.sqlite [--tx 0x...] [--trader 0x... --valid-until SECONDS] [--signer-module ./signer.mjs] [--voucher voucher.json] [--out export.json]',
      policy: 'RPC URL (rpcUrl), chainId, startBlock, program, currency, attestor, router, hook, poolManager, codeHashes for program/currency/router/hook/poolManager, explicit pools (currency0,currency1,fee,tickSpacing,hooks). Optional confirmations and maxValiditySeconds.',
      signer: 'Optional trusted local module exports signer (or default) with async signTypedData(typedData). No private-key flags; without a signer the output explicitly remains unsigned.',
      scope: 'Finalized direct TradeRouter ERC-20 buys only. Pins must be reviewed immutable implementations, not proxies. CLI never broadcasts transactions.' };
  }
  const allowed = new Set(['config', 'db', 'tx', 'trader', 'valid-until', 'signer-module', 'voucher', 'out', 'max-blocks']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicate or missing option');
    options[key] = args[i + 1];
  }
  if (!['index', 'scan', 'export', 'attest', 'verify'].includes(command)) throw new Error('Unknown cashback command');
  if (!options.config || !options.db) throw new Error('--config and --db are required');
  const config = JSON.parse(readFileSync(options.config, 'utf8'));
  if (!/^https?:\/\//.test(config.rpcUrl ?? '')) throw new Error('config.rpcUrl must be HTTP(S)');
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const indexer = new CashbackIndexer({ ...config, client, path: options.db });
  try {
    let result;
    if (command === 'index') result = await indexer.indexTransaction(options.tx);
    if (command === 'scan') result = await indexer.scan({ maxBlocks: options['max-blocks'] ? Number(options['max-blocks']) : 1000 });
    if (command === 'export' || command === 'attest') {
      let signer;
      if (command === 'attest' && options['signer-module']) {
        const module = await import(pathToFileURL(resolve(options['signer-module'])).href);
        signer = module.signer ?? module.default;
        if (!signer) throw new Error('Signer module did not export signer');
      }
      result = await indexer.attest({ trader: options.trader, validUntil: options['valid-until'], signer });
      if (result.status === 'signed') result.claimVoucher = claimVoucherFromAttestation(result);
    }
    if (command === 'verify') result = await indexer.verifyVoucher(JSON.parse(readFileSync(options.voucher, 'utf8')));
    if (options.out) writeFileSync(options.out, cashbackJson(result) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } finally { indexer.close(); }
}

if (import.meta.main) {
  try { console.log(cashbackJson(await runCashbackTool())); }
  catch (error) { console.error(`Cashback: ${error.message}`); process.exitCode = 1; }
}
