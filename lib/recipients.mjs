import { isAddress, getAddress } from '../../app/node_modules/viem/_esm/index.js';

export function socialHandle(kind,input) {
  if(!['x','github'].includes(kind)||typeof input!=='string')throw new Error('Choose X or GitHub and enter a profile.');
  let handle=input.trim();
  if(handle.startsWith('https://')){
    const url=new URL(handle),hosts=kind==='x'?['x.com','twitter.com']:['github.com'];
    if(!hosts.includes(url.hostname)||url.username||url.password||url.search||url.hash||url.port)throw new Error('Use a direct X or GitHub profile URL.');
    const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==1)throw new Error('Use a profile, not a post or repository.');handle=parts[0];
  }
  handle=handle.replace(/^@/,'').toLowerCase();
  const valid=kind==='x'?/^[a-z0-9_]{1,15}$/.test(handle):/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(handle)&&!handle.includes('--');
  if(!valid)throw new Error('Enter a valid X or GitHub username.');return handle;
}
export function recipientLabel(row) {return row.kind&&row.kind!=='wallet'?`${row.kind==='x'?'X':'GitHub'} · @${row.username}`:row.address;}
export function validateRecipients(input,enabled,max=100) {
  const errors=[],recipients=[],seen=new Set();
  if(!Array.isArray(input)||input.length>max||(enabled&&input.length<1))return {errors:['recipients: choose 1–100 recipients.'],recipients};
  for(const [i,row] of input.entries()){
    if(!row||typeof row!=='object'){errors.push(`recipient ${i+1}: invalid row.`);continue;}
    const kind=row.kind??'wallet';let recipient;
    try{
      if(kind==='wallet'){
        const address=typeof row.address==='string'?row.address.trim():'';
        if(!isAddress(address)||/^0x0{40}$/i.test(address))throw new Error('Enter a valid nonzero Ethereum address.');
        recipient={kind,address:getAddress(address),bps:row.bps};
      }else{
        const username=socialHandle(kind,row.username);
        recipient={kind,username,bps:row.bps};
        const r=row.resolution;
        if(r&&typeof r==='object'&&isAddress(r.wallet??'')&&typeof r.receipt==='string'&&r.receipt.length<=4096){
          recipient.resolution={wallet:getAddress(r.wallet),receipt:r.receipt,providerId:String(r.providerId??'').slice(0,128),expiresAt:String(r.expiresAt??'').slice(0,30)};
        }
      }
      const identity=kind==='wallet'?recipient.address.toLowerCase():`${kind}:${recipient.username}`;
      if(seen.has(identity))throw new Error('Duplicate recipient.');seen.add(identity);
      if(!Number.isInteger(row.bps)||row.bps<=0||row.bps>10000)throw new Error('Share must be 1–10000 basis points.');
      recipients.push(recipient);
    }catch(error){errors.push(`recipient ${i+1}: ${error.message}`);}
  }
  if((recipients.length||enabled)&&recipients.reduce((n,r)=>n+r.bps,0)!==10000)errors.push('Recipient shares must total exactly 100%.');
  return {recipients,errors};
}
