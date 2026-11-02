import { test, expect } from 'bun:test';
import { selectDexPair } from '../lib/markets.ts';
const token='0x1111111111111111111111111111111111111111';
const pair=(chainId:string,usd:number,address='0x2222222222222222222222222222222222222222')=>({chainId,pairAddress:address,baseToken:{address:token},liquidity:{usd}});
test('Dexscreener matching requires exact chain and base address, picks deepest pool',()=>{
  const deep=pair('robinhood',2000);
  expect(selectDexPair([pair('ethereum',999999),pair('robinhood',10),deep],token)).toBe(deep);
  expect(selectDexPair([{...deep,baseToken:{address:'0xwrong'}}],token)).toBeNull();
});
test('Dexscreener cannot inject a frame URL through pair address',()=>{
  expect(selectDexPair([pair('robinhood',100,'https://evil.example/')],token)).toBeNull();
});
