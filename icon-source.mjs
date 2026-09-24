// icon-source.mjs - read the icons a project ships: every sprite <symbol> (with its file, line,
// viewBox and path data) and where each icon id is used.
//
// This reading used to live inside icon-check.mjs. The icon gate and the code capture now share it.
// Pure except for the file reads.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SYMBOL_BLOCK_RE = /<symbol\s([^>]*)>([\s\S]*?)<\/symbol>/g;
const ID_RE = /\bid="([^"]+)"/;
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

// A short fingerprint of an icon's path data (order-free), comparable between Figma and code.
export const pathHash = (paths) => createHash('sha256').update([...(paths ?? [])].sort().join('|')).digest('hex').slice(0, 12);

export function extractPathDs(body) {
  const re = /\bd="([^"]+)"/g;
  const ds = [];
  let m;
  while ((m = re.exec(body)) !== null) ds.push(m[1]);
  return ds;
}

// Every <symbol id> in one text, in source order.
//   [{ id, line, attrs, body, viewBox, paths, fillNone, strokeNone, transforms }]
export function symbolsIn(text) {
  const out = [];
  let m;
  SYMBOL_BLOCK_RE.lastIndex = 0;
  while ((m = SYMBOL_BLOCK_RE.exec(text)) !== null) {
    const attrs = m[1], body = m[2];
    const idMatch = ID_RE.exec(attrs);
    if (!idMatch) continue;
    out.push({
      id: idMatch[1],
      line: lineAt(text, m.index),
      attrs, body,
      viewBox: /\bviewBox="([^"]+)"/.exec(attrs)?.[1] ?? null,
      paths: extractPathDs(body),
      fillNone: /\bfill=["']none["']/.test(attrs),
      strokeNone: /stroke=["']none["']/.test(body),
      transforms: [...body.matchAll(/transform=["']([^"']+)["']/g)].map((t) => t[1]),
    });
  }
  return out;
}

// Symbols across files (paths relative to ROOT), each tagged with its file. Missing files are skipped.
export function readSymbols(ROOT, files) {
  const out = [];
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    for (const s of symbolsIn(readFileSync(join(ROOT, f), 'utf8'))) out.push({ ...s, file: f });
  }
  return out;
}

// Where icons are used. The corpus is every reference source with the <symbol> definitions removed
// (a definition never counts as use). Ids built by concatenation ('#icon-arrow-' + dir) are
// recorded as dynamic prefixes: those ids cannot be seen literally.
export function iconUsage(ROOT, files) {
  let corpus = '';
  for (const f of files) if (existsSync(join(ROOT, f))) corpus += '\n' + readFileSync(join(ROOT, f), 'utf8');
  const corpusNoDefs = corpus.replace(/<symbol\s[^>]*>[\s\S]*?<\/symbol>/g, ' ');
  const dynamicPrefixes = [];
  for (const m of corpus.matchAll(/["'`]#(icon-[a-z0-9-]*-)["'`]?\s*\+/gi)) dynamicPrefixes.push(m[1]);
  for (const m of corpus.matchAll(/#(icon-[a-z0-9-]*-)\$\{/g)) dynamicPrefixes.push(m[1]);
  return { corpus, corpusNoDefs, dynamicPrefixes };
}

// Literal references per id: { id: ["file:line", …] } from <use href="#id"> / xlink:href and
// '#id' strings, outside the symbol definitions.
export function iconRefs(ROOT, files, ids) {
  const want = new Set(ids);
  const refs = {};
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    const text = readFileSync(join(ROOT, f), 'utf8').replace(/<symbol\s[^>]*>[\s\S]*?<\/symbol>/g, (s) => s.replace(/[^\n]/g, ' '));
    for (const m of text.matchAll(/#([A-Za-z][\w-]*)(?![\w-])/g)) {
      if (!want.has(m[1])) continue;
      (refs[m[1]] ??= []).push(`${f}:${lineAt(text, m.index)}`);
    }
  }
  return refs;
}
