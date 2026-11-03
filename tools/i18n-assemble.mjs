// Translator workflow without an i18n library:
//   bun tools/i18n-assemble.mjs dump <file>          numbered "n|English" lines (key order of en.js)
//   bun tools/i18n-assemble.mjs build <code> <files…> numbered "n|translation" lines -> web/locales/<code>.js
// Numbered lines keep translator files compact; keys stay the source of truth in en.js.
import { readFileSync, writeFileSync } from 'node:fs';
import en from '../web/locales/en.js';
import { LOCALES } from '../lib/locales.mjs';

const keys = Object.keys(en);
const [mode, ...rest] = process.argv.slice(2);
if (mode === 'dump') {
  writeFileSync(rest[0], keys.map((k, i) => `${i}|${en[k].replace(/\n/g, '\\n')}`).join('\n') + '\n');
  console.log(keys.length, 'lines');
} else if (mode === 'build') {
  const [code, ...files] = rest;
  const locale = LOCALES.find(l => l.code === code);
  if (!locale || code === 'en') throw new Error('unknown locale ' + code);
  const out = {}, problems = [];
  for (const file of files) for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (!m) { problems.push('bad line: ' + line.slice(0, 60)); continue; }
    const key = keys[Number(m[1])];
    if (!key) { problems.push('no key for ' + m[1]); continue; }
    let text = m[2].replace(/\\n/g, '\n').trim();
    // Fragments that are concatenated with other text keep their surrounding spaces.
    if (text && /\s$/.test(en[key])) text += ' ';
    if (text && /^\s/.test(en[key])) text = ' ' + text;
    const want = [...en[key].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(), got = [...text.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join();
    if (want !== got) problems.push(`${m[1]} ${key}: placeholders ${want} != ${got}`);
    if (text) out[key] = text;
  }
  const ordered = Object.fromEntries(keys.filter(k => k in out).map(k => [k, out[k]]));
  writeFileSync(`web/locales/${code}.js`, `// ${locale.name} (${code}) user-facing strings. Keys missing here fall back to English.\nexport default {\n${Object.entries(ordered).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n};\n`);
  console.log(code, Object.keys(ordered).length, '/', keys.length, problems.length ? '\n' + problems.join('\n') : '');
  if (problems.length) process.exitCode = 1;
} else console.log('usage: dump <file> | build <code> <files…>');
