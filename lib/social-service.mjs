import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { isAddress, getAddress } from '../../app/node_modules/viem/_esm/index.js';
import { socialHandle } from './recipients.mjs';

const defaultSecret=process.env.PLUGGED_SOCIAL_RECEIPT_SECRET||randomBytes(32).toString('hex');
const signature=(payload,secret)=>createHmac('sha256',secret).update(payload).digest('base64url');
export async function resolveSocial(input,{apiKey=process.env.BAGS_API_KEY,secret=defaultSecret,fetcher=fetch,now=Date.now}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['kind','username'].includes(k)))throw new Error('Provide only a social provider and username. Redirects and claim targets are not accepted.');
  const kind=input?.kind,username=socialHandle(kind,input?.username);
  if(!apiKey)throw new Error('Bags recipient resolution is not configured. Set the server BAGS_API_KEY.');
  const provider=kind==='x'?'twitter':'github';
  const query=new URLSearchParams({provider,username,chain:'EVM'});
  const response=await fetcher(`https://public-api-v2.bags.fm/api/v1/token-launch/fee-share/wallet/v2?${query}`,{
    headers:{'x-api-key':apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(response.status===404?'That profile could not be resolved by Bags.':'Bags resolution failed. Retry or use a wallet address.');
  const body=await response.json(),r=body.response;
  if(body.success!==true||!r||r.chain!=='EVM'||r.provider!==provider||!isAddress(r.wallet??'')||/^0x0{40}$/i.test(r.wallet)
    ||typeof r.platformData?.id!=='string'||!r.platformData.id||r.platformData.id.length>128
    ||socialHandle(kind,r.platformData.username)!==username)throw new Error('Bags returned an unresolved or mismatched EVM identity.');
  const expiresAt=new Date(now()+24*60*60*1000).toISOString();
  const data={kind,username,wallet:getAddress(r.wallet),providerId:r.platformData.id,chainId:4663,expiresAt};
  const payload=Buffer.from(JSON.stringify(data)).toString('base64url');
  return {...data,receipt:`${payload}.${signature(payload,secret)}`,source:'bags',claimAccess:'requires-control-of-resolved-wallet',walletControl:'unverified',oauthAvailable:false};
}
export function resolvedRecipient(row,{secret=defaultSecret,now=Date.now}={}) {
  if((row.kind??'wallet')==='wallet')return getAddress(row.address);
  const [payload,mac,...extra]=String(row.resolution?.receipt??'').split('.');
  if(extra.length||!payload||!mac||payload.length>4000)throw new Error('Resolve every social recipient before preparing a launch.');
  const expected=Buffer.from(signature(payload,secret)),actual=Buffer.from(mac);
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Social resolution receipt is invalid. Resolve the profile again.');
  let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw new Error('Invalid social receipt.');}
  if(data.kind!==row.kind||data.username!==socialHandle(row.kind,row.username)||data.chainId!==4663
    ||data.wallet!==row.resolution.wallet||data.providerId!==row.resolution.providerId||!Number.isFinite(Date.parse(data.expiresAt))||Date.parse(data.expiresAt)<=now())throw new Error('Social resolution is stale or mismatched. Resolve the profile again.');
  return getAddress(data.wallet);
}
export function resolveLaunchRecipients(plan,options) {
  const claimers=plan.recipients.map(r=>resolvedRecipient(r,options));
  if(new Set(claimers.map(a=>a.toLowerCase())).size!==claimers.length)throw new Error('Two recipients resolve to the same wallet. Combine their shares.');
  return {claimers,bps:plan.recipients.map(r=>r.bps)};
}
export function integrationReadiness() {
  return {ready:false,socialResolverConfigured:!!process.env.BAGS_API_KEY,
    openingMarketCapUsd:'2500',inputCurrency:'ETH',chainId:4663,
    blockers:[...(!process.env.BAGS_API_KEY?['BAGS_API_KEY']:[]),'PLUGGED_FACTORY_AND_STRICT_WALLET_CAP','ATOMIC_ETH_TO_LAUNCH_TOKEN_ROUTER','SOCIAL_OWNER_ONBOARDING_E2E','PINNED_FORK_AND_DEPLOYMENT_VERIFICATION'],
    hostedIdentityDocs:'https://docs.bags.fm/api-reference/get-fee-share-wallet.md'};
}
