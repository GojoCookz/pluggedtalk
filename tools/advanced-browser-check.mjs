// Browser check for the Advanced area. Run with Node against `bun test/advanced-ui-server.ts`
// (real services, simulated chain). The wallet is simulated in-page; personal_sign is a real
// EIP-191 signature from a throwaway test key, verified by the real server. Nothing is broadcast.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const engineSource = await readFile(process.env.ACCESSLINT_ENGINE || 'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js', 'utf8');
const base = process.env.PLUGGED_URL || 'http://127.0.0.1:4331';
const output = new URL('../artifacts/advanced/', import.meta.url); await mkdir(output, { recursive: true });
const signer = privateKeyToAccount('0x' + '11'.repeat(32));
const checks = [], audits = [], shots = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
await context.exposeFunction('signForTest', hex => signer.signMessage({ message: { raw: hex } }));
await context.addInitScript(address => {
  localStorage.setItem('plugged.welcomed', 'true');
  window.policyViolations = []; document.addEventListener('securitypolicyviolation', e => policyViolations.push(e.effectiveDirective));
  window.ethereum = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'personal_sign') return window.signForTest(params[0]);
    throw Object.assign(new Error('unsupported'), { code: 4200 });
  }, on() {}, removeListener() {} };
}, signer.address);
const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
const check = label => checks.push(label);
async function shot(name) { await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); }); const path = fileURLToPath(new URL(name + '.png', output)); await page.screenshot({ path, fullPage: true }); shots.push(path); }
async function audit(label) {
  if (!await page.evaluate(() => Boolean(window.AccessLint))) await page.evaluate(engineSource);
  const result = await page.evaluate(() => { AccessLint.clearAllCaches(); return JSON.parse(JSON.stringify(AccessLint.runAudit(document), (k, v) => k === 'element' ? undefined : v)); });
  audits.push({ label, violations: result.violations });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ' horizontal overflow');
  const small = await page.evaluate(() => [...document.querySelectorAll('#main a, #main button, #main select, #main input, #main textarea')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.height < 44 && !el.closest('.address-block,.receipt-note,figcaption,p'); }).map(el => el.outerHTML.slice(0, 80)));
  assert.deepEqual(small, [], label + ' targets under 44px');
}
const go = async route => { await page.evaluate(r => { location.hash = r; }, route); await page.waitForFunction(r => location.hash === '#' + r, route); };

await page.goto(base + '/#advanced');
await page.waitForSelector('.tape li');
assert.equal(await page.locator('.desktop-nav [aria-current=page], .mobile-nav [aria-current=page]').first().getAttribute('href'), '#advanced'); check('nav marks Advanced current');
assert.equal(await page.locator('h1').innerText(), 'Advanced');
assert.ok(await page.locator('.rank li').count() >= 2); check('live feed: most active + new launches + trades');
await audit('live-390'); await shot('live-390');
await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.waitForSelector('.tape li'); check('live refresh');

await page.locator('.rank a', { hasText: 'BROWSER TEST Alpha' }).first().click();
await page.waitForSelector('.holders li'); await page.waitForSelector('.spark svg');
assert.match(await page.locator('h1').innerText(), /ALPHA/); check('coin page: chart, tape, holders');
assert.equal(await page.locator('.tape li').count(), 12);
await page.locator('[data-hub=more]').click(); assert.ok(await page.locator('.tape li').count() > 12); check('show more trades');
const watch = page.locator('[data-hub=watch]'); await watch.click(); assert.equal(await page.locator('[data-hub=watch]').getAttribute('aria-pressed'), 'true'); check('watch toggle');
await page.getByRole('button', { name: 'Connect wallet', exact: true }).last().click();
await page.locator('#wallet-options button').first().click();
await page.waitForSelector('[data-hub-form=callout] textarea');
await page.fill('[data-hub-form=callout] textarea', 'visit https://evil.example now');
await page.getByRole('button', { name: 'Sign and post' }).click();
await page.waitForFunction(() => /links/i.test(document.querySelector('[data-callout-status]')?.textContent || '')); check('link callout refused with message');
await page.fill('[data-hub-form=callout] textarea', 'ALPHA browser test callout: liquidity looks deep.');
await page.getByRole('button', { name: 'Sign and post' }).click();
await page.waitForSelector('.callouts li .callout-text');
assert.match(await page.locator('.callouts .callout-text').first().innerText(), /ALPHA browser test callout/);
assert.match(await page.locator('.callout-foot small').first().innerText(), /ALPHA/); check('signed callout posted with on-chain position');
await page.selectOption('[name=direction]', 'above'); await page.fill('[name=price]', '0.000000001');
await page.getByRole('button', { name: 'Set alert' }).click();
await page.waitForFunction(() => /reached/.test(document.querySelector('#notice')?.textContent || '')).catch(async e => { console.log(await page.evaluate(() => [document.querySelector('#notice')?.textContent, localStorage.getItem('plugged.priceAlerts'), document.querySelector('[data-hub-form=alert]')?.outerHTML?.slice(0, 200)])); throw e; }); check('price alert fired locally');
await audit('coin-390'); await shot('coin-390');
await page.locator('[data-hub=report]').first().click();
await page.waitForFunction(() => /Reported/.test(document.querySelector('#notice')?.textContent || '')); check('report callout');

await page.locator('.page-top + .hub-tabs').waitFor().catch(() => {});
await page.locator(`a[href="#advanced/creator/${signer.address.toLowerCase()}"]`).first().click();
await page.waitForSelector('h1:has-text("Creator")'); await page.waitForSelector('.rank li');
assert.ok(await page.locator('.rank li').count() === 2); check('creator profile lists launches');
await audit('creator-390'); await shot('creator-390');

await page.locator('.hub-tabs a', { hasText: 'Watchlist' }).click(); await page.waitForSelector('[data-hub=unwatch]'); check('watchlist shows watched coin');
await audit('watchlist-390'); await shot('watchlist-390');
await page.locator('[data-hub=unwatch]').click(); await page.waitForSelector('.empty'); check('watchlist remove -> empty state');

await page.locator('.hub-tabs a', { hasText: 'Callouts' }).click(); await page.waitForSelector('.callouts li'); check('callouts feed');
await audit('callouts-390'); await shot('callouts-390');

await page.locator('.hub-tabs a', { hasText: 'Launch' }).click(); await page.waitForSelector('#advanced-launch h1'); assert.equal(await page.locator('.hub-tabs [aria-current=page]').innerText(), 'Launch'); check('#advanced/launch keeps the launch form');
await go('create'); await page.locator('a[href="#advanced/launch"]').click(); await page.waitForSelector('#advanced-launch'); check('create links to #advanced/launch');

await go('advanced/coin/0x0000000000000000000000000000000000000fff'); await page.waitForSelector('.empty'); check('unknown coin shows honest empty state');
await go('advanced/coin/0x0000000000000000000000000000000000000b22'); await page.waitForSelector('.holders li');
await page.fill('[name=price]', '999999'); await page.getByRole('button', { name: 'Set alert' }).click(); await page.getByRole('button', { name: 'Clear alert' }).click(); await page.waitForSelector('[name=price]'); check('alert set and cleared');
  await page.locator('#theme').click(); await page.waitForSelector('.holders li'); await audit('coin-dark-390'); await shot('coin-dark-390'); check('dark mode coin');
await page.locator('#theme').click();
await page.selectOption('#language', 'de'); await page.waitForFunction(() => /Halter/.test(document.body.innerText)); check('German strings');
await page.selectOption('#language', 'en'); await page.waitForFunction(() => document.documentElement.lang === 'en');

await page.setViewportSize({ width: 1440, height: 1000 });
await go('advanced'); await page.waitForSelector('.tape li'); await audit('live-1440'); await shot('live-1440');
await go('advanced/coin/0x0000000000000000000000000000000000000a11'); await page.waitForSelector('.callouts li'); await audit('coin-1440'); await shot('coin-1440');

const violations = audits.reduce((n, a) => n + a.violations.length, 0), policy = await page.evaluate(() => window.policyViolations);
await writeFile(new URL('report.json', output), JSON.stringify({ base, checks, audits, errors, policy, shots }, null, 2));
await browser.close();
console.log(`${checks.length} checks, ${audits.length} AccessLint states, ${violations} violations, ${errors.length} page errors, ${policy.length} CSP violations`);
for (const a of audits) for (const v of a.violations) console.log(a.label, v.ruleId, v.selector ?? '', v.message ?? '');
if (violations || errors.length || policy.length) process.exit(1);
