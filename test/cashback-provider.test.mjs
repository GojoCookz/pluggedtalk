import { expect,test } from 'bun:test';
import { createCashbackVoucherProvider,claimVoucherFromAttestation } from '../lib/cashback-provider.mjs';
const a=n=>'0x'+n.repeat(40);
const config={chainId:31337,program:a('1'),currency:a('2'),attestor:a('3'),maxValiditySeconds:3600};
const program={kind:'cashback',chainId:31337,address:config.program,currency:config.currency,attestor:config.attestor};
test('unsigned exports cannot become browser claim vouchers',()=>{
  expect(()=>claimVoucherFromAttestation({status:'unsigned',signerUnavailable:true})).toThrow('unsigned');
  expect(()=>createCashbackVoucherProvider({indexer:{config}})).toThrow('signer');
});
test('provider binds program and derives amounts only from indexer attestations',async()=>{
  const calls=[],signer={signTypedData:async()=> 'never exposed'};
  const indexer={config,attest:async input=>{calls.push(input);return {status:'signed',signerUnavailable:false,signature:'0xsignature',typedData:{message:{trader:input.trader,cumulativeFees:123n,validUntil:1900n,evidence:'0xevidence'}}};}};
  const provider=createCashbackVoucherProvider({indexer,signer,now:()=>1000});
  expect(await provider({program,account:a('4'),cumulativeFees:'999999'})).toEqual({trader:a('4'),cumulativeFees:'123',validUntil:'1900',evidence:'0xevidence',signature:'0xsignature'});
  expect(calls[0]).toEqual({trader:a('4'),validUntil:'1900',signer});
  await expect(provider({program:{...program,address:a('5')},account:a('4')})).rejects.toThrow('does not match');
  expect(calls.length).toBe(1);
});
test('provider rejects voucher lifetimes outside configured operator policy',()=>{
  expect(()=>createCashbackVoucherProvider({indexer:{config},signer:{signTypedData(){}},validitySeconds:3601})).toThrow('lifetime');
});
