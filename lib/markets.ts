import { NETWORK } from './config.mjs';
const integer = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function selectDexPair(pairs: any[], token: string) {
  return pairs.filter(p => p?.chainId === 'robinhood' && p?.baseToken?.address?.toLowerCase() === token.toLowerCase()
    && /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(p.pairAddress || ''))
    .sort((a, b) => (integer(b.liquidity?.usd) ?? 0) - (integer(a.liquidity?.usd) ?? 0))[0] ?? null;
}

export async function markets() {
  // An undeployed market is not an RPC outage or a reason to borrow another pad's tokens.
  return { tokens: [], warnings: [], total: '0', sampled: 0, blockNumber: null,
    observedAt: new Date().toISOString(), source: 'plugged', chainId: NETWORK.id, status: 'not-deployed' };
}
