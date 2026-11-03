import { test, expect } from 'bun:test';
import { poolEthInUsdg, checkFundingOutput, checkEthUsd, ethReference, REFERENCE_POOL_ID, USDG, WETH } from '../lib/onchain-price.mjs';
import { usdValuation } from '../lib/market-services.mjs';
import { QUOTES } from '../lib/config.mjs';

const isqrt = n => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
// sqrtPriceX96 for `usdgPerEth` whole USDG per ETH (USDG 6 decimals, ETH 18).
const sqrtFor = usdgPerEth => isqrt(BigInt(usdgPerEth) * 10n ** 6n * (1n << 192n) / 10n ** 18n) + 1n;
const client = (usdgPerEth, liquidity = 10n ** 17n) => ({
  readContract: async ({ functionName, args }) => {
    expect(args[0]).toBe(REFERENCE_POOL_ID);
    return functionName === 'getSlot0' ? [sqrtFor(usdgPerEth), 0, 0, 500] : liquidity;
  },
});

test('M2: reference pool id is the hookless native ETH/USDG 0.05% pool measured on 4663', () => {
  expect(REFERENCE_POOL_ID).toBe('0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982');
});

test('M2: pool price converts to USDG units per ETH and refuses a thin pool', async () => {
  const perEth = await poolEthInUsdg(client(2000));
  expect(perEth >= 1999_999_000n && perEth <= 2000_001_000n).toBe(true);
  await expect(poolEthInUsdg(client(2000, 10n))).rejects.toThrow('unavailable');
  expect(await ethReference(WETH, client(2000))).toBe(10n ** 18n);
  expect(await ethReference('0x1111111111111111111111111111111111111111', client(2000))).toBe(null);
});

test('M2: funding output must sit within 5% of the on-chain reference', async () => {
  const amount = 10n ** 17n; // 0.1 ETH -> ~200 USDG
  const ok = await checkFundingOutput({ quote: USDG, amount, outputAmount: 196_000_000n }, client(2000));
  expect(ok.checked).toBe(true);
  await expect(checkFundingOutput({ quote: USDG, amount, outputAmount: 180_000_000n }, client(2000))).rejects.toThrow('5%');
  await expect(checkFundingOutput({ quote: USDG, amount, outputAmount: 230_000_000n }, client(2000))).rejects.toThrow('5%');
  await expect(checkFundingOutput({ quote: WETH, amount, outputAmount: amount * 90n / 100n }, client(2000))).rejects.toThrow('5%');
  expect((await checkFundingOutput({ quote: '0x1111111111111111111111111111111111111111', amount, outputAmount: 1n }, client(2000))).checked).toBe(false);
});

test('M2: ETH valuation is cross-checked against the pool and the provider USDG price', async () => {
  await checkEthUsd({ ethPriceUsd: '2010', usdgPriceUsd: '1' }, client(2000));
  await expect(checkEthUsd({ ethPriceUsd: '2600', usdgPriceUsd: '1' }, client(2000))).rejects.toThrow('10%');
  await checkEthUsd({ ethPriceUsd: '1600', usdgPriceUsd: '0.8' }, client(2000));
  const eth = QUOTES.find(q => q.native), usdg = QUOTES.find(q => q.address === USDG);
  const fetcher = price => async url => ({ ok: true, json: async () => url.includes(USDG)
    ? { chainId: 4663, address: USDG, decimals: 6, priceUSD: '1' }
    : { chainId: 4663, address: eth.address, decimals: 18, priceUSD: price } });
  const now = () => 1793490000000;
  expect((await usdValuation(eth.address, '40000', { fetcher: fetcher('2000'), now, useCache: false, client: client(2000) })).openingQuoteRaw).toBeDefined();
  await expect(usdValuation(eth.address, '40000', { fetcher: fetcher('3000'), now: () => 1793490000000 + 7200000, useCache: false, client: client(2000) })).rejects.toThrow('on-chain');
  expect(usdg.decimals).toBe(6);
});
