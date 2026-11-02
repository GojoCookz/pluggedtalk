import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const engine = process.env.ACCESSLINT_ENGINE || 'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js';
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const output = new URL('../artifacts/',import.meta.url); await mkdir(output,{recursive:true});
const results=[];
try {
  for(const [width,height] of [[390,844],[1440,1000]]) {
    const context=await browser.newContext({viewport:{width,height},bypassCSP:true,reducedMotion:'reduce'});
    const page=await context.newPage();
    await page.goto(process.env.PLUGGED_URL||'http://localhost:4317',{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'The first connection is yours.'}).waitFor();
    await page.addScriptTag({path:engine});
    for(const theme of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#theme').click();
      for(const route of ['discover','create','planner','earnings','assets','guide']) {
        await page.evaluate(route=>{location.hash=route;},route);
        if(route==='planner')await page.locator('#create-form').waitFor();else await page.waitForFunction(route=>document.querySelector(`.desktop-nav a[href="#${route}"]`)?.getAttribute('aria-current')==='page',route);
        if(route==='assets')await page.locator('.asset-card').first().waitFor();
        if(route==='planner')for(const name of ['communityEnabled','fundraisingEnabled','cashbackEnabled','charityEnabled','hybridEnabled'])await page.locator(`[name=${name}]`).check();
        const result=await page.evaluate(()=>{AccessLint.clearAllCaches();const result=AccessLint.runAudit(document);return JSON.parse(JSON.stringify(result,(key,value)=>key==='element'?undefined:value));});
        results.push({width,theme,route,ruleCount:result.ruleCount,skippedRules:result.skippedRules,violations:result.violations});
        if(route==='planner'){
          await page.locator('[name=recipientKind]').first().selectOption('x');
          const curve=await page.evaluate(()=>{AccessLint.clearAllCaches();return JSON.parse(JSON.stringify(AccessLint.runAudit(document),(key,value)=>key==='element'?undefined:value));});
          results.push({width,theme,route:'create-social',ruleCount:curve.ruleCount,skippedRules:curve.skippedRules,violations:curve.violations});
        }
      }
    }
    await context.close();
  }
  await writeFile(new URL('accessibility.json',output),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(r=>({...r,violations:r.violations.map(v=>({ruleId:v.ruleId,impact:v.impact,selector:v.selector,message:v.message}))})),null,2));
  if(results.some(r=>r.violations.length||r.skippedRules.length))process.exitCode=1;
}finally{await browser.close();}
