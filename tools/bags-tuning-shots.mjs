// Evidence screenshots for workstreams/bags-comparison.md. Simulated fixtures only; no RPC writes.
import {mkdir,readFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {account,coin,market,positions,installMockWallet} from '../test/platform-ui-fixtures.mjs';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const base=process.env.PLUGGED_URL||'http://127.0.0.1:4328',prefix=process.env.SHOT_PREFIX||'after';
const output=new URL('../artifacts/bags-tuning/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const fixtureCoin={...coin,feeBps:200,creatorBps:7500,feeRecipient:account};
const zero=positions(account);zero.positions=zero.positions.map(p=>({...p,holderClaimable:'0',pendingQuote:'0',pendingToken:'0',actions:{holder:false,creator:false,sweep:false}}));
const shots=[],audits=[];
const engineSource=await readFile(process.env.ACCESSLINT_ENGINE||'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js','utf8');
try{
  for(const [w,h,tag] of [[390,844,'mobile'],[1440,1000,'desktop']]){
    const context=await browser.newContext({viewport:{width:w,height:h},reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);
    await context.addInitScript(()=>localStorage.setItem('plugged.welcomed','true'));
    await installMockWallet(page);
    await page.route('**/api/markets',r=>r.fulfill({json:{...market,tokens:[fixtureCoin]}}));
    await page.route('**/api/rewards/positions',r=>r.fulfill({json:zero}));
    const shot=async name=>{
      if(prefix==='after'){await page.evaluate(engineSource);const v=await page.evaluate(()=>{AccessLint.clearAllCaches();const r=AccessLint.runAudit(document);return r.violations.map(x=>x.ruleId+' '+(x.selector||''));});audits.push({name,tag,violations:v});}
      const path=fileURLToPath(new URL(`${prefix}-${name}-${tag}.png`,output));await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});await page.screenshot({path,fullPage:true});shots.push(path);};
    await page.goto(base+'/#create',{waitUntil:'networkidle'});await shot('create');
    if(prefix==='after'){
      const field=page.locator('[name=feeRecipient]');await field.fill('0x123');assert.equal(await field.evaluate(e=>e.validity.patternMismatch),true);await field.fill('');
      await page.getByRole('link',{name:'Terms',exact:true}).first().click();await page.waitForFunction(()=>location.hash==='#terms');
    }
    await page.goto(base+'/#token/'+coin.address,{waitUntil:'networkidle'});await shot('token');
    if(prefix==='after'){await page.getByRole('heading',{name:'Who earns from trades'}).waitFor();if(tag==='mobile'){await page.locator('#theme').click();await shot('token-dark');await page.locator('#theme').click();}}
    if(tag==='mobile'){
      await page.goto(base+'/#earnings',{waitUntil:'networkidle'});await page.locator('#wallet').click();await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
      if(prefix==='after')await page.getByText('Nothing to claim yet. Balances grow as people trade this coin.').waitFor();
      else{await page.locator('[data-reward=refresh]').click();await page.waitForTimeout(800);}
      await shot('earnings');
    }
    await context.close();
  }
  console.log(JSON.stringify({prefix,shots:shots.length,audits}));
  assert.equal(audits.reduce((n,a)=>n+a.violations.length,0),0,'AccessLint violations');
}finally{await browser.close();}
