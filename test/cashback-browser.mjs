// Isolated browser harness. All populated rows and wallet responses are explicitly test fixtures.
// Run: bun run test/cashback-browser.mjs. No application server/build files are modified.
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { pathToFileURL,fileURLToPath } from 'node:url';

const account='0x1111111111111111111111111111111111111111',address='0x2222222222222222222222222222222222222222',hash='0x'+'12'.repeat(32);
let service,server;
if(typeof Bun!=='undefined'){
const {ProgramService}=await import('../lib/program-service.mjs');
const {ProgramStore}=await import('../lib/program-service-store.mjs');
const build=await Bun.build({entrypoints:[new URL('../web/programs.js',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],target:'browser',minify:false});
assert(build.success,'Browser module bundles');const script=await build.outputs[0].text();
service=new ProgramService({manifest:[],store:new ProgramStore(':memory:')});
server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const url=new URL(req.url);
  if(url.pathname==='/programs.js')return new Response(script,{headers:{'content-type':'text/javascript'}});
  if(url.pathname==='/style.css')return new Response(Bun.file(new URL('../web/style.css',import.meta.url)));
  if(url.pathname==='/api/programs')return Response.json(await service.list());
  return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Programs local test harness</title><link rel="stylesheet" href="/style.css"><body><main id="main"></main><script type="module">
    import {programsScreen} from '/programs.js';window.lang='en';window.connected=false;window.chain=31337;window.sent=[];
    const account='${account}';window.account=account;window.provider={request:async({method,params})=>{if(method==='eth_chainId')return '0x'+window.chain.toString(16);if(method==='eth_accounts')return [window.account];if(method==='eth_sendTransaction'){if(window.sendError)throw Object.assign(Error(window.sendError),{code:window.sendError==='rejected'?4001:-1});window.sent.push(params[0]);return '${hash}';}throw Error(method);}};
    window.screen=programsScreen({wallet:()=>({account:window.connected?window.account:null,provider:window.provider}),connect:async()=>{window.connected=true},language:()=>window.lang,esc:v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
    await window.screen.mount(document.querySelector('main'));
    </script></body></html>`,{headers:{'content-type':'text/html'}});
}});
console.log('Isolated server ready; starting Node Playwright driver.');
const child=Bun.spawn(['node',fileURLToPath(import.meta.url),'--browser',server.url.href],{stdout:'inherit',stderr:'inherit'});
const code=await child.exited;server.stop(true);service.close();process.exit(code);
}
server={url:new URL(process.argv[3]),stop(){}};service={close(){}};
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[],checks=[];
page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);
page.on('pageerror',e=>errors.push(e.message));
const output=process.env.PLUGGED_PROGRAM_SCREENSHOTS||'C:/Users/shies/AppData/Local/Temp/opencode/programs-review';await mkdir(output,{recursive:true});
const audits=[];
const shot=async name=>{
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:output+'/'+name+'.png',fullPage:true});
  if(!await page.evaluate(()=>typeof window.AccessLint!=='undefined'))await page.addScriptTag({path:process.env.ACCESSLINT_ENGINE||'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js'});
  const audit=await page.evaluate(()=>{AccessLint.clearAllCaches();return JSON.parse(JSON.stringify(AccessLint.runAudit(document),(key,value)=>key==='element'?undefined:value));});
  audits.push({name,ruleCount:audit.ruleCount,skippedRules:audit.skippedRules,violations:audit.violations});
};
const fit=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
const base={id:'fixture',name:'LOCAL TEST FIXTURE — campaign',kind:'campaign',address,chainId:31337,localTest:true,verified:true,enabled:true,currency:'0x'+'0'.repeat(40),decimals:18,symbol:'ETH',beneficiary:'0x3333333333333333333333333333333333333333',goal:'1000000000000000000',deadline:String(Math.floor(Date.now()/1000)+3600),totalContributed:'100000000000000000',totalRefunded:'0',contribution:'100000000000000000',refundable:'0',phase:'open',account};
let p=base,next='send',expired=false,confirmation='submitted';
try{
  console.log('Browser started; loading isolated programs fixture.');
  await page.goto(server.url.href,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'No verified programs available'}).waitFor();assert.equal(await page.locator('[data-program-form]').count(),0);checks.push('Real empty service fails closed');await fit();await shot('programs-undeployed-mobile');
  await page.route(/\/api\/programs(?:\/|\?|$)/,async route=>{
    const url=new URL(route.request().url());if(url.pathname==='/api/programs')return route.fulfill({json:{status:'ready',programs:[p],unavailable:[]}});
    if(url.pathname==='/api/programs/prepare'){const b=route.request().postDataJSON();return route.fulfill({json:{id:'fixture-preparation',programId:p.id,action:b.action,account,next,chainId:31337,expiresAt:Date.now()+(expired?-1000:60000),expected:{event:'Contributed',args:{amount:'10000000000000000',contributor:account}},transaction:{from:account,to:address,data:'0x1234',value:'0x0',chainId:'0x7a69'}}});}
    if(url.pathname==='/api/programs/submit')return route.fulfill({json:{status:confirmation}});
    return route.fulfill({status:503,json:{error:'Attestor not configured (local fixture).'}});
  });
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Connect wallet to continue'}).click();await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await fit();await shot('programs-campaign-mobile-light');
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.lang='es';window.screen.invalidate();});await page.getByRole('button',{name:'Revisar aporte'}).waitFor();await fit();await shot('programs-campaign-mobile-dark-es');checks.push('390px light and dark Spanish campaign layout');
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';window.lang='en';window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.getByRole('button',{name:'Sign transaction',exact:true}).waitFor();
  assert.equal(await page.locator('[data-program-destination]').textContent(),address);assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Transaction review');checks.push('Contribution receipt names escrow, with focus before signing');await shot('programs-contribution-review-mobile-light');
  await page.locator('[name=amount]').fill('0.02');assert.equal(await page.getByRole('button',{name:'Sign transaction',exact:true}).count(),0);checks.push('Editing invalidates signable calldata');
  expired=true;await page.getByRole('button',{name:'Review contribution'}).click();await page.getByRole('button',{name:'Sign transaction',exact:true}).click();await page.getByText('Review expired. Review again before signing.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.sent.length),0);expired=false;checks.push('Expired reviews cannot sign');
  await page.evaluate(()=>window.chain=1);await page.getByRole('button',{name:'Review contribution'}).click();await page.getByText('Switch your wallet to chain 31337, then review again.',{exact:true}).first().waitFor();assert.equal(await page.evaluate(()=>window.sent.length),0);await page.evaluate(()=>window.chain=31337);checks.push('Wrong chain blocks signing');
  await page.evaluate(()=>{window.lang='es';window.chain=1;window.screen.invalidate();});await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Revisar aporte'}).click();await page.getByText('Cambia tu billetera a la red 31337 y revisa de nuevo.',{exact:true}).first().waitFor();checks.push('Spanish wrong-network error preserves required chain');await page.evaluate(()=>{window.lang='en';window.chain=31337;window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.getByRole('button',{name:'Sign transaction',exact:true}).click();await page.getByRole('button',{name:'Check confirmation'}).waitFor();assert.equal(await page.evaluate(()=>window.sent.length),1);assert(await page.evaluate(()=>JSON.parse(localStorage.getItem('plugged.programTransaction')).txHash));
  await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'Check confirmation'}).waitFor();confirmation='confirmed';await page.getByRole('button',{name:'Check confirmation'}).click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('plugged.programTransaction')),null);checks.push('Pending hash survives reload; verified confirmation clears it');
  await page.evaluate(()=>{window.connected=true;window.screen.invalidate();});await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.evaluate(()=>window.sendError='rejected');await page.getByRole('button',{name:'Sign transaction',exact:true}).click();await page.getByText('Wallet request rejected. Review again before signing.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Sign transaction',exact:true}).count(),0);assert.equal(await page.evaluate(()=>localStorage.getItem('plugged.programTransaction')),null);checks.push('Explicit wallet rejection consumes review and clears unsent recovery');
  await page.getByRole('button',{name:'Review contribution'}).click();await page.evaluate(()=>window.sendError='Uncertain wallet response');await page.getByRole('button',{name:'Sign transaction',exact:true}).click();await page.getByText('Recover a sent transaction',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Sign transaction',exact:true}).count(),0);
  await page.evaluate(()=>{window.lang='es';window.screen.invalidate();});await page.getByText('Recuperar una transacción enviada',{exact:true}).click();await page.getByRole('button',{name:'Verificar transacción'}).click();await page.getByText('Introduce el hash completo.',{exact:true}).waitFor();checks.push('Spanish recovery validation retains its exact instruction');
  await page.getByText('Recuperar una transacción enviada',{exact:true}).click();await page.getByRole('button',{name:'No se envió: borrar revisión'}).click();await page.evaluate(()=>{window.sendError=null;window.lang='en';window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();checks.push('Uncertain send cannot sign again before explicit recovery resolution');
  p={...base,phase:'failed',refundable:base.contribution};await page.evaluate(()=>{window.connected=true;window.screen.invalidate();});await page.getByRole('button',{name:'Review my refund'}).waitFor();checks.push('Failed campaign exposes original contributor refund');
  p={...base,phase:'successful'};await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Review beneficiary payout'}).waitFor();checks.push('Successful campaign exposes fixed payout');
  p={...base,kind:'cashback',name:'LOCAL TEST FIXTURE — cashback',phase:'cashback',budget:'2000000000000000000',totalFunded:'1000000000000000000',totalClaimed:'100000000000000000',available:'900000000000000000',claimed:'100000000000000000',fundingRemaining:'1000000000000000000',attestor:address,attestationStatus:'unconfigured',rebateBps:'1000'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('heading',{name:'Claim your cashback'}).waitFor();assert.equal(await page.getByRole('button',{name:'Fetch verified voucher'}).count(),0);await page.locator('[name=voucher]').fill('{bad');await page.getByRole('button',{name:'Verify & review cashback'}).click();await page.getByText('Paste a valid signed voucher JSON object.',{exact:true}).first().waitFor();assert.equal(await page.locator('[name=voucher]').getAttribute('aria-invalid'),'true');checks.push('Absent attestor explicit; malformed voucher rejected inline');
  await page.locator('[name=voucher]').fill(JSON.stringify({fixture:'LOCAL KEYBOARD TEST — not a claim voucher',lines:Array.from({length:50},(_,i)=>`Scrollable evidence line ${i+1}`)},null,2));
  assert.equal(await page.locator('[name=voucher]').getAttribute('tabindex'),'0');assert(await page.locator('[name=voucher]').evaluate(el=>el.scrollHeight>el.clientHeight));
  await page.getByRole('button',{name:'Verify & review cashback'}).focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('name')),'voucher');checks.push('Scrollable voucher textarea is explicitly keyboard-focusable at 390px');
  await fit();await shot('programs-cashback-mobile-light');await page.setViewportSize({width:1440,height:1000});await fit();await shot('programs-cashback-desktop-light');await page.evaluate(()=>document.documentElement.dataset.theme='dark');await shot('programs-cashback-desktop-dark');checks.push('1440px cashback layout light/dark');
  // Controlled browser-fetch barriers exercise responses arriving after a new epoch.
  const hold=async path=>page.evaluate(path=>{const original=window.fetch;window.fetch=(url,options)=>{if(String(url).split('?')[0]===path){window.fetch=original;window.requestHeld=true;return new Promise(resolve=>window.releaseHeld=(body,status=200)=>resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})));}return original(url,options);};window.requestHeld=false;},path);
  const release=async(body,status=200)=>page.evaluate(async({body,status})=>{window.releaseHeld(body,status);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},{body,status});
  const hasStatus=()=>page.locator('[data-program-status]').textContent();
  p={...base};await page.evaluate(()=>{window.account='0x1111111111111111111111111111111111111111';window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await hold('/api/programs');
  await page.evaluate(()=>{window.account='0x4444444444444444444444444444444444444444';void window.screen.invalidate();});
  assert.equal(await page.locator('[data-program-form]').count(),0);assert.equal(await page.getByText('Your recorded contribution',{exact:true}).count(),0);
  p={...base,account:'0x4444444444444444444444444444444444444444',contribution:'2000000000000000000'};
  await release({status:'ready',programs:[p],unavailable:[]});await page.getByRole('button',{name:'Review contribution'}).waitFor();checks.push('Account invalidation synchronously removes prior-account data while list loads');
  await hold('/api/programs/prepare');await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.waitForFunction(()=>window.requestHeld);
  await page.evaluate(()=>{void window.screen.mount(document.querySelector('main'));});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await release({error:'STALE PREPARATION ERROR'},503);assert.equal(await hasStatus(),'');assert.equal(await page.getByRole('button',{name:'Review contribution'}).isEnabled(),true);checks.push('Late preparation failure cannot alter a remounted screen');
  await page.evaluate(({hash})=>{localStorage.setItem('plugged.programTransaction',JSON.stringify({id:'old-account-preparation',txHash:hash}));void window.screen.invalidate();},{hash});await page.getByRole('button',{name:'Check confirmation'}).waitFor();
  await hold('/api/programs/submit');await page.getByRole('button',{name:'Check confirmation'}).click();await page.waitForFunction(()=>window.requestHeld);
  await page.evaluate(()=>{window.account='0x5555555555555555555555555555555555555555';void window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await release({status:'confirmed'});assert.equal(await hasStatus(),'');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('plugged.programTransaction')).id),'old-account-preparation');checks.push('Late confirmation cannot clear recovery or announce payment in a new account epoch');
  // Terminal result's refresh itself can race with another invalidate/remount.
  confirmation='reverted';await hold('/api/programs');await page.getByRole('button',{name:'Check confirmation'}).click();await page.waitForFunction(()=>window.requestHeld);
  await page.evaluate(()=>{void window.screen.mount(document.querySelector('main'));});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await release({status:'ready',programs:[{...base,name:'STALE ACCOUNT LIST'}],unavailable:[]});assert.equal(await hasStatus(),'');assert.equal(await page.getByText('STALE ACCOUNT LIST',{exact:true}).count(),0);checks.push('Late terminal-refresh continuation cannot restore stale balances or reverted error');
  // A superseded action must not clear the busy state of a newer request.
  await hold('/api/programs/prepare');await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.waitForFunction(()=>window.requestHeld);await page.evaluate(()=>window.releaseOld=window.releaseHeld);
  await page.evaluate(()=>{void window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();await hold('/api/programs/prepare');await page.locator('[name=amount]').fill('0.02');await page.getByRole('button',{name:'Review contribution'}).click();await page.waitForFunction(()=>window.requestHeld);
  await page.evaluate(async()=>{window.releaseOld({error:'OLD BUSY ERROR'},503);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});assert.equal(await page.getByRole('button',{name:'Review contribution'}).isDisabled(),true);
  await release({error:'CURRENT REQUEST ERROR'},400);await page.getByText('CURRENT REQUEST ERROR',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'Review contribution'}).isEnabled(),true);checks.push('Stale finally cannot unlock a newer busy request');
  p={...base};await page.evaluate(()=>{window.account='0x1111111111111111111111111111111111111111';void window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();await page.locator('[name=amount]').fill('0.01');await page.getByRole('button',{name:'Review contribution'}).click();await page.getByRole('button',{name:'Sign transaction',exact:true}).waitFor();
  await page.evaluate(()=>{const request=window.provider.request;window.provider.request=input=>input.method==='eth_sendTransaction'?new Promise(resolve=>{window.walletHeld=true;window.releaseWallet=resolve;}):request(input);});
  await page.getByRole('button',{name:'Sign transaction',exact:true}).click();await page.waitForFunction(()=>window.walletHeld);
  p={...base,account:'0x4444444444444444444444444444444444444444',contribution:'2000000000000000000'};await page.evaluate(()=>{window.account='0x4444444444444444444444444444444444444444';void window.screen.invalidate();});await page.getByRole('button',{name:'Review contribution'}).waitFor();
  await page.evaluate(async hash=>{window.releaseWallet(hash);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},hash);
  assert.deepEqual(await page.evaluate(()=>{const r=JSON.parse(localStorage.getItem('plugged.programTransaction'));return {id:r.id,txHash:r.txHash};}),{id:'fixture-preparation',txHash:hash});assert.equal(await hasStatus(),'');checks.push('Late wallet broadcast preserves its original recovery ID/hash without mutating new-account UI');
  await page.evaluate(()=>window.screen.destroy());checks.push('Lifecycle destroy');assert.deepEqual(errors,[]);
  await writeFile(output+'/accessibility.json',JSON.stringify(audits,null,2));
  console.log(JSON.stringify({passed:checks.length,checks,errors,audits:audits.map(a=>({...a,violations:a.violations.map(v=>({ruleId:v.ruleId,selector:v.selector,message:v.message}))})),screenshots:output},null,2));
  assert(!audits.some(a=>a.violations.length||a.skippedRules.length),'Accessibility audit must have no violations or skipped rules');
}finally{await browser.close();server.stop(true);service.close();}
