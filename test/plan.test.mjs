import { describe, test, expect } from 'bun:test';
import { validatePlan, splitAmount } from '../lib/plan.mjs';
import { QUOTES } from '../lib/config.mjs';
const alice='0x1111111111111111111111111111111111111111', bob='0x2222222222222222222222222222222222222222';
export const valid = () => ({name:'Community',symbol:'COMM',description:'A real draft',github:'https://github.com/team/repo',website:'https://example.com',chainId:4663,maxWalletBps:300,quote:QUOTES[1].address,holderBps:2500,recipients:[{address:alice,bps:7000},{address:bob,bps:3000}]});
describe('launch-plan trust boundary',()=>{
  test('canonicalizes a valid plan and discards spoofed live fields',()=>{const result=validatePlan({...valid(),status:'live',owner:bob,txHash:'0xfake'});expect(result.ok).toBe(true);expect(result.value.status).toBe('draft');expect(result.value.owner).toBeUndefined();expect(result.value.txHash).toBeUndefined();});
  for(const [name,patch] of [
    ['wrong chain',{chainId:1}],['disabled cap',{maxWalletBps:0}],['higher cap',{maxWalletBps:301}],['unknown quote',{quote:alice}],
    ['invalid shares',{recipients:[{address:alice,bps:9000}]}],['duplicate wallets',{recipients:[{address:alice,bps:5000},{address:alice,bps:5000}]}],
    ['zero recipient',{recipients:[{address:'0x'+'0'.repeat(40),bps:10000}]}],['noninteger shares',{recipients:[{address:alice,bps:10000.1}]}],
    ['empty recipients',{recipients:[]}],['too many recipients',{recipients:Array(101).fill({address:alice,bps:100})}],
    ['malformed row',{recipients:[null]}],['invalid holder share',{holderBps:10001}],['fractional holder share',{holderBps:10.5}],
    ['script website',{website:'javascript:alert(1)'}],['credential website',{website:'https://user:password@example.com'}],
    ['github host spoof',{github:'https://github.com.evil.com/team/repo'}],['github username only',{github:'https://github.com/team'}],
    ['script ticker',{symbol:'<script>'}],['oversized name',{name:'x'.repeat(65)}],['blank name',{name:'   '}],
  ])test(`rejects ${name}`,()=>expect(validatePlan({...valid(),...patch}).ok).toBe(false));
  test('rejects non-object input',()=>{for(const v of [null,[],42,'draft'])expect(validatePlan(v).ok).toBe(false);});
  test('supports 100 distinct recipients',()=>{const recipients=Array.from({length:100},(_,i)=>({address:`0x${(i+1).toString(16).padStart(40,'0')}`,bps:100}));expect(validatePlan({...valid(),recipients}).ok).toBe(true);});
});
describe('funded fee pool accounting',()=>{
  test('six-decimal quote has exact 70/30 allocations',()=>{const split=splitAmount(100_000_000n,valid().recipients);expect(split.shares.map(s=>s.amount)).toEqual([70_000_000n,30_000_000n]);expect(split.retained).toBe(0n);});
  test('retains dust instead of paying it twice',()=>{const split=splitAmount(1n,valid().recipients);expect(split.shares.map(s=>s.amount)).toEqual([0n,0n]);expect(split.retained).toBe(1n);});
  test('handles uint128-sized funding without float conversion',()=>{const amount=(1n<<128n)-1n;const split=splitAmount(amount,valid().recipients);expect(split.shares.reduce((s,r)=>s+r.amount,split.retained)).toBe(amount);});
  test('rejects negative amount and malformed allocation',()=>{expect(()=>splitAmount(-1n,valid().recipients)).toThrow();expect(()=>splitAmount(1n,[{bps:1}])).toThrow();});
});
