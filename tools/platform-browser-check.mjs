import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {account,otherAccount,token,cid,installMockWallet,mockPlatform} from '../test/platform-ui-fixtures.mjs';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const engine=process.env.ACCESSLINT_ENGINE||'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js';
const engineSource=await readFile(engine,'utf8');
const base=process.env.PLUGGED_URL||'http://127.0.0.1:4327';
const serverKind=process.env.PLUGGED_UI_SERVER_KIND||'isolated-adapter';
const output=new URL('../artifacts/platform/',import.meta.url);await mkdir(output,{recursive:true});
const checks=[],audits=[],screenshots=[],errors=[],network=[];let evidencePage,productionConfig=null;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
evidencePage=page;
await context.addInitScript(()=>{window.policyViolations=[];document.addEventListener('securitypolicyviolation',e=>policyViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
const check=(label)=>checks.push(label);
async function shot(page,name){await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});const path=fileURLToPath(new URL(name+'.png',output));await page.screenshot({path,fullPage:true});screenshots.push(path);}
async function audit(page,label){
  await page.waitForFunction(()=>!document.querySelector('[data-program-action=refresh]')?.disabled);
  if(!await page.evaluate(()=>Boolean(window.AccessLint)))await page.evaluate(engineSource);
  const result=await page.evaluate(()=>{AccessLint.clearAllCaches();return JSON.parse(JSON.stringify(AccessLint.runAudit(document),(key,value)=>key==='element'?undefined:value));});
  audits.push({label,ruleCount:result.ruleCount,skippedRules:result.skippedRules,violations:result.violations});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');
}
async function go(route){await page.evaluate(route=>{location.hash=route;},route);await page.waitForFunction(route=>location.hash==='#'+route,route);}
const button=(name)=>page.getByRole('button',{name,exact:true});
const countSent=()=>page.evaluate(()=>testWallet.sent.length);
async function emit(event,value){await page.evaluate(({event,value})=>testWallet.emit(event,value),{event,value});}
async function connect(){await page.locator('#wallet').click();await button('Browser wallet').click();await page.waitForFunction(()=>document.querySelector('#wallet').getAttribute('aria-label').startsWith('Disconnect'));}
try{
  if(!process.env.PLUGGED_UI_REAL_ONLY){
  await installMockWallet(page);const state=await mockPlatform(page);
  await page.goto(base+'/#discover',{waitUntil:'networkidle'});
  await page.locator('.coin').click();await page.locator('[data-form]').waitFor();
  await shot(page,'mock-trading-mobile-light');await audit(page,'mock trading mobile light');
  await page.locator('[data-review]').click();await button('Browser wallet').click();
  await page.locator('[name=amount]').fill('1');await button('Review trade').click();await button('Approve exact input').click();
  await page.getByText('Approval confirmed. Review again for a fresh output quote.',{exact:true}).waitFor();assert.equal(await countSent(),1);check('Trading exact approval is separate; fresh review required');
  await button('Review trade').click();await button('Sign trade').waitFor();
  await page.locator('[name=amount]').fill('2');assert.equal(await button('Sign trade').count(),0);check('Trading amount edit invalidates preparation');
  await button('Review trade').click();await button('Sign trade').waitFor();await emit('accountsChanged',[otherAccount]);assert.equal(await button('Sign trade').count(),0);
  await emit('accountsChanged',[account]);await button('Review trade').click();await button('Sign trade').waitFor();await emit('chainChanged','0x1');assert.equal(await button('Sign trade').count(),0);
  await emit('chainChanged','0x1237');await button('Review trade').click();await button('Sign trade').click();await page.getByText(/Trade confirmed\. Router output/).waitFor();assert.equal(await countSent(),2);check('Trading account/chain invalidation and buy confirmation');
  await page.locator('[name=side]').selectOption('sell');await page.locator('[name=amount]').fill('1');await button('Review trade').click();await button('Sign trade').click();await page.getByText(/Trade confirmed\. Router output/).waitFor();assert.equal(await countSent(),3);check('Trading sell review and confirmation');
  await button('Refresh balances').click();await page.getByText('Balances updated from Robinhood Chain.',{exact:true}).waitFor();
  await page.getByText('Slippage and review validity',{exact:true}).click();await page.locator('[name=slippageBps]').fill('75');await page.locator('[name=reviewSeconds]').fill('90');
  await button('Review trade').click();await button('Sign trade').waitFor();await page.getByText('Verify contract addresses',{exact:true}).click();
  await page.locator('#wallet').click();assert.equal(await button('Sign trade').count(),0);check('Disconnect clears prepared trading transaction');
  await connect();await page.locator('.mobile-nav a[href="#earnings"]').click();await page.locator('#rewards-screen').waitFor();
  await button('Refresh balances').click();await button('Claim holder rewards').waitFor();await audit(page,'mock rewards mobile light');
  await button('Claim holder rewards').click();await button('Sign in wallet').waitFor();await button('Cancel review').click();assert.equal(await button('Sign in wallet').count(),0);
  await button('Claim holder rewards').click();await button('Sign in wallet').waitFor();await emit('accountsChanged',[otherAccount]);assert.equal(await button('Sign in wallet').count(),0);
  await emit('accountsChanged',[account]);await button('Refresh balances').click();await button('Claim holder rewards').click();await button('Sign in wallet').click();await page.getByText('Payment verified on-chain. Refresh balances.',{exact:true}).waitFor();check('Rewards cancel, account invalidation, holder claim and exact confirmation');
  for(const [action,creator] of [['Sweep creator fees',true],['Sweep pool fees',false]]){state.rewardCreator=creator;await button('Refresh balances').click();await button(action).click();await button('Sign in wallet').click();await page.getByText('Payment verified on-chain. Refresh balances.',{exact:true}).waitFor();}
  state.withSplitter=true;await button('Refresh balances').click();await button('Pay fixed recipient').click();await page.locator('#reward-review').getByText(otherAccount,{exact:true}).waitFor();await button('Sign in wallet').click();await page.getByText('Payment verified on-chain. Refresh balances.',{exact:true}).waitFor();state.withSplitter=false;
  check('Creator/pool sweep and verified fixed-recipient release operate with distinct destinations');
  await button('Refresh balances').click();await button('Claim holder rewards').click();await button('Sign in wallet').waitFor();await emit('chainChanged','0x1');assert.equal(await button('Sign in wallet').count(),0);await emit('chainChanged','0x1237');
  await button('Refresh balances').click();await button('Claim holder rewards').click();await button('Sign in wallet').waitFor();await page.locator('#wallet').click();assert.equal(await button('Sign in wallet').count(),0);await connect();check('Rewards chain changes and disconnect clear review');
  await page.locator('[name=username]').fill('browser-test');await button('Resolve payout address').click();await page.getByText('TEST: social provider unconfigured',{exact:true}).waitFor();check('Social-provider failure shown without fabricated identity');
  await page.locator('#language').selectOption('es');await page.getByRole('heading',{name:'Tus recompensas'}).waitFor();await page.locator('#theme').click();await shot(page,'mock-rewards-mobile-dark-es');await audit(page,'mock rewards mobile dark Spanish');
  await page.locator('#language').selectOption('en');await page.locator('#theme').click();
  await page.locator('.mobile-nav a[href="#programs"]').click();await page.locator('[name=program]').waitFor();await page.locator('[name=amount]').fill('1');await button('Review contribution').click();await button('Sign approval').click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();
  await button('Review contribution').click();await button('Sign transaction').waitFor();await emit('chainChanged','0x1');assert.equal(await button('Sign transaction').count(),0);await emit('chainChanged','0x1237');
  await page.locator('[name=amount]').waitFor();await page.locator('[name=amount]').fill('1');await button('Review contribution').click();await button('Sign transaction').click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();check('Programs exact approval, chain invalidation and contribution confirmation');
  for(const [id,label] of [['failed','Review my refund'],['successful','Review beneficiary payout']]){await page.locator('[name=program]').selectOption(id);await button(label).click();await button('Sign transaction').click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();}
  check('Failed-goal refund and fixed beneficiary payout controls operate');
  await button('Review beneficiary payout').click();await button('Sign transaction').waitFor();await emit('accountsChanged',[otherAccount]);assert.equal(await button('Sign transaction').count(),0);await emit('accountsChanged',[account]);
  await button('Review beneficiary payout').click();await button('Sign transaction').waitFor();await page.locator('#wallet').click();assert.equal(await button('Sign transaction').count(),0);await connect();check('Programs account change and disconnect clear review');
  await page.locator('[name=program]').selectOption('cashback');await button('Fetch verified voucher').click();await page.locator('[name=voucher]').waitFor();await button('Verify & review cashback').click();await button('Sign transaction').click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();
  await page.getByText('Add separate cashback funding',{exact:true}).click();await page.locator('[name=amount]').fill('1');await button('Review funding').click();await button('Sign transaction').click();await page.getByText('Confirmed on-chain. Refresh to review the next action.',{exact:true}).waitFor();check('Cashback voucher review, claim and separate funding controls operate');
  await audit(page,'mock cashback mobile light');await shot(page,'mock-programs-mobile-light');
  await page.locator('.mobile-nav a[href="#create"]').click();await page.locator('#live-form').waitFor();await page.locator('[name=name]').fill('BROWSER TEST ONLY');await page.locator('[name=symbol]').fill('TEST');await page.locator('[name=imageCid]').fill(cid);
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=32;const ctx=c.getContext('2d');ctx.fillStyle='#087b46';ctx.fillRect(0,0,32,32);return c.toDataURL('image/png').split(',')[1];});
  const file={name:'browser-test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
  await page.locator('[data-node=file]').setInputFiles(file);await button('Upload image').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-media-action=upload]').disabled);
  await button('Review launch').click();await button('Sign launch transaction').waitFor();assert.equal(await page.locator('[data-node=preview]').isVisible(),true);
  await button('Upload image').click();await page.getByText('Image pinned. Image CID is ready for your launch.',{exact:true}).waitFor();assert.equal(await page.locator('[name=imageCid]').inputValue(),cid);assert.equal(await button('Sign launch transaction').count(),0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('plugged.liveDraft')).imageCid),cid);check('Upload fills and persists CID, invalidates launch review, preserves uploader across receipt updates');
  await button('Clear selection').click();assert.equal(await page.locator('[name=imageCid]').inputValue(),cid);
  state.mediaFail=true;await page.locator('[data-node=file]').setInputFiles(file);await page.waitForFunction(()=>!document.querySelector('[data-media-action=upload]').disabled);await button('Upload image').click();await page.getByText('The provider did not confirm a valid pin. Retry or paste an existing image CID.',{exact:true}).waitFor();state.mediaFail=false;
  let releaseUpload;state.mediaDelay=new Promise(resolve=>releaseUpload=resolve);await button('Upload image').click();await button('Cancel upload').click();releaseUpload();state.mediaDelay=null;await page.getByText('Upload cancelled. A pin already accepted by the provider may remain.',{exact:true}).waitFor();check('Media provider failure and cancellation preserve manual CID');
  state.mediaDelay=new Promise(resolve=>releaseUpload=resolve);await button('Upload image').click();await button('Review launch').click();await page.getByText('Wait for the image upload or cancel it before continuing.',{exact:true}).waitFor();assert(await button('Cancel upload').isEnabled());
  const manualCid='bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';await page.locator('[name=imageCid]').fill(manualCid);releaseUpload();state.mediaDelay=null;await page.waitForFunction(()=>!document.querySelector('[data-node=file]').disabled);assert.equal(await page.locator('[name=imageCid]').inputValue(),manualCid);check('Manual CID edit cancels stale upload; upload never blocks its cancel control');
  await page.locator('[data-node=file]').setInputFiles({name:'wrong.jpg',mimeType:'image/jpeg',buffer:Buffer.from('not a png')});await page.getByText('Use a noninterlaced 8-bit RGB or RGBA PNG. Export your image as PNG and retry.',{exact:true}).waitFor();await button('Clear selection').click();check('Invalid upload type rejected before network pinning');
  await button('Review launch').click();await button('Sign launch transaction').waitFor();await page.locator('#theme').click();assert.equal(await button('Sign launch transaction').count(),0);await page.locator('#theme').click();check('Theme remount invalidates launch review');
  for(const [event,value,restore] of [['accountsChanged',[otherAccount],[account]],['chainChanged','0x1','0x1237']]){await button('Review launch').click();await button('Sign launch transaction').waitFor();await emit(event,value);assert.equal(await button('Sign launch transaction').count(),0);await emit(event,restore);}
  await button('Review launch').click();await button('Sign launch transaction').waitFor();await page.locator('#wallet').click();assert.equal(await button('Sign launch transaction').count(),0);await connect();check('Launch account, chain and disconnect invalidate all prepared transactions');
  let releaseLaunch;state.launchDelay=new Promise(resolve=>releaseLaunch=resolve);await button('Review launch').click();await go('guide');await page.getByRole('heading',{name:'Simple on the surface. Clear underneath.'}).waitFor();releaseLaunch();state.launchDelay=null;await go('create');await page.locator('#live-form').waitFor();await page.waitForFunction(()=>!document.querySelector('#live-form button[type=submit]').disabled);assert.equal(await button('Sign launch transaction').count(),0);check('Late launch review after navigation cannot restore signable transaction');
  await page.locator('#language').selectOption('es');await page.getByRole('heading',{name:'Lanza tu moneda'}).waitFor();await audit(page,'mock launch mobile Spanish');await page.locator('#language').selectOption('en');
  await page.locator('.mobile-nav a[href="#assets"]').click();await page.locator('#asset-filter').selectOption('all');await page.locator('#asset-search').fill('test');await button('Refresh').click();
  await go('guide');await page.getByRole('heading',{name:'Simple on the surface. Clear underneath.'}).waitFor();for(const summary of await page.locator('.guide summary').all())await summary.click();
  await page.locator('.skip').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'main');assert.equal(await page.evaluate(()=>location.hash),'#guide');check('Guide disclosure, asset filters, navigation and skip-link keyboard behavior');
  await page.setViewportSize({width:1440,height:1000});await go('programs');await page.locator('[name=program]').waitFor();await shot(page,'mock-programs-desktop-light');await audit(page,'mock programs desktop light');await page.locator('#theme').click();await audit(page,'mock programs desktop dark');
  await go('token/'+token);await page.locator('[data-form]').waitFor();await audit(page,'mock trading desktop dark');await shot(page,'mock-trading-desktop-dark');
  await go('token/0x5555555555555555555555555555555555555555');await page.getByRole('heading',{name:'Token not found in this sample'}).waitFor();assert.equal(await page.locator('[data-form]').count(),0);check('Unlisted address cannot mount trading');
  assert.deepEqual(state.unexpected,[]);assert.deepEqual(errors,[]);
  const blocked=await page.evaluate(()=>policyViolations);if(blocked.length)errors.push(`Production CSP blocked ${blocked.length} inline styles/scripts: ${[...new Set(blocked.map(v=>v.directive))].join(', ')}`);
  }

  // Real server responses, no route interception and no injected wallet.
  const mediaStatus=await fetch(base+'/api/media/status');assert.equal(mediaStatus.status,200,'Real media status HTTP route must be wired');assert.equal((await mediaStatus.json()).available,false,'Use an unconfigured server for this suite');
  const programStatus=await fetch(base+'/api/programs');assert.equal(programStatus.status,200,'Real programs HTTP route must be wired');assert.equal((await programStatus.json()).status,'undeployed','Use an unconfigured server for this suite');
  if(serverKind==='production'){
    const configResponse=await fetch(base+'/api/config');assert.equal(configResponse.status,200);
    const config=await configResponse.json();assert.equal(typeof config.launchEnabled,'boolean');assert.equal(typeof config.programsEnabled,'boolean');
    productionConfig={launchEnabled:config.launchEnabled,programsEnabled:config.programsEnabled};
    // Probe disabled gates only; an enabled server must never receive a live preparation from this suite.
    const disabledRoutes=[...(!config.launchEnabled?['trading/prepare','rewards/prepare']:[]),...(!config.programsEnabled?['programs/prepare','programs/voucher']:[])];
    for(const path of disabledRoutes){
      const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',origin:base},body:'{}'});
      const body=await response.json();assert.equal(response.status,503,path+' signing gate');assert.equal(typeof body.error,'string');
    }
    const pin=await fetch(base+'/api/media/pin',{method:'POST',headers:{'content-type':'application/json',origin:base},body:'{}'});
    const failure=await pin.json();assert.equal(pin.status,503);assert.equal(failure.code,'unavailable');
    check(`Production HTTP media/program reads, ${disabledRoutes.length} disabled preparation gates and safe media error contract; enabled preparations not invoked`);
  }
  const real=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await real.addInitScript(()=>{window.policyViolations=[];document.addEventListener('securitypolicyviolation',e=>policyViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
  const live=await real.newPage();live.on('pageerror',e=>errors.push(e.message));
  evidencePage=live;live.on('request',r=>network.push('request '+r.url()));live.on('requestfinished',r=>network.push('finished '+r.url()));live.on('requestfailed',r=>network.push('failed '+r.url()+' '+r.failure()?.errorText));
  await live.goto(base+'/#create',{waitUntil:'domcontentloaded'});await live.getByText('Image uploads are unavailable. Paste an existing image CID instead.',{exact:true}).waitFor();await live.waitForLoadState('networkidle',{timeout:60000});
  await shot(live,'real-unconfigured-launch-mobile-light');await audit(live,'real unconfigured launch mobile light');
  await live.getByRole('button',{name:'Check availability again',exact:true}).click();await live.getByText('Image uploads are unavailable. Paste an existing image CID instead.',{exact:true}).waitFor();
  await live.locator('.mobile-nav a[href="#programs"]').click();await live.getByRole('heading',{name:'No verified programs available'}).waitFor();await shot(live,'real-unconfigured-programs-mobile-light');await audit(live,'real unconfigured programs mobile light');
  await live.locator('#language').selectOption('es');await live.locator('#theme').click();await live.getByRole('heading',{name:'No hay programas verificados disponibles'}).waitFor();await shot(live,'real-unconfigured-programs-mobile-dark-es');await audit(live,'real unconfigured programs mobile dark Spanish');
  await live.setViewportSize({width:1440,height:1000});await shot(live,'real-unconfigured-programs-desktop-dark-es');await audit(live,'real unconfigured programs desktop dark Spanish');
  await live.locator('#language').selectOption('en');await live.locator('#theme').click();await live.locator('.desktop-nav a[href="#earnings"]').click();await live.getByRole('heading',{name:'Your rewards'}).waitFor();await audit(live,'real disconnected rewards desktop light');await shot(live,'real-disconnected-rewards-desktop-light');
  check('Real unconfigured media/programs and disconnected rewards verified in EN/ES light/dark mobile/desktop');
  assert.deepEqual(await live.evaluate(()=>policyViolations),[],'Production CSP must not block real unconfigured screens');
  await real.close();
  assert.deepEqual(errors,[]);assert.equal(audits.reduce((n,a)=>n+a.violations.length+a.skippedRules.length,0),0,'Accessibility violations or skipped rules');
  console.log(JSON.stringify({checks:checks.length,audits:audits.length,errors,screenshots:screenshots.length}));
}catch(error){errors.push(error.stack);if(!evidencePage.isClosed())await shot(evidencePage,'failure');throw error;}
finally{await writeFile(new URL('report.json',output),JSON.stringify({checks,audits,screenshots,errors,network,base,serverKind,productionConfig,scope:`Mock active flows use explicitly simulated browser API and wallet. Unconfigured screenshots use real service responses from ${serverKind==='production'?'the actual server.ts production HTTP server':'the isolated test adapter (test/platform-ui-server.ts)'}, without route interception or injected wallet. Active-flow mocks do not establish successful production transaction routing. No chain broadcast or paid upload.`},null,2));await browser.close();}
