// Standalone integration harness. All wallet/API fixtures are visibly labeled; never broadcasts.
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { parseUnits } from '../../app/node_modules/viem/_esm/index.js';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
console.log('HARNESS modules loaded');
const output=process.env.TRADING_EVIDENCE_DIR||'C:/Users/shies/AppData/Local/Temp/opencode/plugged-trading';
await mkdir(output,{recursive:true});
execFileSync('bun',['build',fileURLToPath(new URL('../web/trading.js',import.meta.url)),'--target=browser','--minify','--outfile',join(output,'trading.js')],{stdio:'pipe'});
console.log('HARNESS component bundled');
const js=await readFile(join(output,'trading.js'),'utf8'),css=await readFile(new URL('../web/style.css',import.meta.url),'utf8'),account='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168',router='0xd6edcd3cc28c40b42d6fe31b054ebb93a944a3a6',hash='0x'+'ab'.repeat(32);
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugged trading test fixture</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/fixture.css"></head><body><main class="fixture-main"><h1>Plugged trading</h1><p class="fixture-label">SIMULATED WALLET · LOCAL TEST FIXTURES · NO LIVE TRADES</p><div id="trading"></div></main><script type="module">
import {tradingScreen} from '/trading.js';
window.fixture={account:null,chain:'0x1237',mode:'ok',sends:[],lang:'en'};
const provider={request:async({method,params})=>{if(method==='eth_chainId')return fixture.chain;if(method==='eth_accounts')return fixture.account?[fixture.account]:[];if(method==='eth_sendTransaction'){if(fixture.mode==='reject')throw Object.assign(new Error('User rejected'),{code:4001});if(fixture.mode==='delay')return new Promise(resolve=>window.resolveSend=()=>{fixture.sends.push(params[0]);resolve('${hash}')});fixture.sends.push(params[0]);return '${hash}';}throw new Error(method);}};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.coin={address:'${token}',symbol:'TEST',quoteSymbol:'USDG'};
window.screen=tradingScreen({wallet:()=>({account:fixture.account,provider}),connect:async()=>{fixture.account='${account}'},language:()=>fixture.lang,esc});
screen.mount(document.querySelector('#trading'),coin);
</script></body></html>`;
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const route=path==='/trading.js'?['application/javascript',js]:path==='/style.css'?['text/css',css]:path==='/fixture.css'?['text/css','.fixture-main{max-width:700px;margin:auto}.fixture-label{margin:16px 0}']:path==='/'?['text/html',html]:null;
  res.writeHead(route?200:404,{'content-type':route?.[0]||'text/plain','content-security-policy':"style-src 'self'"});res.end(route?.[1]||'Not found');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
console.log('HARNESS browser launched');
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
const errors=[],checks=[],audits=[],records=new Map();let stage='trade',apiFailure=false,deferQuote=null,confirmed=false,expired=false,tamper=false,cancelled=false;
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>cspViolations.push(e.violatedDirective));});
function record(body){
  const sell=body.side==='sell',inputAsset={address:sell?token:quote,symbol:sell?'TEST':'USDG',decimals:sell?18:6,balance:sell?'1000000000000000000000':'10000000',allowance:'0'},outputAsset={address:sell?quote:token,symbol:sell?'USDG':'TEST',decimals:sell?6:18,balance:sell?'10000000':'1000000000000000000000',allowance:'0'};
  const r={id:crypto.randomUUID(),account:body.account,token,side:body.side,router,chainId:4663,amountIn:String(parseUnits(body.amount,inputAsset.decimals)),inputAsset,outputAsset,slippageBps:body.slippageBps,reviewSeconds:body.reviewSeconds,expiresAt:Date.now()+(expired?500:60000),expectedOutput:stage==='trade'?String(parseUnits('123.45',outputAsset.decimals)):null,minimumOutput:stage==='trade'?String(parseUnits('122.83275',outputAsset.decimals)):null,approvalAmount:stage==='reset'?'0':stage==='approve'?'1000000':null,next:stage==='reset'?'approve':stage,transaction:null,status:'review',nativeBalance:'100000000000000000'};
  records.set(r.id,r);return r;
}
await page.route('**/api/trading/*',async route=>{
  const path=new URL(route.request().url()).pathname.split('/').pop(),body=route.request().postDataJSON();
  if(apiFailure)return route.fulfill({status:503,json:apiFailure==='gas'?{code:'TRADING_GAS',error:'Insufficient native ETH for estimated gas. Fund ETH separately, then review again.'}:{code:'TRADING_RPC',error:'RPC unavailable — retry later'}});
  if(path==='balances')return route.fulfill({json:{account,token:{address:token,symbol:'TEST',decimals:18,balance:'1000000000000000000000'},quote:{address:quote,symbol:'USDG',decimals:6,balance:'10000000'},nativeBalance:'100000000000000000',router}});
  if(path==='quote'){if(deferQuote)await new Promise(resolve=>deferQuote.resolve=resolve);return route.fulfill({json:record(body)});}
  if(path==='prepare'){const r=records.get(body.id);return route.fulfill({json:{...r,status:'prepared',gasCostEstimate:'120000000',transaction:{from:account,to:r.next==='approve'?r.inputAsset.address:router,data:tamper?'0xabcdef00':'0x12345678',chainId:'0x1237',value:'0x0',gas:'0x1d4c0'}}});}
  if(path==='submit'||path==='status'){const r=records.get(body.id);return route.fulfill({json:{...r,status:cancelled?'cancelled':confirmed?'confirmed':'submitted',actualOutput:r.expectedOutput,txHash:body.txHash}});}
  return route.fulfill({status:404,json:{error:'Unknown fixture endpoint'}});
});
const text=async()=>page.locator('#trading').innerText();
async function check(name,fn){console.log('CHECK '+name);await fn();checks.push(name);}
async function clean(){
  stage='trade';confirmed=false;expired=false;apiFailure=false;deferQuote=null;tamper=false;cancelled=false;
  await page.evaluate(({account})=>{localStorage.clear();fixture.account=account;fixture.chain='0x1237';fixture.mode='ok';fixture.lang='en';document.documentElement.lang='en';screen.mount(document.querySelector('#trading'),coin);},{account});
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Balances updated'));
}
async function review(){await page.locator('[name=amount]').fill('1');await page.locator('[data-review]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Review ready')||document.querySelector('[data-status]').textContent.includes('Revisión lista'));}
try{
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  await check('disconnected connect works with empty amount',async()=>{await page.getByRole('button',{name:'Connect wallet',exact:true}).click();assert.equal(await page.evaluate(()=>fixture.account),account);});
  await clean();
  await check('refresh shows exact balances',async()=>{assert.match(await text(),/1000 TEST/);assert.match(await text(),/10 USDG/);assert.match(await text(),/0.1 ETH/);});
  await check('buy review exact minimum and no on-chain deadline',async()=>{await review();assert.match(await text(),/123.45 TEST/);assert.match(await text(),/122.83275 TEST/);assert.match(await text(),/Not an on-chain deadline/);});
  await check('contract-address disclosure',async()=>{await page.getByText('Verify contract addresses',{exact:true}).click();assert.match(await text(),new RegExp(router));});
  const engine=process.env.ACCESSLINT_ENGINE||'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js';
  await page.addScriptTag({path:engine});
  for(const [width,height] of [[390,844],[1440,1000]])for(const theme of ['light','dark'])for(const lang of ['en','es']){
    await page.setViewportSize({width,height});
    await page.evaluate(({theme,lang})=>{fixture.lang=lang;document.documentElement.lang=lang;document.documentElement.dataset.theme=theme;screen.invalidate();},{theme,lang});
    await review();
    const result=await page.evaluate(()=>{AccessLint.clearAllCaches();return JSON.parse(JSON.stringify(AccessLint.runAudit(document),(k,v)=>k==='element'?undefined:v));});
    audits.push({width,theme,lang,ruleCount:result.ruleCount,skipped:result.skippedRules,violations:result.violations});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
    await page.screenshot({path:join(output,`trading-${width}-${theme}-${lang}.png`),fullPage:true});
  }
  checks.push('eight mobile/desktop light/dark EN/ES quote screens without horizontal overflow');
  await clean();
  await check('sell changes units while preserving keyboard focus',async()=>{await page.locator('[name=side]').focus();await page.locator('[name=side]').selectOption('sell');assert.equal(await page.evaluate(()=>document.activeElement.name),'side');await review();assert.match(await text(),/123.45 USDG/);assert.match(await text(),/Input is in TEST/);});
  await clean();
  await check('slippage and review settings editable',async()=>{await page.getByText('Slippage and review validity',{exact:true}).click();await page.locator('[name=slippageBps]').fill('100');await page.locator('[name=reviewSeconds]').fill('120');await review();assert.match(await text(),/1%/);});
  await clean();
  await check('changed input invalidates quote',async()=>{await review();await page.locator('[name=amount]').fill('2');assert.equal(await page.locator('[data-trade=sign]').count(),0);});
  await clean();
  await check('funding state has no fabricated output or sign button',async()=>{stage='fund';await review();assert.match(await text(),/unavailable until/);assert.equal(await page.locator('[data-trade=sign]').count(),0);});
  await clean();
  await check('nonzero approval reset and exact-input approval actions',async()=>{stage='reset';await review();assert.equal(await page.getByRole('button',{name:'Reset token approval',exact:true}).count(),1);confirmed=true;await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Approval confirmed'));stage='approve';await review();assert.equal(await page.getByRole('button',{name:'Approve exact input',exact:true}).count(),1);});
  await clean();
  await check('wallet rejection clears uncertain-request recovery',async()=>{await review();await page.evaluate(()=>fixture.mode='reject');await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('rejected'));assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('plugged.trade.')).length),0);});
  await clean();
  await check('changed prepared calldata cannot replace reviewed transaction',async()=>{await review();tamper=true;const before=await page.evaluate(()=>fixture.sends.length);await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('context changed'));assert.equal(await page.evaluate(()=>fixture.sends.length),before);});
  await clean();
  await check('disabled browser storage blocks before wallet broadcast',async()=>{await review();const before=await page.evaluate(()=>fixture.sends.length);await page.evaluate(()=>{window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error('Storage blocked')};});await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Browser storage is unavailable'));assert.equal(await page.evaluate(()=>fixture.sends.length),before);await page.evaluate(()=>Storage.prototype.setItem=window.originalSet);});
  await clean();
  await check('wrong chain blocks review',async()=>{await page.evaluate(()=>fixture.chain='0x1');await page.locator('[name=amount]').fill('1');await page.locator('[data-review]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Switch your wallet'));assert.equal(await page.locator('[data-trade=sign]').count(),0);});
  await clean();
  await check('review expires before signing',async()=>{expired=true;await review();await page.waitForFunction(()=>document.querySelector('[data-receipt]').textContent.includes('Review expired'));assert.equal(await page.locator('[data-trade=sign]').count(),0);});
  await clean();
  await check('API failures expose localized retry state',async()=>{apiFailure=true;await page.locator('[data-trade=refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Simulation or RPC request failed'));assert.equal(await page.locator('[data-status]').getAttribute('role'),'alert');});
  await clean();
  await check('Spanish error explains actual gas problem and recovery',async()=>{await page.evaluate(()=>{fixture.lang='es';document.documentElement.lang='es';screen.invalidate();});apiFailure='gas';await page.locator('[data-trade=refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('ETH nativo insuficiente'));assert.doesNotMatch(await text(),/Insufficient native/);});
  await clean();
  await check('wallet/account change discards stale quote response',async()=>{deferQuote={};await page.locator('[name=amount]').fill('1');await page.locator('[data-review]').click();const start=Date.now();while(!deferQuote.resolve){if(Date.now()-start>10000)throw new Error('Deferred quote never requested: '+await text());await new Promise(r=>setTimeout(r,10));}await page.evaluate(()=>{fixture.account='0x3333333333333333333333333333333333333333';screen.invalidate();});deferQuote.resolve();await page.waitForFunction(()=>!document.querySelector('[data-review]').disabled);assert.equal(await page.locator('[data-trade=sign]').count(),0);});
  await clean();
  await check('submitted transaction survives remount and confirms actual output',async()=>{await review();await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-trade=confirm]'));assert.equal(await page.locator('[data-review]').isDisabled(),true);await page.evaluate(()=>screen.mount(document.querySelector('#trading'),coin));await page.waitForFunction(()=>!document.querySelector('[data-trade=confirm]').disabled);confirmed=true;await page.locator('[data-trade=confirm]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Trade confirmed'));assert.match(await text(),/Router output: 123.45 TEST/);});
  await clean();
  await check('replacement cancellation clears pending only after verified response',async()=>{await review();await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-trade=confirm]')?.disabled===false);await page.locator('[data-replace-details] summary').click();await page.locator('[data-recovery]').fill('0x'+'11'.repeat(32));cancelled=true;await page.locator('[data-trade=replace]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Cancellation confirmed'));assert.equal(await page.locator('[data-review]').isDisabled(),false);});
  await clean();
  await check('navigation during signing preserves original wallet recovery hash',async()=>{await review();await page.evaluate(()=>fixture.mode='delay');await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>typeof resolveSend==='function');await page.evaluate(()=>{fixture.account='0x3333333333333333333333333333333333333333';screen.invalidate();resolveSend();});await page.waitForFunction(()=>!document.querySelector('[data-review]').disabled);assert.equal(await page.evaluate(({account,token})=>JSON.parse(localStorage.getItem('plugged.trade.'+account+'.'+token)).txHash,{account,token}),hash);assert.equal(await page.locator('[data-trade=confirm]').count(),0);});
  await clean();
  await check('missing hash recovery and explicit unsent clear work',async()=>{await review();const id=[...records.keys()].at(-1);await page.evaluate(({id,account,token})=>{localStorage.setItem('plugged.trade.'+account+'.'+token,JSON.stringify({id,account,token}));screen.invalidate();},{id,account,token});await page.locator('[data-recovery]').fill(hash);confirmed=true;await page.locator('[data-trade=recover]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Trade confirmed'));await page.evaluate(({id,account,token})=>{localStorage.setItem('plugged.trade.'+account+'.'+token,JSON.stringify({id,account,token}));screen.invalidate();},{id,account,token});await page.locator('[data-trade=clear]').click();assert.equal(await page.locator('[data-trade=recover]').count(),0);});
  await clean();
  await check('failed recovery preserves entered hash',async()=>{await review();const id=[...records.keys()].at(-1);await page.evaluate(({id,account,token})=>{localStorage.setItem('plugged.trade.'+account+'.'+token,JSON.stringify({id,account,token}));screen.invalidate();},{id,account,token});await page.locator('[data-recovery]').fill(hash);apiFailure=true;await page.locator('[data-trade=recover]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Simulation or RPC request failed'));assert.equal(await page.locator('[data-recovery]').inputValue(),hash);});
  await clean();
  // Supplemental visual evidence for reviewer-requested interaction states.
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{fixture.lang='es';document.documentElement.lang='es';document.documentElement.dataset.theme='dark';screen.invalidate();});
  stage='approve';await review();await page.screenshot({path:join(output,'trading-390-dark-es-approval.png'),fullPage:true});
  await page.locator('[data-trade=sign]').click();await page.waitForFunction(()=>document.querySelector('[data-trade=confirm]')?.disabled===false);
  await page.locator('[data-replace-details] summary').click();await page.locator('[data-recovery]').fill(hash);
  apiFailure='gas';await page.locator('[data-trade=replace]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('ETH nativo insuficiente'));
  await page.screenshot({path:join(output,'trading-390-dark-es-recovery-error.png'),fullPage:true});
  await clean();await page.locator('[name=side]').selectOption('sell');await review();await page.screenshot({path:join(output,'trading-390-dark-en-sell.png'),fullPage:true});
  await clean();
  await check('empty market and destruction do not leave live controls',async()=>{await page.evaluate(()=>screen.mount(document.querySelector('#trading'),null));assert.match(await text(),/Select a confirmed Plugged/);await page.evaluate(()=>screen.destroy());assert.equal(await page.locator('#trading button').count(),0);});
  assert.deepEqual(errors,[],'browser errors');
  assert.deepEqual(await page.evaluate(()=>cspViolations),[],'Content Security Policy violations');
  checks.push('style-src self enforced without inline-style violations');
  const violations=audits.flatMap(r=>r.violations),skipped=audits.flatMap(r=>r.skipped);
  await writeFile(join(output,'browser-results.json'),JSON.stringify({checks,errors,audits,bundleBytes:Buffer.byteLength(js)},null,2));
  console.log(JSON.stringify({checks:checks.length,runtimeErrors:errors.length,a11yStates:audits.length,a11yViolations:violations.length,a11ySkipped:skipped.length,bundleBytes:Buffer.byteLength(js),output},null,2));
  if(violations.length||skipped.length){console.log(JSON.stringify(audits.filter(r=>r.violations.length||r.skipped.length),null,2));process.exitCode=1;}
}finally{await browser.close();server.closeAllConnections();server.close();}
