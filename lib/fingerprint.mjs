import { encodeAbiParameters, keccak256, parseUnits } from '../../app/node_modules/viem/_esm/index.js';

// Byte-compatible with the registry: ASCII case/whitespace only, no Unicode folding.
export const canonicalName = name => name.replace(/[\t\n\v\f\r ]+/g,' ').replace(/^ | $/g,'').replace(/[a-z]/g,c=>c.toUpperCase());

// Economics only: changing payout wallets, project links or descriptions cannot bypass this key.
// Registration remains atomic with a future authorized Plugged factory, never a public reservation.
export function launchFingerprint(plan, decimals) {
  const f = plan.programs.fundraising, c = plan.programs.cashback;
  const e = plan.economics ?? {};
  const markets=[...(e.markets??[])].sort((a,b)=>a.quote.localeCompare(b.quote));
  const marketHash=keccak256(encodeAbiParameters([{type:'address[]'},{type:'uint16[]'}],
    [markets.map(m=>m.quote),markets.map(m=>m.allocationBps)]));
  const settingsHash = keccak256(encodeAbiParameters([
    {type:'address'}, {type:'uint256'}, {type:'uint16'}, {type:'uint16'}, {type:'uint16[]'},
    {type:'bool'}, {type:'uint256'}, {type:'uint256'}, {type:'uint16'}, {type:'uint256'},
    {type:'uint256'}, {type:'uint256'}, {type:'uint16'}, {type:'uint16'}, {type:'uint16'},
    {type:'string'}, {type:'bytes32'},
  ], [plan.quote, BigInt(plan.totalSupply), plan.maxWalletBps, plan.holderBps,
    plan.rewards.developerEnabled ? plan.recipients.map(r=>r.bps).sort((a,b)=>a-b) : [],
    f.enabled, f.enabled?parseUnits(f.goal,decimals):0n, f.enabled?BigInt(Date.parse(f.deadline)/1000):0n,
    c.enabled?c.feeRebateBps:0, c.enabled?parseUnits(c.budget,decimals):0n,
    parseUnits(e.openingMarketCapUsd??'2500',2), parseUnits(e.milestoneMarketCapUsd??'40000',2),
    e.buyFeeBps??0, e.sellFeeBps??0, e.platformVolumeBps??0,
    e.mechanism??'direct-v4',marketHash,
  ]));
  const ticker = plan.symbol.toUpperCase();
  const name = canonicalName(plan.name);
  const key = keccak256(encodeAbiParameters([{type:'string'},{type:'string'},{type:'bytes32'}],[ticker,name,settingsHash]));
  return { ticker, name, settingsHash, key, scope:'plugged-factory', status:'not-deployed' };
}
