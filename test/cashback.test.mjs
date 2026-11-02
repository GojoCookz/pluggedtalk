import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { hashTypedData, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { uint256, feeVoucherData, cashbackAccounting, verifyFeeVoucher } from '../lib/cashback.mjs';

// Deterministic, test-only keys; these accounts never connect to a network.
const attestor=privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other=privateKeyToAccount(`0x${'22'.repeat(32)}`);
const trader='0x3333333333333333333333333333333333333333';
const address='0x4444444444444444444444444444444444444444';
const program=(overrides={})=>({chainId:31337,address,attestor:attestor.address,rebateBps:'1500',claimed:'0',totalFunded:'1000',totalClaimed:'0',budget:'2000',...overrides});
const voucher=(overrides={})=>({trader,cumulativeFees:'1001',validUntil:'2000',evidence:`0x${'ab'.repeat(32)}`,...overrides});
async function signed(overrides={},domain=program(),signer=attestor) {
  const v=voucher(overrides);
  return {...v,signature:await signer.signTypedData(feeVoucherData(domain,v))};
}
const verify=(p,v,timestamp=1000)=>verifyFeeVoucher(p,v,{account:trader,timestamp});

describe('cashback voucher validation and exact accounting',()=>{
  test('uint256 preserves full precision and rejects noncanonical or overflowing inputs',()=>{
    const max=2n**256n-1n;
    expect(uint256(max.toString())).toBe(max);
    expect(uint256('0')).toBe(0n);
    for(const value of [0,1n,'','01','-1','+1','1.0','1e3',' 1','1 ',(max+1n).toString(),null,undefined]) {
      expect(()=>uint256(value)).toThrow('uint256 decimal string');
    }
  });

  test('a genuine EIP-712 signature yields the exact digest and rounded-down rebate',async()=>{
    const p=program(),v=await signed(),result=await verify(p,v);
    expect(result.digest).toBe(hashTypedData(feeVoucherData(p,v)));
    expect(result.accounting).toMatchObject({eligibleFees:'1001',entitlement:'150',due:'150',available:'1000',claimable:true,reason:null});
    // Contract expiry is inclusive: block.timestamp == validUntil remains valid.
    expect((await verify(p,v,2000)).accounting.claimable).toBe(true);
    await expect(verify(p,v,2001)).rejects.toThrow('expired');
  });

  test('cumulative vouchers pay only the delta; replay and older vouchers pay nothing',()=>{
    const p=program({claimed:'150',totalClaimed:'350'});
    expect(cashbackAccounting({...p,cumulativeFees:'2000'})).toMatchObject({entitlement:'300',due:'150',available:'650',claimable:true});
    for(const cumulativeFees of ['1001','500']) {
      expect(cashbackAccounting({...p,cumulativeFees})).toMatchObject({due:'0',claimable:false,reason:'nothing-to-claim'});
    }
  });

  test('funded balance, not the advertised budget, bounds an all-or-nothing claim',()=>{
    const p=program({totalFunded:'100',budget:'10000'});
    expect(cashbackAccounting({...p,cumulativeFees:'1000'})).toMatchObject({due:'150',available:'100',fundingRemaining:'9900',claimable:false,reason:'insufficient-funded-budget'});
    expect(cashbackAccounting({...p,cumulativeFees:'667'})).toMatchObject({due:'100',claimable:true});
    expect(cashbackAccounting({...p,cumulativeFees:'1'})).toMatchObject({due:'0',claimable:false});
  });

  test('mulDiv-equivalent arithmetic does not lose precision or overflow intermediate products',()=>{
    const max=(2n**256n-1n).toString();
    expect(cashbackAccounting({cumulativeFees:max,rebateBps:'10000',claimed:'0',totalFunded:max,totalClaimed:'0',budget:max})).toMatchObject({entitlement:max,due:max,claimable:true});
  });

  test('impossible program accounting is rejected',()=>{
    for(const overrides of [{rebateBps:'0'},{rebateBps:'10001'},{totalFunded:'2001'},{totalClaimed:'1001'},{claimed:'1'}]) {
      expect(()=>cashbackAccounting({...program(overrides),cumulativeFees:'1000'})).toThrow('Inconsistent cashback accounting');
    }
  });

  test('wrong signer, chain, contract, and tampered signed fields are rejected',async()=>{
    await expect(verify(program(),await signed({},program(),other))).rejects.toThrow('immutable attestor');
    await expect(verify(program(),await signed({},program({chainId:4663})))).rejects.toThrow('immutable attestor');
    await expect(verify(program(),await signed({},program({address:other.address})))).rejects.toThrow('immutable attestor');
    const v=await signed();
    for(const change of [{cumulativeFees:'1002'},{validUntil:'2001'},{evidence:`0x${'cd'.repeat(32)}`}]) {
      await expect(verify(program(),{...v,...change})).rejects.toThrow('immutable attestor');
    }
    await expect(verifyFeeVoucher(program(),v,{account:other.address,timestamp:1000})).rejects.toThrow('different wallet');
  });

  test('malformed voucher and domain inputs fail before recovery',async()=>{
    for(const change of [{trader:zeroAddress},{trader:address},{trader:'bad'},{evidence:'0xab'},{extra:true},{cumulativeFees:'01'},{validUntil:'-1'}]) {
      expect(()=>feeVoucherData(program(),voucher(change))).toThrow();
    }
    for(const change of [{chainId:0},{chainId:1.5},{chainId:Number.MAX_SAFE_INTEGER+1},{address:'bad'}]) {
      expect(()=>feeVoucherData(program(change),voucher())).toThrow('Invalid cashback domain');
    }
    for(const signature of [undefined,'0x','0x1234',`0x${'gg'.repeat(65)}`]) {
      await expect(verify(program(),voucher({signature}))).rejects.toThrow('signed attestor voucher');
    }
  });
});
