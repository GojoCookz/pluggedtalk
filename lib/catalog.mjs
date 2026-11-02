import { isAddress } from '../../app/node_modules/viem/_esm/index.js';
export const STOCK_SOURCE = 'https://api.robinhood.com/rhj/assets';
export const LIFI_SOURCE = 'https://li.quest/v1/tokens?chains=4663';
export function stockAssets(response) {
  if (!Array.isArray(response?.assets) || !response.assets.length) throw new Error('Issuer catalog missing assets.');
  const assets = response.assets.flatMap(row => {
    if (!Array.isArray(row.deployments)) throw new Error('Issuer deployment schema changed.');
    return row.deployments.filter(d => d.chainId === 4663).map(d => {
      if (!isAddress(d.contractAddress, { strict: false }) || !Number.isInteger(row.tokenDecimals)
        || row.tokenDecimals < 0 || row.tokenDecimals > 18 || typeof row.tokenSymbol !== 'string' || typeof row.tokenName !== 'string') throw new Error('Invalid issuer asset.');
      return { address: d.contractAddress.toLowerCase(), symbol: row.tokenSymbol, name: row.tokenName,
        decimals: row.tokenDecimals, category: 'stock', issuerStatus: row.status ?? null, isin: row.isin ?? null,
        provenance: [STOCK_SOURCE], issuerListed: true, bridgeVerification: 'not-established' };
    });
  });
  if (!assets.length || new Set(assets.map(a => a.address)).size !== assets.length) throw new Error('Missing or duplicate issuer deployments.');
  return assets;
}
export function carbonQuotes(source) {
  const section = source.split('const ROBINHOOD_DEPLOYMENT: Deployment = {')[1]?.split('const PENDING_DEPLOYMENT')[0];
  if (!section) throw new Error('Carbon Robinhood deployment section missing.');
  const rows = section.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
  return [...rows.matchAll(/\{ symbol: '([^']+)', name: '([^']+)', address: '(0x[\da-fA-F]{40})', decimals: (\d+)[^\n]*?\}/g)].map(m => ({
    symbol: m[1], name: m[2], address: m[3].toLowerCase(), decimals: Number(m[4]),
    category: m[0].includes('equity: true') ? 'stock-reference' : 'quote-reference',
    provenance: ['app/src/lib/networks.ts:ROBINHOOD_DEPLOYMENT'], carbonReferenced: true,
    issuerListed: false, bridgeVerification: 'not-established',
  }));
}
export function indexedPools(rows, known) {
  if (!Array.isArray(rows)) throw new Error('Pool provider schema changed.');
  return rows.filter(p => p?.chainId === 'robinhood' && /^0x[\da-fA-F]{40}([\da-fA-F]{24})?$/.test(p.pairAddress)
    && isAddress(p.baseToken?.address ?? '', { strict: false }) && isAddress(p.quoteToken?.address ?? '', { strict: false })
    && (known.has(p.baseToken.address.toLowerCase()) || known.has(p.quoteToken.address.toLowerCase())))
    .map(p => ({ id: p.pairAddress.toLowerCase(), dex: String(p.dexId ?? ''),
      base: p.baseToken.address.toLowerCase(), quote: p.quoteToken.address.toLowerCase(),
      source: `https://dexscreener.com/robinhood/${p.pairAddress.toLowerCase()}`,
      liquidityUsd: typeof p.liquidity?.usd === 'number' && Number.isFinite(p.liquidity.usd) && p.liquidity.usd >= 0 ? p.liquidity.usd : null }));
}
