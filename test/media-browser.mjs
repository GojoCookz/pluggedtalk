// Standalone browser integration check. All provider outcomes are local test doubles;
// no paid provider request is made. Run: node plugged/test/media-browser.mjs (Node 24+)
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import pngjs from '../../app/node_modules/pngjs/lib/png.js';
import { digestToCids } from '../../app/src/lib/cid.ts';
import { MediaService, mediaErrorResponse, MAX_MEDIA_BODY_BYTES } from '../lib/media-service.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shies/.bun/install/cache/playwright-core@1.62.1@@@1/index.mjs').href);
const enginePath = process.env.ACCESSLINT_ENGINE || 'C:/Users/shies/.bun/install/cache/@accesslint/core@0.21.0@@@1/dist/index.iife.js';
const output = process.env.MEDIA_EVIDENCE_DIR || 'C:/Users/shies/AppData/Local/Temp/opencode/plugged-media';
await mkdir(output, { recursive: true });
const [module, css, engine] = await Promise.all([
  readFile(new URL('../web/media.js', import.meta.url)), readFile(new URL('../web/style.css', import.meta.url)), readFile(enginePath),
]);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugged media test</title><link rel="stylesheet" href="/style.css"></head><body><main><section class="form-section"><h1>Coin image</h1><p>Local automated fixture. Provider responses are simulated.</p><div class="fields"><div id="uploader" class="full"></div><label class="field full">Existing image CID<input id="external-cid" value="existing-cid"></label></div></section></main><script type="module" src="/fixture.js"></script><script src="/accesslint.js"></script></body></html>`;
const boot = `import {mediaUploader} from '/media.js';
window.locale='en';window.results=[];window.component=mediaUploader({language:()=>window.locale,onPinned:r=>{window.results.push(r);document.querySelector('#external-cid').value=r.cid;}});
window.remount=()=>{document.documentElement.lang=window.locale;window.component.mount(document.querySelector('#uploader'));};window.remount();`;
let mode = 'success', calls = 0, pending = [];
const provider = { available: true, async pin({ bytes, signal }) {
  calls++;
  if (mode === 'delayed') await new Promise((resolve, reject) => {
    pending.push(resolve);
    signal.addEventListener('abort', () => reject(new Error('Cancelled test provider')), { once: true });
  });
  if (mode === 'failure') throw new Error('Do not expose provider-secret');
  return { cid: digestToCids('0x' + createHash('sha256').update(bytes).digest('hex'))[0] };
} };
const service = new MediaService({ provider });
const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'");
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/api/media/status') return send(200, { ...service.status(), available: mode !== 'unavailable' });
  if (req.url === '/api/media/pin' && req.method === 'POST') {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_MEDIA_BODY_BYTES) return send(413, { code: 'too_large' }); chunks.push(chunk); }
      const result = await service.pin(JSON.parse(Buffer.concat(chunks).toString()), { signal: controller.signal });
      if (!res.destroyed) send(200, result);
    } catch (error) { const response = mediaErrorResponse(error); if (!res.destroyed) send(response.status, response.body); }
    return;
  }
  const file = {
    '/': ['text/html', html], '/media.js': ['text/javascript', module], '/fixture.js': ['text/javascript', boot],
    '/style.css': ['text/css', css], '/accesslint.js': ['text/javascript', engine],
  }[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file[0] }); res.end(file[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const pixels = Buffer.alloc(128 * 128 * 4);
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
  const i = (y * 128 + x) * 4, inner = x > 32 && x < 96 && y > 32 && y < 96;
  pixels[i] = inner ? 107 : 8; pixels[i + 1] = inner ? 227 : 123; pixels[i + 2] = inner ? 164 : 70; pixels[i + 3] = 255;
}
const png = pngjs.PNG.sync.write({ width: 128, height: 128, data: pixels });
const fixture = { name: 'fixture.png', mimeType: 'image/png', buffer: png };
const audits = [], checks = [], errors = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    for (const theme of ['light', 'dark']) for (const language of ['en', 'es']) {
      await page.evaluate(({ theme, language }) => { document.documentElement.dataset.theme = theme; window.locale = language; window.remount(); }, { theme, language });
      await page.locator('[data-node=file]:not(:disabled)').waitFor();
      await page.locator('[data-node=file]').setInputFiles(fixture);
      await page.locator('[data-node=upload]:not(:disabled)').waitFor();
      check(`${width}/${theme}/${language}: native picker retains selected file`, await page.locator('[data-node=file]').evaluate(el => el.files[0]?.name === 'fixture.png'));
      check(`${width}/${theme}/${language}: preview decodes`, await page.locator('[data-node=preview]').evaluate(el => el.naturalWidth === 128));
      check(`${width}/${theme}/${language}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const audit = await page.evaluate(() => { AccessLint.clearAllCaches(); return JSON.parse(JSON.stringify(AccessLint.runAudit(document), (key, value) => key === 'element' ? undefined : value)); });
      audits.push({ width, theme, language, ruleCount: audit.ruleCount, violations: audit.violations, skippedRules: audit.skippedRules });
      if (width === 390 && theme === 'light' && language === 'en' || width === 1440 && theme === 'dark' && language === 'es') {
        await page.screenshot({ path: join(output, width === 390 ? 'media-mobile.png' : 'media-desktop.png'), fullPage: true });
      }
    }
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('[data-node=file]').setInputFiles(fixture);
  await page.locator('[data-node=upload]:not(:disabled)').waitFor();
  await page.locator('[data-node=upload]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.results.length === 1);
  check('keyboard upload calls callback once', await page.evaluate(() => window.results.length === 1));
  check('confirmed CID applied to existing field', await page.locator('#external-cid').inputValue() === (await page.evaluate(() => window.results[0].cid)));
  check('duplicate submit disabled after success', await page.locator('[data-node=upload]').isDisabled());
  await page.locator('[data-node=remove]').click();
  check('clear selection preserves external CID', (await page.locator('#external-cid').inputValue()).startsWith('bafkrei'));
  mode = 'failure';
  await page.locator('[data-node=file]').setInputFiles(fixture);
  await page.locator('[data-node=upload]:not(:disabled)').waitFor();
  await page.locator('[data-node=upload]').click();
  await page.locator('[data-node=error]').filter({ hasText: 'did not confirm' }).waitFor();
  check('provider failure retains CID and does not call success', await page.evaluate(() => window.results.length === 1));
  check('provider credential never appears in page', !(await page.content()).includes('provider-secret'));
  mode = 'delayed';
  await page.locator('[data-node=upload]').click();
  await page.locator('[data-node=status]').filter({ hasText: 'Waiting for the storage provider' }).waitFor();
  check('pinning progress is indeterminate', await page.locator('progress').getAttribute('value') === null);
  await page.locator('[data-node=cancel]').click();
  pending.splice(0).forEach(resolve => resolve());
  check('cancel preserves previous CID', await page.evaluate(() => window.results.length === 1));
  check('cancel disclosure shown', (await page.locator('[data-node=status]').textContent()).includes('may remain'));
  mode = 'success';
  await page.locator('[data-node=upload]').click();
  await page.waitForFunction(() => window.results.length === 2);
  check('retry after cancellation succeeds once', await page.evaluate(() => window.results.length === 2));
  await page.locator('[data-node=remove]').click();
  await page.locator('[data-node=file]').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"></svg>') });
  await page.locator('[data-node=error]').filter({ hasText: 'Export your image' }).waitFor();
  check('invalid local input cannot upload', await page.locator('[data-node=upload]').isDisabled());
  mode = 'unavailable';
  await page.evaluate(() => { window.locale = 'es'; window.remount(); });
  await page.locator('[data-node=error]').filter({ hasText: 'no está disponible' }).waitFor();
  check('unavailable keeps manual CID usable', await page.locator('#external-cid').isEnabled());
  await page.locator('#external-cid').fill('manual-cid-still-works');
  check('unavailable prevents selection', await page.locator('[data-node=file]').isDisabled());
  await page.screenshot({ path: join(output, 'media-unavailable-es.png'), fullPage: true });
  mode = 'success';
  await page.locator('[data-node=retry]').click();
  await page.locator('[data-node=file]:not(:disabled)').waitFor();
  await page.locator('[data-node=file]').setInputFiles(fixture);
  await page.locator('[data-node=upload]:not(:disabled)').waitFor();
  mode = 'delayed';
  await page.locator('[data-node=upload]').click();
  await page.locator('[data-node=status]').filter({ hasText: 'Esperando al proveedor' }).waitFor();
  await page.evaluate(() => window.component.destroy());
  pending.splice(0).forEach(resolve => resolve());
  check('destroy removes owned DOM and prevents stale callback', await page.evaluate(() => document.querySelector('#uploader').childElementCount === 0 && window.results.length === 2));
  check('manual CID survives route destruction', await page.locator('#external-cid').inputValue() === 'manual-cid-still-works');
  check('no browser runtime errors', errors.length === 0);
  await writeFile(join(output, 'media-browser.json'), JSON.stringify({ checks, audits, errors, providerCalls: calls }, null, 2));
  const violations = audits.reduce((sum, audit) => sum + audit.violations.length, 0);
  console.log(JSON.stringify({ checks: checks.length, accessibilityStates: audits.length, rulesPerState: audits.map(a => a.ruleCount), violations, skippedRules: audits.reduce((n, a) => n + a.skippedRules.length, 0), errors, output }, null, 2));
  assert.equal(violations, 0, 'Automated accessibility violations');
} finally {
  pending.splice(0).forEach(resolve => resolve());
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
