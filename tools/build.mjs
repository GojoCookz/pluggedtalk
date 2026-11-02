import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
const catalog = JSON.parse(await readFile(new URL('data/assets.json', root), 'utf8'));
await writeFile(new URL('data/quotes.json', root), JSON.stringify(catalog.assets.filter(a => a.codeVerified === true && a.decimalsVerified === true)
  .map(({ address, symbol, name, decimals, category, issuerListed }) => ({ address, symbol, name, decimals, category, issuerListed })), null, 2));
const result = await Bun.build({ entrypoints: [new URL('web/app.js', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')], outdir: new URL('dist/', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'), minify: true, target: 'browser' });
if (!result.success) { console.error(result.logs); process.exit(1); }
for (const file of ['index.html', 'style.css', 'mark.svg']) await copyFile(new URL(`web/${file}`, root), new URL(`dist/${file}`, root));
console.log(`Plugged frozen build: ${result.outputs.reduce((sum, output) => sum + output.size, 0)} JavaScript bytes; no new dependencies.`);
