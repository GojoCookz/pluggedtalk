import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createPublicClient, http, erc20Abi, parseAbi, isAddress } from '../../app/node_modules/viem/_esm/index.js';
import { STOCK_SOURCE, LIFI_SOURCE, stockAssets, carbonQuotes, indexedPools } from '../lib/catalog.mjs';

// Read-only whole-issuer snapshot and provider pool index, never a launch-list importer.
const root = new URL('../', import.meta.url);
const json = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${r.status}: ${url}`); return r.json(); };
const assets = new Map(), warnings = [];
const merge = row => {
  const previous = assets.get(row.address);
  assets.set(row.address, previous ? { ...row, ...previous, carbonReferenced: !!(row.carbonReferenced || previous.carbonReferenced),
    provenance: [...new Set([...previous.provenance, ...row.provenance])] } : row);
};
const issuer = stockAssets(await json(STOCK_SOURCE)); issuer.forEach(merge);
const references = carbonQuotes(await readFile(new URL('../app/src/lib/networks.ts', root), 'utf8'));
if (!references.length) throw new Error('Carbon quote references empty.'); references.forEach(merge);
let lifiCount = 0;
try {
  const data = await json(LIFI_SOURCE);
  if (!Array.isArray(data.tokens?.[4663])) throw new Error('LI.FI catalog missing chain 4663.');
  for (const row of data.tokens[4663]) {
    if (!isAddress(row.address ?? '', { strict: false }) || /^0x0{40}$/i.test(row.address)) continue;
    if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) continue;
    lifiCount++;
    merge({ address: row.address.toLowerCase(), name: String(row.name ?? ''), symbol: String(row.symbol ?? ''), decimals: row.decimals,
      category: 'bridge-candidate', issuerListed: false, bridgeVerification: 'not-established', provenance: [LIFI_SOURCE] });
  }
} catch (e) { warnings.push(`LI.FI: ${e.message}`); }

const client = createPublicClient({ transport: http(process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', { timeout: 10000, retryCount: 0, batch: { batchSize: 50, wait: 20 } }) });
if (await client.getChainId() !== 4663) throw new Error('Wrong RPC chain.');
const block = await client.getBlock({ blockTag: 'latest' });
const registryAbi = parseAbi(['function isApproved(address) view returns (bool)']);
const list = [...assets.values()];
// Bounded requests; failed RPC reads stay unknown rather than turning into false assertions.
let cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < list.length) {
    const row = list[cursor++];
    const [code, decimals, approved] = await Promise.allSettled([
      client.getCode({ address: row.address, blockTag: 'latest' }),
      client.readContract({ address: row.address, abi: erc20Abi, functionName: 'decimals', blockTag: 'latest' }),
      client.readContract({ address: '0xDFf0A6FfD11Eb1494E8A57DD5eF92b23122BaeC0', abi: registryAbi, functionName: 'isApproved', args: [row.address], blockTag: 'latest' }),
    ]);
    row.codeVerified = code.status === 'fulfilled' ? !!code.value && code.value !== '0x' : null;
    row.decimalsVerified = decimals.status === 'fulfilled' ? decimals.value === row.decimals : null;
    row.carbonApproved = approved.status === 'fulfilled' ? approved.value : null;
    row.verificationError = [code, decimals, approved].find(r => r.status === 'rejected')?.reason?.shortMessage ?? null;
  }
}));
const pools = new Map(); let checked = 0;
for (let offset = 0; offset < list.length; offset += 30) {
  const batch = list.slice(offset, offset + 30).map(row => row.address);
  try {
    const rows = await json(`https://api.dexscreener.com/tokens/v1/robinhood/${batch.join(',')}`);
    indexedPools(rows, new Set(batch)).forEach(p => pools.set(p.id, p)); checked += batch.length;
  } catch (e) { warnings.push(`Pool batch ${offset}: ${e.message}`); }
  await Bun.sleep(300);
}
const unknown = list.filter(row => row.codeVerified === null || row.decimalsVerified === null || row.carbonApproved === null).length;
if (unknown) warnings.push(`${unknown} assets have incomplete RPC verification; inspect verificationError.`);
const result = { chainId: 4663, indexedAt: new Date().toISOString(), blockNumber: block.number.toString(),
  verification: { mode: 'latest state observations, not an atomic or finalized snapshot', fromBlock: block.number.toString(), throughBlock: (await client.getBlockNumber()).toString() },
  sources: { issuer: STOCK_SOURCE, bridgeCandidates: LIFI_SOURCE, carbon: 'app/src/lib/networks.ts:ROBINHOOD_DEPLOYMENT',
    wormhole: 'https://wormhole.com/docs/reference/contract-addresses/' },
  coverage: { issuerAssets: issuer.length, carbonReferences: references.length, lifiAssets: lifiCount, poolAssetsChecked: checked,
    poolCoverage: 'provider-reported; not all factory events', wormholeComplete: false, wormholeVerified: 0,
    wormholeReason: 'Official Core is documented, but an authoritative Robinhood Token Bridge asset enumeration was not established. LI.FI and Carbon references do not prove Wormhole backing.' },
  warnings, assets: list, pools: [...pools.values()] };
await mkdir(new URL('data/', root), { recursive: true });
await writeFile(new URL('data/assets.next.json', root), JSON.stringify(result, null, 2));
await rename(new URL('data/assets.next.json', root), new URL('data/assets.json', root));
await writeFile(new URL('data/quotes.json', root), JSON.stringify(list.filter(a => a.codeVerified === true && a.decimalsVerified === true)
  .map(({ address, symbol, name, decimals, category, issuerListed }) => ({ address, symbol, name, decimals, category, issuerListed })), null, 2));
console.log(JSON.stringify({ ...result.coverage, assets: list.length, pools: pools.size, verifiedCode: list.filter(a => a.codeVerified).length, unknownCode: list.filter(a => a.codeVerified === null).length, blockNumber: result.blockNumber, warnings }, null, 2));
