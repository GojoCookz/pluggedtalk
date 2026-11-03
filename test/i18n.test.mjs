import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { findCalls, readLiteral, webFiles } from '../tools/i18n-scan.mjs';
import { LOCALES, LOCALE_CODES, matchLanguage, translate, registerLocale, serverError, SERVER_ERROR_KEYS, direction } from '../web/i18n.js';
import { TRADING_ERRORS } from '../lib/trading-errors.mjs';
import en from '../web/locales/en.js';

const tables = Object.fromEntries(await Promise.all(LOCALE_CODES.map(async code => [code, (await import(`../web/locales/${code}.js`)).default])));
for (const [code, table] of Object.entries(tables)) registerLocale(code, table);
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
// Tokens that must survive translation untouched whenever the English string contains them.
const PROTECTED = ['ETH', 'CID', 'bps', 'IPFS', 'ERC-20', 'EVM', 'RPC', 'USD', 'V4', 'Uniswap', 'Robinhood', 'Carbon', 'Plugged', 'Pons', 'Bags', 'Wormhole', 'GitHub', '4663', 'BAGS_API_KEY', 'calldata', 'nonce', 'JSON', 'PNG', 'MiB', 'UTC'];

function literalArg(arg) {
  const s = arg?.src.trim();
  if (!s || !/^['"`]/.test(s)) return null;
  const lit = readLiteral(s, 0);
  return lit.end === s.length && lit.parts.length === 1 ? new Function('return ' + lit.raw)() : null;
}
function usedKeys() {
  const keys = new Set(), dynamic = [];
  for (const file of webFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const [name, at] of [['L', 0], ['t', 0], ['button', 1], ['uiError', 0], ['text', 0]]) {
      for (const call of findCalls(src, name)) {
        const key = literalArg(call.args[at]);
        if (key !== null) keys.add(name === 'text' ? 'media.' + key : key);
        else if (call.args[at]) dynamic.push(`${file}: ${name}(${call.args[at].src.trim().slice(0, 40)})`);
      }
    }
    for (const m of src.matchAll(/\[\/(?:\\.|[^\/\n])+\/[a-z]*,\s*'([\w.]+)'\]/g)) keys.add(m[1]);
  }
  for (const code of Object.keys(TRADING_ERRORS)) keys.add('tradingError.' + code);
  for (const key of SERVER_ERROR_KEYS) keys.add(key);
  return { keys, dynamic };
}

test('every literal key used in web/*.js exists in English', () => {
  const { keys } = usedKeys();
  const missing = [...keys].filter(k => !(k in en));
  expect(missing).toEqual([]);
  expect(keys.size).toBeGreaterThan(700);
});

test('no inline bilingual pairs remain in web modules', () => {
  for (const file of webFiles()) {
    const src = readFileSync(file, 'utf8');
    const leftovers = [...src.matchAll(/===\s*'es'|L=\(en,es\)/g)].map(m => `${file}: ${m[0]}`);
    for (const call of findCalls(src, 'L')) if (call.args.length > 2 || literalArg(call.args[1]) !== null) leftovers.push(`${file}: ${src.slice(call.start, call.start + 60)}`);
    expect(leftovers).toEqual([]);
  }
});

test('every supported locale has a file, native name and valid entries', () => {
  expect(LOCALE_CODES).toEqual(['en', 'es', 'pt-BR', 'fr', 'de', 'zh-CN', 'ja', 'ko', 'tr', 'vi', 'ru', 'hi', 'id']);
  const files = readdirSync('web/locales').map(f => f.replace(/\.js$/, '')).sort();
  expect(files).toEqual([...LOCALE_CODES].sort());
  for (const { code, name } of LOCALES) {
    expect(name.length).toBeGreaterThan(1);
    const problems = [];
    for (const [key, value] of Object.entries(tables[code])) {
      if (!(key in en)) problems.push(`${code}: unknown key ${key}`);
      else {
        if (typeof value !== 'string' || !value.trim()) problems.push(`${code}: empty ${key}`);
        if (placeholders(value) !== placeholders(en[key])) problems.push(`${code}: placeholders differ in ${key}`);
        // Lowercase technical words may be capitalised as nouns (German "Calldata"); acronyms must match exactly.
        for (const token of PROTECTED) if (en[key].includes(token) && !(token === token.toLowerCase() ? value.toLowerCase() : value).includes(token)) problems.push(`${code}: ${key} lost ${token}`);
      }
    }
    expect(problems).toEqual([]);
  }
});

test('per-locale coverage report', () => {
  const total = Object.keys(en).length, rows = [];
  for (const code of LOCALE_CODES) {
    const covered = Object.keys(tables[code]).filter(k => k in en).length;
    rows.push(`${code.padEnd(6)} ${String(covered).padStart(4)}/${total} ${(covered / total * 100).toFixed(1)}%`);
    expect(covered / total).toBeGreaterThanOrEqual(0.95);
  }
  console.log('i18n coverage\n' + rows.join('\n'));
});

test('lookup falls back to English and fills named placeholders', () => {
  expect(translate('de', 'connect')).toBe('Wallet verbinden');
  expect(translate('de', 'definitely.missing')).toBe('definitely.missing');
  expect(translate('xx', 'connect')).toBe(en.connect);
  expect(translate('ja', 'showingOf', { shown: 3, total: 9 })).toBe('9 件中 3 件を表示');
  expect(translate('en', 'removeLabel', { n: 2 })).toBe('Remove recipient 2');
  expect(direction('de')).toBe('ltr');
});

test('first-visit language follows navigator.languages', () => {
  expect(matchLanguage(['de-AT', 'en'])).toBe('de');
  expect(matchLanguage(['pt-PT'])).toBe('pt-BR');
  expect(matchLanguage(['zh-CN'])).toBe('zh-CN');
  expect(matchLanguage(['zh-TW', 'ja'])).toBe('ja');
  expect(matchLanguage(['hi-IN'])).toBe('hi');
  expect(matchLanguage(['nl-NL'])).toBe('en');
  expect(matchLanguage([])).toBe('en');
});

test('server errors translate per locale and keep captured values', () => {
  expect(serverError('Market 2: choose a configured ERC-20 quote. Native ETH is not a quote token.', 'de')).toBe('Markt 2: Wähle ein konfiguriertes ERC-20-Quote. Natives ETH ist kein Quote-Token.');
  expect(serverError('Vault rejected accept (NotRecipient).', 'ja')).toBe('ボールトが accept を拒否しました（NotRecipient）。');
  expect(serverError('Fee vault RPC is unavailable.', 'en')).toBe('Fee vault RPC is unavailable.');
  expect(serverError('Brand new server text.', 'fr')).toBe('Brand new server text.');
});
