import { mkdir,writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage(),checks=[],errors=[];
const base=process.env.PLUGGED_URL||'http://localhost:4317',output=new URL('../artifacts/',import.meta.url);await mkdir(output,{recursive:true});
page.on('pageerror',e=>errors.push(e.message));
const account='0x1111111111111111111111111111111111111111',hash='0x'+'12'.repeat(32),launcher='0xcc491f9962ca5545163ac425210b69e24ac29a96';
const shot=async name=>{await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});await page.screenshot({path:new URL(name+'.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});};
const status=()=>page.locator('#launch-status');
try{
  await page.goto(base+'/#create',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Launch your coin',exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('launch-mobile-light');checks.push('mobile launch layout fits 390px');
  await page.locator('#theme').click();await shot('launch-mobile-dark');await page.locator('#language').selectOption('es');await page.getByRole('heading',{name:'Lanza tu moneda'}).waitFor();checks.push('launch form supports light/dark and Spanish');
  await page.locator('#language').selectOption('en');await page.locator('#theme').click();
  await page.locator('[name=name]').fill('Browser fixture — not a launch');await page.locator('[name=symbol]').fill('FIXTURE');
  await page.locator('[name=imageCid]').fill('bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm');
  await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('[name=symbol]').inputValue(),'FIXTURE');checks.push('live draft survives reload');
  await page.evaluate(({account,hash})=>{
    const listeners={};window.testWallet={listeners,sent:[],chain:'0x1237',request:async({method,params})=>{
      if(method==='eth_requestAccounts'||method==='eth_accounts')return [account];if(method==='eth_chainId')return window.testWallet.chain;
      if(method==='eth_sendTransaction'){window.testWallet.sent.push(params[0]);return hash;}if(method==='eth_getTransactionReceipt')return {status:'0x1'};throw new Error(method);
    },on:(e,fn)=>listeners[e]=fn,removeListener:e=>delete listeners[e]};
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'mvp-fixture',name:'Simulated test wallet'},provider:window.testWallet}}));
  },{account,hash});
  await page.locator('#wallet').click();await page.getByRole('button',{name:'Simulated test wallet'}).click();
  let stage='approve',expired=false;
  await page.route('**/api/launches/prepare',async route=>{
    const input=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'12345678-1234-1234-1234-123456789abc',input,next:stage,balance:'10000000',allowance:'0',required:'1000000',fees:{platformVolumeBps:100},opening:{realisedMarketCap:'2500000000'},expiresAt:Date.now()+(expired?-1000:60000),approval:{from:account,to:input.quote,data:'0x12345678',value:'0x0',chainId:'0x1237'},transaction:{from:account,to:launcher,data:'0x12345678',value:'0x0',chainId:'0x1237'}})});
  });
  const review=()=>page.getByRole('button',{name:'Review launch',exact:true}).click();
  await review();await page.getByRole('button',{name:'Approve opening purchase',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#launch-status').textContent.startsWith('Approval confirmed'));
  assert.equal(await page.evaluate(()=>window.testWallet.sent.length),1);checks.push('approval signs separate transaction and requires fresh review');
  await page.route('**/api/launches/funding',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({outputAmount:'2230000',minimumOutput:'2218850',expiresAt:new Date(Date.now()+30000).toISOString(),transaction:{from:account,to:'0xb477751b76cf82d00a686a1232f5fcd772414af3',chainId:'0x1237',data:'0x12345678',value:'0x38d7ea4c68000'}})}));
  await page.getByText('Fund with ETH',{exact:true}).click();await page.getByRole('button',{name:'Review ETH swap',exact:true}).click();await page.getByRole('button',{name:'Sign ETH funding swap',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#launch-status').textContent.startsWith('Funding confirmed'));
  assert.equal((await page.evaluate(()=>window.testWallet.sent.at(-1))).value,'0x38d7ea4c68000');checks.push('ETH funding is a separate explicit wallet transaction');
  stage='launch';await review();await page.getByRole('button',{name:'Sign launch transaction'}).waitFor();await page.locator('[name=feeBps]').fill('300');assert.equal(await page.locator('[data-live=launch]').count(),0);checks.push('editing economics invalidates signable preparation');
  expired=true;await review();await page.getByRole('button',{name:'Sign launch transaction'}).click();await page.getByText('Review expired. Review again before signing.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.testWallet.sent.length),2);checks.push('expired preparation never opens wallet signing');
  expired=false;await review();await page.evaluate(()=>{window.testWallet.chain='0x1';window.testWallet.listeners.chainChanged('0x1');});assert.equal(await page.locator('[data-live=launch]').count(),0);await review();await page.waitForFunction(()=>document.querySelector('#launch-status').textContent.includes('Switch to Robinhood'));checks.push('wrong chain and chain changes block signing');
  await page.evaluate(()=>{window.testWallet.chain='0x1237';window.testWallet.listeners.chainChanged('0x1237');});
  await page.route('**/api/launches/submit',route=>route.fulfill({status:200,contentType:'application/json',body:'{"status":"submitted"}'}));
  await review();await page.getByRole('button',{name:'Sign launch transaction'}).click();await page.waitForFunction(()=>localStorage.getItem('plugged.pendingLaunch')!==null);
  assert.equal((await page.evaluate(()=>window.testWallet.sent.at(-1))).to,launcher);await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'Check confirmation'}).waitFor();checks.push('launch hash persists and resumes after reload');
  await page.unroute('**/api/launches/submit');await page.route('**/api/launches/submit',route=>route.fulfill({status:200,contentType:'application/json',body:'{"status":"confirmed"}'}));
  await page.getByRole('button',{name:'Check confirmation'}).click();await page.waitForFunction(()=>localStorage.getItem('plugged.pendingLaunch')===null);checks.push('confirmed launch clears pending recovery record');
  await page.evaluate(()=>localStorage.setItem('plugged.launchRecoveryId','12345678-1234-1234-1234-123456789abc'));await page.reload({waitUntil:'networkidle'});
  await page.getByText('Recover a sent launch',{exact:true}).click();await page.locator('#recovery-hash').fill(hash);await page.getByRole('button',{name:'Check this transaction'}).click();await page.waitForFunction(()=>localStorage.getItem('plugged.launchRecoveryId')===null);checks.push('manual hash recovery works without another signature');
  await page.setViewportSize({width:1440,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('launch-desktop-light');
  await page.locator('#theme').click();await shot('launch-desktop-dark');checks.push('desktop launch layout fits 1440px');
  assert.deepEqual(errors,[]);await writeFile(new URL('launch-browser-check.json',output),JSON.stringify({checks,errors,transactions:'Simulated browser wallet only. Real deployed contracts tested separately on a pinned fork.'},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser.close();}
