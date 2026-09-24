// css-source.mjs - static CSS reading with file and line, for the code capture.
//
// Every gate used to read CSS with its own regular expressions: comments stripped (so line
// numbers were lost), only the FIRST :root block read, @import never followed, and <style>
// blocks in HTML read together with everything else in the file. This module reads CSS the way
// a browser structures it, without a browser and without dependencies:
//   • loadCssSources()  follows local @import (recursively), reads <style> blocks out of HTML,
//                       and blanks comments IN PLACE so every offset keeps its real line number.
//   • walkCss()         a small block parser: every style rule with its selectors, its own
//                       declarations (nested rules excluded) and the stack of enclosing
//                       at-rules (@media, @supports, @layer, @container), with file:line.
//   • rootTokens()      the custom properties a mode puts on the root element, in cascade
//                       order, for every mode kind mode-resolver.mjs knows (root, dark-media,
//                       high-contrast-media, media:<cond>, class:<name>, data:<attr>=<val>).
//   • resolveVars()     substitutes var() chains (with fallbacks) and records the alias chain.
//
// Pure except loadCssSources (reads files). Never throws on odd input.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

// Replace every /* … */ with spaces, keeping newlines, so offsets and line numbers survive.
export function blankComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// From an HTML file keep only the contents of its <style> blocks (everything else blanked,
// newlines kept), so line numbers still point into the HTML file.
export function styleBlocksOf(html) {
  const out = String(html).replace(/[^\n]/g, ' ').split('');
  for (const m of String(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1].length; i++) out[start + i] = m[1][i];
  }
  return out.join('');
}

export const lineAt = (text, offset) => {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

// Load CSS sources (CSS files, or HTML files' <style> blocks), following local @import.
// Returns { files: [{ file, abs, text }], missing: [paths], remote: [urls] } in cascade order
// (an imported sheet comes before the sheet that imports it, as a browser applies it).
export function loadCssSources(ROOT, entries, { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const files = [], missing = [], remote = [];
  const seen = new Set();
  const visit = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    if (!exists(abs)) { missing.push(relative(ROOT, abs)); return; }
    let raw;
    try { raw = read(abs); } catch { missing.push(relative(ROOT, abs)); return; }
    const text = blankComments(/\.html?$/i.test(abs) ? styleBlocksOf(raw) : raw);
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/g)) {
      const target = m[1];
      if (/^(https?:)?\/\//i.test(target)) { remote.push(target); continue; }
      visit(resolve(dirname(abs), target));
    }
    files.push({ file: relative(ROOT, abs), abs, text });
  };
  for (const e of [entries].flat().filter(Boolean)) {
    if (/^https?:\/\//i.test(e)) { remote.push(e); continue; }
    visit(resolve(ROOT, e));
  }
  return { files, missing, remote };
}

// Every custom property declared anywhere in these files (any selector, inline styles too), plus in
// the stylesheets they @import. The gates' "is this variable declared" question. <script> blocks in
// HTML are skipped when stripScripts is set (JS object literals are not declarations).
export function declaredVarNames(ROOT, paths, { stripScripts = false } = {}) {
  const names = new Set();
  const scan = (text) => { for (const m of blankComments(text).matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) names.add('--' + m[1]); };
  const own = new Set();
  for (const p of paths) {
    const abs = resolve(ROOT, p);
    if (!existsSync(abs)) continue;
    own.add(abs);
    let src = readFileSync(abs, 'utf8');
    if (stripScripts && /\.html?$/i.test(p)) src = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    scan(src);
  }
  for (const f of loadCssSources(ROOT, paths).files) if (!own.has(f.abs)) scan(f.text);
  return names;
}

// Parse one (comment-blanked) stylesheet into style rules.
// Each rule: { selectors: [..], decls: [{ prop, value, important, line }], atRules: [..], file, line }.
// Handles nesting (`&` and bare nested selectors), strings, and `;` inside parentheses (data URIs).
// Parsed once per (file, text): the capture reads the same sheets for every component. Callers
// treat the returned rules as read-only.
const WALK_CACHE = new Map();
export function walkCss(text, file = '') {
  const key = file + '\u0000' + text;
  let rules = WALK_CACHE.get(key);
  if (!rules) {
    rules = walkCssOnce(text, file);
    if (WALK_CACHE.size >= 64) WALK_CACHE.delete(WALK_CACHE.keys().next().value);
    WALK_CACHE.set(key, rules);
  }
  return rules;
}
function walkCssOnce(text, file) {
  const rules = [];
  const stack = [];              // frames: { kind: 'at'|'style', prelude, rule?, own: [[a,b]], cursor }
  let segStart = 0;              // start of the current prelude / declaration
  let quote = null, paren = 0;
  // Split a block's own text into declarations on top-level ";" (not inside strings or parens).
  const declsIn = (a, b) => {
    const out = [];
    let q = null, depth = 0, from = a;
    const flush = (to) => {
      const seg = text.slice(from, to);
      const m = seg.match(/^(\s*)([-\w]+)\s*:([\s\S]*)$/);
      if (m && m[3].trim()) {
        let value = m[3].trim().replace(/\s+/g, ' ');
        const important = /!\s*important\s*$/i.test(value);
        if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
        out.push({ prop: m[2], value, important, line: lineAt(text, from + m[1].length) });
      }
    };
    for (let j = a; j < b; j++) {
      const c = text[j];
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ';' && !depth) { flush(j); from = j + 1; }
    }
    flush(b);
    return out;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); continue; }
    if (paren) continue;
    if (ch === ';') { segStart = i + 1; continue; }
    if (ch === '{') {
      const raw = text.slice(segStart, i);
      const prelude = raw.trim();
      const parent = stack[stack.length - 1];
      if (parent?.kind === 'style') { parent.own.push([parent.cursor, segStart]); }
      if (prelude.startsWith('@')) {
        stack.push({ kind: 'at', prelude });
      } else {
        const parentSel = [...stack].reverse().find((f) => f.kind === 'style')?.rule.selectors ?? null;
        const own = prelude.split(',').map((x) => x.trim()).filter(Boolean);
        const selectors = parentSel
          ? parentSel.flatMap((p) => own.map((x) => (x.includes('&') ? x.replace(/&/g, p) : `${p} ${x}`)))
          : own;
        const rule = { selectors, decls: [], atRules: stack.filter((f) => f.kind === 'at').map((f) => f.prelude), file, line: lineAt(text, segStart + (raw.length - raw.trimStart().length)) };
        rules.push(rule);
        stack.push({ kind: 'style', prelude, rule, own: [], cursor: i + 1 });
      }
      segStart = i + 1;
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame?.kind === 'style') {
        frame.own.push([frame.cursor, i]);
        for (const [a, b] of frame.own) frame.rule.decls.push(...declsIn(a, b));
      }
      const parent = stack[stack.length - 1];
      if (parent?.kind === 'style') parent.cursor = i + 1;
      segStart = i + 1;
    }
  }
  return rules;
}

const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

// Does a rule's at-rule stack apply in this mode? @layer / @supports are transparent; any other
// non-media at-rule (@container, @scope, …) is never root-level; @media must be the mode's own.
function atApplies(atRules, mode) {
  const media = atRules.filter((a) => /^@media\b/i.test(a)).map((a) => norm(a.replace(/^@media/i, '')));
  if (atRules.some((a) => !/^@(media|layer|supports)\b/i.test(a))) return false;
  if (!media.length) return true;
  const sel = mode?.cssSelector ?? 'root';
  const want = sel === 'dark-media' ? norm('(prefers-color-scheme: dark)')
    : sel === 'high-contrast-media' ? norm('(prefers-contrast: more)')
    : sel.startsWith('media:') ? norm(sel.slice(6)) : null;
  return want != null && media.every((m) => m === want);
}

// Does this selector match the root element in this mode (plain :root/html always; the mode's
// class or data attribute when the mode switches that way)?
function matchesRoot(selector, mode) {
  const s = selector.replace(/\s+/g, ' ').trim();
  if (s === ':root' || s === 'html') return true;
  const sel = mode?.cssSelector ?? 'root';
  // ".c :root" and "[data-x] :root" are accepted as the engine's documented mode forms, although a
  // browser never applies them (:root has no ancestor). The browser reading then disagrees and the
  // capture marks those tokens uncertain, which is the honest signal.
  if (sel.startsWith('class:')) {
    const c = sel.slice(6);
    return [`:root.${c}`, `html.${c}`, `.${c}`, `.${c} :root`].includes(s);
  }
  if (sel.startsWith('data:')) {
    const [attr, val = ''] = sel.slice(5).split('=');
    const unq = val.replace(/^['"]|['"]$/g, '');
    const forms = [...new Set([attr.startsWith('data-') ? attr : `data-${attr}`, attr])].flatMap((a) => [`[${a}="${unq}"]`, `[${a}='${unq}']`, `[${a}=${unq}]`]);
    return forms.some((f) => [f, `:root${f}`, `html${f}`, `${f} :root`].includes(s));
  }
  return false;
}

// Rules that declare tokens on ":root" written under an ancestor (".dark :root", "[data-theme] :root",
// "html > :root"). A browser never applies them: the root element has no ancestor. Returns
// [{ selector, file, line, suggest }] where suggest is the form that does apply.
export function neverAppliedRootSelectors(sources) {
  const out = [];
  for (const { file, text } of sources) {
    for (const rule of walkCss(text, file)) {
      if (!rule.decls.some((d) => d.prop.startsWith('--'))) continue;
      for (const sel of rule.selectors) {
        const s = sel.replace(/\s+/g, ' ').trim();
        const m = s.match(/^(.+?)\s*(?:>|\s)\s*:root$/);
        if (!m || /[,]/.test(m[1])) continue;
        const anc = m[1].trim();
        const suggest = /^(html|:root)$/.test(anc) ? null : /^[.[]/.test(anc) ? `:root${anc}` : null;
        out.push({ selector: s, file, line: rule.line, suggest });
      }
    }
  }
  return out;
}

// Specificity [ids, classes/attributes/pseudo-classes, elements] of a simple root selector.
export function specificity(selector) {
  const s = String(selector).replace(/::[\w-]+/g, ' ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const els = (s.replace(/\[[^\]]*\]|[.#:][\w-]+/g, ' ').match(/\b[a-z][\w-]*\b/gi) || []).length;
  return [ids, cls, els];
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The custom properties on the root element in one mode, resolved by the CSS cascade:
// !important first, then specificity, then source order (later wins). Sources are in cascade
// order (imports first). Returns Map var -> { value, file, line, important }.
export function rootTokens(sources, mode) {
  const cands = [];
  let order = 0;
  for (const { file, text } of sources) {
    for (const rule of walkCss(text, file)) {
      if (!atApplies(rule.atRules, mode)) continue;
      const hits = rule.selectors.filter((sel) => matchesRoot(sel, mode));
      if (!hits.length) continue;
      const spec = hits.map(specificity).sort(cmpSpec).pop();
      for (const d of rule.decls) {
        if (d.prop.startsWith('--')) cands.push({ ...d, file, spec, order: order++ });
      }
    }
  }
  cands.sort((a, b) => (a.important - b.important) || cmpSpec(a.spec, b.spec) || (a.order - b.order));
  const out = new Map();
  for (const c of cands) out.set(c.prop, { value: c.value, file: c.file, line: c.line, important: c.important });
  return out;
}

// Substitute var() references using `vars` (Map var -> { value }). Returns
// { value, chain: [--a, --b, …], unresolved: [--x] } where chain is the alias path of a value that
// is exactly one var() (a pure alias), and unresolved lists references with no value or fallback.
export function resolveVars(value, vars, depth = 0, seen = new Set()) {
  const unresolved = [];
  let chain = [];
  const pure = String(value).trim().match(/^var\(\s*(--[\w-]+)\s*\)$/);
  const out = String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (m, name, fallback) => {
    if (depth > 12 || seen.has(name)) { unresolved.push(name); return m; }
    const hit = vars.get(name);
    if (hit != null) {
      const r = resolveVars(hit.value, vars, depth + 1, new Set([...seen, name]));
      unresolved.push(...r.unresolved);
      if (pure) chain = [name, ...r.chain];
      return r.value;
    }
    if (fallback != null) return resolveVars(fallback.trim(), vars, depth + 1, seen).value;
    unresolved.push(name);
    return m;
  });
  return { value: out.trim(), chain, unresolved };
}

// Canonical form for comparing two readings of the same value: whitespace collapsed, lowercase
// hex, no space around "(" ")" ",", and numbers written the same way (a minifier's ".28s" is the
// source's "0.28s"; "1.50" is "1.5"). Hex colours are kept whole so their digits are not touched.
export function canonValue(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ',')
    .replace(/#[0-9a-f]+\b|(-?\d*\.?\d+)/gi, (m, num) => (num != null ? String(Number(num)) : m.toLowerCase()));
}
