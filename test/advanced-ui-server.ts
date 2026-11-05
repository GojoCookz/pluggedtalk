// Browser-test server for the Advanced area. Real createPlatformServer, ActivityService and
// CalloutService; only the Robinhood RPC is replaced by a deterministic in-memory chain so the
// screens have swaps, holders and callouts to show. Not a production server. Nothing is broadcast.
import { verifyMessage } from '../../app/node_modules/viem/_esm/index.js';
import { createPlatformServer } from '../server.ts';
import { LaunchStore } from '../lib/launch-store.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { CARBON_DEFAULT as engine } from '../lib/carbon-abi.mjs';
import { QUOTES } from '../lib/config.mjs';

const quote = QUOTES.find(q => q.symbol === 'USDG') ?? QUOTES.find(q => !q.native);
const Q96 = 2n ** 96n, HEAD = 5_000_000n;
export const uiCreator = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'; // address of private key 0x11…11
const coins = [
  { token: '0x0000000000000000000000000000000000000a11', name: 'BROWSER TEST Alpha', symbol: 'ALPHA', poolId: '0x' + 'a1'.repeat(32), block: 4_000_000n },
  { token: '0x0000000000000000000000000000000000000b22', name: 'BROWSER TEST Beta', symbol: 'BETA', poolId: '0x' + 'b2'.repeat(32), block: 4_600_000n },
];
const swaps = [], transfers = [];
for (const [c, n] of [[coins[0], 40], [coins[1], 12]]) {
  let sqrt = Q96 / 200_000_000n; // about 0.00002 quote per token
  for (let i = 0; i < n; i++) {
    const buy = i % 3 !== 2, block = c.block + BigInt(i) * 20_000n + 10n, trader = '0x' + String(1 + (i % 7)).repeat(40).slice(0, 40);
    sqrt = buy ? sqrt * 1015n / 1000n : sqrt * 992n / 1000n;
    const amount = BigInt(1000 + i * 37) * 10n ** 18n * 1000n, q = BigInt(5 + i) * 10n ** BigInt(quote.decimals) / 10n;
    swaps.push({ blockNumber: block, transactionHash: '0x' + (c.symbol === 'ALPHA' ? 'a' : 'b') + i.toString(16).padStart(63, '0'), logIndex: 0, trader,
      args: { id: c.poolId, sender: engine.tradeRouter, amount0: buy ? amount : -amount, amount1: buy ? -q : q, sqrtPriceX96: sqrt, liquidity: 1n, tick: 0, fee: 0 } });
    transfers.push({ token: c.token, blockNumber: block, args: buy ? { from: engine.poolManager, to: trader, value: amount } : { from: trader, to: engine.poolManager, value: amount / 4n } });
  }
  transfers.unshift({ token: c.token, blockNumber: c.block, args: { from: '0x0000000000000000000000000000000000000000', to: engine.poolManager, value: 97n * 10n ** 25n } },
    { token: c.token, blockNumber: c.block, args: { from: engine.poolManager, to: uiCreator, value: 3n * 10n ** 25n } });
}
const client = {
  getChainId: async () => 4663,
  getBlockNumber: async () => HEAD,
  getBlock: async ({ blockNumber }: any) => ({ number: blockNumber, hash: '0x' + 'cd'.repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) - (HEAD - blockNumber) / 10n }),
  getTransaction: async ({ hash }: any) => ({ from: swaps.find(s => s.transactionHash === hash)?.trader ?? uiCreator }),
  getLogs: async ({ address, args, fromBlock, toBlock }: any) => {
    const inRange = (l: any) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock;
    if (address.toLowerCase() === engine.poolManager.toLowerCase()) { const ids = [].concat(args.id).map((x: string) => x.toLowerCase()); return swaps.filter(l => inRange(l) && ids.includes(l.args.id)); }
    return transfers.filter(l => l.token === address.toLowerCase() && inRange(l));
  },
  readContract: async ({ address, args }: any) => transfers.filter(t => t.token === address.toLowerCase()).reduce((sum, t) => sum + (t.args.to.toLowerCase() === args[0].toLowerCase() ? t.args.value : 0n) - (t.args.from.toLowerCase() === args[0].toLowerCase() ? t.args.value : 0n), 0n),
};
const store = new LaunchStore(':memory:');
for (const c of coins) store.save({ id: crypto.randomUUID(), fingerprint: c.symbol, status: 'confirmed', createdAt: Number(c.block), txHash: '0x' + c.poolId.slice(2, 66), token: c.token, poolId: c.poolId,
  blockNumber: c.block.toString(), blockHash: '0x' + 'cd'.repeat(32), launchedAt: Math.floor(Date.now() / 1000) - Number((HEAD - c.block) / 10n),
  input: { account: uiCreator, name: c.name, symbol: c.symbol, quote: quote.address, feeBps: 200, creatorBps: 10000, maxWalletBps: 300 } });
const launchService = new LaunchService({ store, client, fetcher: async () => ({ ok: false }) as any });
const platform = createPlatformServer({ dbPath: ':memory:', launchService, verifyMessage, launchEnabled: false, calloutMode: process.env.PLUGGED_CALLOUTS || 'open' });
platform.server.listen(Number(process.env.PORT || 4331), '127.0.0.1', () => console.log(`Advanced UI test server on ${process.env.PORT || 4331} (simulated chain, real services).`));
const stop = () => platform.shutdown().then(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
