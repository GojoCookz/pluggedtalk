/** Bridge the receipt-backed operator ledger to ProgramService's voucher endpoint.
 * Signers remain injected (hardware/keystore/HSM); this module handles no private keys.
 */
export function claimVoucherFromAttestation(result) {
  if(result?.status!=='signed'||result.signerUnavailable||!result.signature)throw new Error('Cashback signer is not configured; unsigned evidence cannot be claimed.');
  const m=result.typedData?.message;
  if(!m)throw new Error('Signed attestation has no fee voucher message.');
  return {trader:m.trader,cumulativeFees:String(m.cumulativeFees),validUntil:String(m.validUntil),evidence:m.evidence,signature:result.signature};
}

export function createCashbackVoucherProvider({indexer,signer,validitySeconds=900,now=()=>Math.floor(Date.now()/1000)}) {
  if(!indexer||!signer||typeof signer.signTypedData!=='function')throw new Error('A verified cashback indexer and injected attestor signer are required.');
  if(!Number.isSafeInteger(validitySeconds)||validitySeconds<=0||validitySeconds>indexer.config.maxValiditySeconds)throw new Error('Voucher lifetime exceeds the indexer policy.');
  return async ({program,account})=>{
    const c=indexer.config;
    if(program.kind!=='cashback'||program.chainId!==c.chainId||['address','currency','attestor'].some(k=>program[k]?.toLowerCase()!==c[k==='address'?'program':k]?.toLowerCase()))throw new Error('Cashback provider does not match this verified program.');
    const result=await indexer.attest({trader:account,validUntil:String(now()+validitySeconds),signer});
    return claimVoucherFromAttestation(result);
  };
}
