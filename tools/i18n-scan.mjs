// Scans web/*.js for bilingual L(en, es) calls. Used by the one-off migration and by tests.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ident = /[A-Za-z0-9_$.]/;

// Reads a JS string/template literal starting at i; returns { end, raw, parts } where parts
// is a list of literal text and ${expr} sources for templates.
export function readLiteral(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let j = i + 1, text = '', parts = [];
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
    if (c === q) { parts.push({ text }); return { end: j + 1, raw: src.slice(i, j + 1), parts, quote: q }; }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      parts.push({ text }); text = '';
      const end = skipExpr(src, j + 2, '}');
      parts.push({ expr: src.slice(j + 2, end) });
      j = end + 1; continue;
    }
    text += c; j++;
  }
  throw new Error('unterminated literal at ' + i);
}

// Skips an expression until the matching closer at depth 0; returns closer index.
export function skipExpr(src, i, closer) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = readLiteral(src, i).end; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) { if (c === closer) return i; throw new Error('mismatch at ' + i); } depth--; }
    else if (c === ',' && depth === 0 && closer === ',') return i;
    i++;
  }
  throw new Error('unterminated expr');
}

// Splits call arguments starting after "(" ; returns { args:[{start,end,src}], end } (end = index of ")").
export function readArgs(src, i) {
  const args = []; let start = i, depth = 0, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') { j = readLiteral(src, j).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push({ start, end: j, src: src.slice(start, j) }); return { args, end: j }; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push({ start, end: j, src: src.slice(start, j) }); start = j + 1; }
    j++;
  }
  throw new Error('unterminated call');
}

export function findCalls(src, name = 'L') {
  const calls = []; let i = 0;
  while ((i = src.indexOf(name + '(', i)) !== -1) {
    if (i > 0 && ident.test(src[i - 1])) { i++; continue; }
    // skip the definition const L=(en,es)=>
    if (/const\s+$/.test(src.slice(Math.max(0, i - 8), i))) { i++; continue; }
    try { const { args, end } = readArgs(src, i + name.length + 1); calls.push({ start: i, end: end + 1, args }); i = end + 1; }
    catch { i++; }
  }
  return calls;
}

export function webFiles(dir = 'web') {
  return readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('i18n')).map(f => join(dir, f));
}

if (import.meta.main) {
  let total = 0, literal = 0, template = 0, other = 0;
  for (const f of webFiles()) {
    const src = readFileSync(f, 'utf8');
    for (const c of findCalls(src)) {
      total++;
      const kinds = c.args.map(a => { const s = a.src.trim(); const lit = /^['"`]/.test(s) ? readLiteral(s, 0) : null; return !lit || lit.end !== s.length ? 'expr' : lit.parts.length > 1 ? 'tpl' : 'lit'; });
      if (c.args.length === 2 && kinds.every(k => k === 'lit')) literal++;
      else if (c.args.length === 2 && kinds.every(k => k !== 'expr')) template++;
      else { other++; console.log(f, c.args.length, kinds.join(','), src.slice(c.start, Math.min(c.end, c.start + 160)).replace(/\n/g, ' ')); }
    }
  }
  console.log({ total, literal, template, other });
}
