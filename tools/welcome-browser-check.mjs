// Browser check for the first-visit sign-in screen (#welcome) against a running server.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const engineSource=await readFile(process.env.ACCESSLINT_ENGINE||'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js','utf8');
const base=process.env.PLUGGED_URL||'http://127.0.0.1:4327',output=new URL('../artifacts/welcome/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const checks=[],errors=[],audits=[];
const account='0x1111111111111111111111111111111111111111';
async function open({width,height,theme,language,wallet=false,expand=true}){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  await context.addInitScript(({theme,language,wallet,account})=>{
    localStorage.setItem('plugged.theme',JSON.stringify(theme));localStorage.setItem('plugged.language',JSON.stringify(language));
    if(wallet){const provider={request:async({method})=>method==='eth_requestAccounts'?[account]:method==='eth_chainId'?'0x1237':null,on(){},removeListener(){}};
      const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:Object.freeze({info:{uuid:'test-wallet',name:'TEST wallet',icon:'data:,',rdns:'test.wallet'},provider})}));
      window.addEventListener('eip6963:requestProvider',announce);}
  },{theme,language,wallet,account});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(base+'/',{waitUntil:'networkidle'});
  assert.equal(new URL(page.url()).hash,'#welcome');
  if(expand){await page.locator('[data-welcome-more]').click();await page.locator('#wl-more .wl-option').first().waitFor();}
  return {context,page};
}
async function audit(page,label){
  if(!await page.evaluate(()=>Boolean(window.AccessLint)))await page.evaluate(engineSource);
  const result=await page.evaluate(()=>{AccessLint.clearAllCaches();return JSON.parse(JSON.stringify(AccessLint.runAudit(document),(k,v)=>k==='element'?undefined:v));});
  audits.push({label,violations:result.violations.length});assert.equal(result.violations.length,0,`${label}: ${JSON.stringify(result.violations.map(v=>[v.ruleId,v.selector,v.html?.slice(0,120)]))}`);
}
async function fits(page){const r=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,small:[...document.querySelectorAll('.welcome button,.welcome a')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.height<44;}).length}));assert.ok(r.sw<=r.cw,'overflow');assert.equal(r.small,0,'targets under 44px');}
const shots=[['mobile-light-en',390,844,'light','en'],['mobile-dark-en',390,844,'dark','en'],['mobile-dark-ja',390,844,'dark','ja'],['desktop-dark-en',1440,1000,'dark','en'],['desktop-light-en',1440,1000,'light','en']];
for(const [name,width,height,theme,language] of shots){
  const {context,page}=await open({width,height,theme,language});
  assert.equal(await page.evaluate(()=>document.documentElement.lang),language);
  assert.equal(await page.locator('#wl-more button.wl-option:disabled').count(),7,'all providers disabled while none configured');
  await fits(page);await audit(page,name);
  await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,output)),fullPage:true});checks.push(name);await context.close();
}
{ // collapsed state, toggle via keyboard, browse link, footer links, returning visitor
  const {context,page}=await open({width:390,height:844,theme:'light',language:'en',expand:false});
  await audit(page,'collapsed');
  await page.locator('[data-welcome-more]').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-welcome-more]').getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Enter');assert.equal(await page.locator('#wl-more').isHidden(),true);checks.push('toggle keyboard');
  await page.getByRole('link',{name:'Terms'}).click();await page.getByRole('heading',{name:'Terms of use'}).waitFor();await audit(page,'terms');
  await page.locator('.legal .text-link').click();await page.getByRole('link',{name:'Privacy'}).click();await page.getByRole('heading',{name:'Privacy',level:1}).waitFor();await audit(page,'privacy');checks.push('terms+privacy');
  await page.goto(base+'/#welcome');await page.getByRole('link',{name:'Docs'}).click();await page.waitForFunction(()=>location.hash==='#guide');checks.push('docs');
  await page.goto(base+'/#welcome');await page.getByRole('link',{name:'Browse without signing in'}).click();await page.waitForFunction(()=>location.hash==='#discover');checks.push('browse');
  await page.goto(base+'/');await page.waitForLoadState('networkidle');assert.notEqual(new URL(page.url()).hash,'#welcome','returning visitor skips welcome');checks.push('returning visitor');
  await context.close();
}
{ // no wallet installed: honest dialog, close returns
  const {context,page}=await open({width:390,height:844,theme:'light',language:'en',expand:false});
  await page.getByRole('button',{name:'Connect wallet',exact:true}).last().click();await page.locator('#wallet-dialog[open]').waitFor();await audit(page,'wallet-dialog-empty');
  await page.locator('#close-wallet').click();checks.push('connect without wallet');await context.close();
}
{ // mock EIP-6963 wallet: connect lands on discover
  const {context,page}=await open({width:390,height:844,theme:'dark',language:'en',wallet:true,expand:false});
  await page.locator('[data-welcome-connect]').click();await page.getByRole('button',{name:'TEST wallet'}).click();
  await page.waitForFunction(()=>location.hash==='#discover');assert.match(await page.locator('#wallet').innerText(),/0x1111/);checks.push('connect wallet -> discover');await context.close();
}
await browser.close();
const report={base,checks,audits,errors};await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));assert.equal(errors.length,0,'console errors');
