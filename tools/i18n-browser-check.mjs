// Locale browser sweep: every route x viewport x locale against a running frontend
// (default: test/platform-ui-server.ts on 4327) with the mocked platform API. Checks <html lang>,
// the picker value, AccessLint violations, page and control overflow, console/page errors and CSP
// violations, then writes full-page screenshots plus one contact sheet per locale and viewport.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installMockWallet, mockPlatform } from '../test/platform-ui-fixtures.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const engineSource = await readFile(process.env.ACCESSLINT_ENGINE || 'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js', 'utf8');
const base = process.env.PLUGGED_URL || 'http://127.0.0.1:4327';
const locales = (process.env.LOCALES || 'en,es,de,ja,zh-CN,hi').split(',');
const routes = (process.env.ROUTES || 'discover,create,advanced,planner,earnings,programs,assets,guide,token/0x3333333333333333333333333333333333333333').split(',');
const viewports = [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }];
const output = new URL('../artifacts/i18n/', import.meta.url); await mkdir(output, { recursive: true });
const results = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  for (const vp of viewports) for (const code of locales) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
    await context.addInitScript(code => {
      localStorage.setItem('plugged.language', JSON.stringify(code));
      window.policyViolations = [];
      document.addEventListener('securitypolicyviolation', e => policyViolations.push(e.effectiveDirective + ' ' + e.blockedURI));
    }, code);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${new URL(r.url()).pathname}`); });
    await installMockWallet(page); await mockPlatform(page);
    const shots = [];
    for (const route of routes) {
      const before = errors.length;
      await page.goto(`${base}/#${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const state = await page.evaluate(() => ({
        lang: document.documentElement.lang, dir: document.documentElement.dir, picker: document.querySelector('#language')?.value,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        clipped: [...document.querySelectorAll('button, a, label, select, h1, h2, h3, small, strong, .nav-link, .receipt-line span')]
          .filter(el => { const s = getComputedStyle(el); return el.offsetParent && el.clientWidth > 1 && !el.closest('.sr-only') && el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'auto' && s.textOverflow !== 'ellipsis'; })
          .map(el => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}: ${el.textContent.trim().slice(0, 40)}`).slice(0, 8),
        policy: window.policyViolations,
      }));
      if (!await page.evaluate(() => Boolean(window.AccessLint))) await page.evaluate(engineSource);
      const audit = await page.evaluate(() => { AccessLint.clearAllCaches(); const r = AccessLint.runAudit(document); return r.violations.map(v => `${v.ruleId}: ${v.selector || ''}`.slice(0, 160)); });
      const file = `${code}-${vp.name}-${route.split('/')[0]}.png`;
      await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
      await page.screenshot({ path: fileURLToPath(new URL(file, output)), fullPage: true });
      shots.push(file);
      results.push({ locale: code, viewport: vp.name, route, lang: state.lang, dir: state.dir, picker: state.picker, pageOverflow: state.pageOverflow, clipped: state.clipped, violations: audit, policy: state.policy, errors: errors.slice(before) });
    }
    await context.close();
    // Contact sheet: all routes for this locale and viewport, scaled down side by side.
    const sheet = await browser.newPage({ viewport: { width: vp.name === 'mobile' ? 1800 : 2400, height: 1000 } });
    const imgs = await Promise.all(shots.map(async f => `<figure><img src="data:image/png;base64,${(await readFile(new URL(f, output))).toString('base64')}"><figcaption>${f}</figcaption></figure>`));
    await sheet.setContent(`<style>body{margin:0;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:8px;background:#ddd}figure{margin:0;width:${vp.name === 'mobile' ? 192 : 384}px}img{width:100%;max-height:${vp.name === 'mobile' ? 900 : 700}px;object-fit:cover;object-position:top}</style>${imgs.join('')}`);
    await sheet.screenshot({ path: fileURLToPath(new URL(`sheet-${code}-${vp.name}.png`, output)), fullPage: true });
    await sheet.close();
  }
} finally { await browser.close(); }
const failures = results.filter(r => r.lang !== r.locale || r.picker !== r.locale || r.pageOverflow > 0 || r.violations.length || r.errors.length || r.policy.length);
const clippedRows = results.filter(r => r.clipped.length);
await writeFile(new URL('results.json', output), JSON.stringify({ base, locales, routes, checkedAt: new Date().toISOString(), runs: results.length, failures: failures.length, clipped: clippedRows.length, results }, null, 2));
console.log(`runs ${results.length}, failures ${failures.length}, rows with clipped controls ${clippedRows.length}`);
for (const r of failures.slice(0, 30)) console.log('FAIL', r.locale, r.viewport, r.route, JSON.stringify({ lang: r.lang, picker: r.picker, overflow: r.pageOverflow, violations: r.violations.slice(0, 3), errors: r.errors.slice(0, 3), policy: r.policy }));
for (const r of clippedRows.slice(0, 30)) console.log('CLIP', r.locale, r.viewport, r.route, r.clipped.join(' | '));
if (failures.length) process.exitCode = 1;
