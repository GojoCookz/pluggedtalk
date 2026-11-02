import { isAddress, zeroAddress, hashTypedData, recoverTypedDataAddress } from '../../app/node_modules/viem/_esm/index.js';

export const FEE_VOUCHER_TYPES = { FeeVoucher: [
  {name:'trader',type:'address'}, {name:'cumulativeFees',type:'uint256'},
  {name:'validUntil',type:'uint256'}, {name:'evidence',type:'bytes32'},
] };
export const uint256 = (value,label='Amount') => {
  if(typeof value!=='string'||! /^(0|[1-9]\d{0,77})$/.test(value)||BigInt(value)>=2n**256n)throw new Error(`${label}: expected a uint256 decimal string.`);
  return BigInt(value);
};
export function feeVoucherData({chainId,address},voucher) {
  if(!Number.isSafeInteger(chainId)||chainId<=0||!isAddress(address,{strict:false}))throw new Error('Invalid cashback domain.');
  if(!voucher||Object.keys(voucher).some(k=>!['trader','cumulativeFees','validUntil','evidence','signature'].includes(k)))throw new Error('Invalid voucher fields.');
  if(!isAddress(voucher.trader??'',{strict:false})||voucher.trader.toLowerCase()===zeroAddress||voucher.trader.toLowerCase()===address.toLowerCase())throw new Error('Invalid voucher trader.');
  if(!/^0x[\da-f]{64}$/i.test(voucher.evidence??''))throw new Error('Invalid voucher evidence.');
  return {domain:{name:'PluggedCashback',version:'1',chainId,verifyingContract:address},types:FEE_VOUCHER_TYPES,primaryType:'FeeVoucher',
    message:{trader:voucher.trader,cumulativeFees:uint256(voucher.cumulativeFees,'Eligible fees'),validUntil:uint256(voucher.validUntil,'Voucher expiry'),evidence:voucher.evidence}};
}
export function cashbackAccounting({cumulativeFees,rebateBps,claimed,totalFunded,totalClaimed,budget}) {
  const [fees,bps,previous,funded,spent,cap]=[cumulativeFees,rebateBps,claimed,totalFunded,totalClaimed,budget].map(v=>uint256(String(v)));
  if(bps===0n||bps>10000n||funded>cap||spent>funded||previous>spent)throw new Error('Inconsistent cashback accounting.');
  const entitlement=fees*bps/10000n,due=entitlement>previous?entitlement-previous:0n,available=funded-spent;
  // Contract claims are all-or-nothing. Never truncate a signed cumulative voucher.
  return {eligibleFees:fees.toString(),entitlement:entitlement.toString(),alreadyClaimed:previous.toString(),due:due.toString(),available:available.toString(),budget:cap.toString(),fundingRemaining:(cap-funded).toString(),
    claimable:due>0n&&due<=available,reason:due===0n?'nothing-to-claim':due>available?'insufficient-funded-budget':null};
}
export async function verifyFeeVoucher(program,voucher,{account,timestamp}) {
  const data=feeVoucherData(program,voucher);
  if(data.message.trader.toLowerCase()!==account.toLowerCase())throw new Error('Voucher belongs to a different wallet.');
  if(data.message.validUntil<BigInt(timestamp))throw new Error('Cashback voucher expired.');
  if(!/^0x[\da-f]{130}$/i.test(voucher.signature??''))throw new Error('A signed attestor voucher is required.');
  const recovered=await recoverTypedDataAddress({...data,signature:voucher.signature});
  if(recovered.toLowerCase()!==program.attestor.toLowerCase())throw new Error('Cashback signature does not match the immutable attestor.');
  return {digest:hashTypedData(data),accounting:cashbackAccounting({...program,cumulativeFees:voucher.cumulativeFees})};
}
