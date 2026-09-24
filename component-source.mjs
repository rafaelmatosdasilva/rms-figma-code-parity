// component-source.mjs - read a DS component's code: which file it lives in, its props, slots and
// the other DS components it uses.
//
// These readers used to live inside the gates (props in component-prop-check.mjs, nesting in
// component-composition-check.mjs), each with its own copy of the file walk and the file finder.
// The gates and the code capture now share them, so both read code the same way.
//
// Readings, best source first (component-api.mjs merges them):
//   • standard files the project already produces - Custom Elements Manifest, react-docgen or
//     vue-docgen JSON, Figma Code Connect files (pairing only)
//   • the project's own TypeScript compiler, when it is installed (never added as a dependency)
//   • text patterns (this file) - the fallback, and the reading every gate has always used
//
// Pure except for the file reads; no network, no browser.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Files ─────────────────────────────────────────────────────────────────────
export const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs', '.parity-out']);
export const CODE_EXT = new Set(['.vue', '.tsx', '.jsx', '.ts', '.js', '.svelte']);

function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (CODE_EXT.has(extname(e.name)) && !/\.(test|spec|stories)\./.test(e.name) && !/\.figma\.[jt]sx?$/.test(e.name)) out.push(p);
  }
}

// Component source files: ds-config.json → componentSrcDirs (default src, components, app, lib,
// packages), else the whole repo. Tests, stories and Code Connect files are not components.
export function componentSourceFiles(ROOT, cfg = {}) {
  const out = [];
  for (const d of (cfg.componentSrcDirs ?? ['src', 'components', 'app', 'lib', 'packages']).map((x) => join(ROOT, x))) if (existsSync(d)) walk(d, out);
  if (!out.length) walk(ROOT, out);
  return out;
}

// A cached text reader (one read per file per run).
export function textReader() {
  const cache = new Map();
  return (f) => { if (!cache.has(f)) { try { cache.set(f, readFileSync(f, 'utf8')); } catch { cache.set(f, ''); } } return cache.get(f); };
}

// ── Which file is component X ─────────────────────────────────────────────────
export function declaredNames(text) {
  const out = [];
  for (const m of text.matchAll(/\bname\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/g)) out.push(m[1]);          // Vue options / defineOptions
  for (const m of text.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) out.push(m[1]);                // React fn/class
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:styled|React|forwardRef|memo|\()/g)) out.push(m[1]);
  return out;
}

// 1) explicit componentFiles map  2) declared by a standard file (Storybook, docgen, Custom Elements
// Manifest, Code Connect - `declared`)  3) base selector present  4) a declared component name
// matches  5) the file basename matches. Returns { file, how } (file null when not found or ambiguous).
export function resolveComponentFile(name, { ROOT, cfg = {}, files, read, classFor, declared = {} }) {
  const map = cfg.componentFiles ?? {};
  if (map[name]) {
    const p = join(ROOT, map[name]);
    return existsSync(p) ? { file: p, how: 'componentFiles' } : { file: null, how: 'componentFiles(missing)' };
  }
  const d = declared[name];
  if (d?.file && existsSync(d.file)) return { file: d.file, how: d.how };
  const fig = norm(name);
  const sel = norm(classFor ? classFor(name) : name);
  const bySelector = [], byName = [], byBasename = [];
  for (const f of files) {
    const t = read(f);
    if (sel.length >= 4 && norm(t).includes(sel)) bySelector.push(f);
    if (declaredNames(t).some((n) => norm(n) === fig)) byName.push(f);
    if (norm(basename(f, extname(f))) === fig) byBasename.push(f);
  }
  // Several files mention the selector (a parent that uses the component does too): the one that
  // also declares the component, or is named after it, is the component.
  if (bySelector.length > 1) {
    const own = bySelector.filter((f) => byName.includes(f) || byBasename.includes(f));
    if (own.length === 1) return { file: own[0], how: 'selector' };
  }
  const pick = bySelector.length ? bySelector : byName.length ? byName : byBasename;
  if (pick.length === 1) return { file: pick[0], how: bySelector.length ? 'selector' : byName.length ? 'name' : 'basename' };
  if (pick.length > 1) return { file: null, how: `ambiguous (${pick.length} files)` };
  return { file: null, how: 'not found' };
}

// ── Props (text patterns) ─────────────────────────────────────────────────────
// Union of everything found; over-collecting a few names is fine (only unmatched Figma
// properties fail, and extra code props are advisory).
function idsFromDestructure(block) {
  const out = [];
  for (const m of block.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?::|=|,|\})/g)) {
    if (m[1] && m[1] !== 'props') out.push(m[1]);
  }
  return out;
}
export function extractVue(text) {
  const names = new Set();
  // defineProps<{ ... }>()
  for (const m of text.matchAll(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) names.add(p[1]);
  // defineProps({ ... })  and options  props: { ... }
  for (const m of text.matchAll(/(?:defineProps\s*\(|[^.\w]props\s*:)\s*\{([\s\S]*?)\}\s*[),]/g))
    for (const p of m[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(p[1]);
  // defineProps([ 'a', 'b' ])  and options  props: [ 'a', 'b' ]
  for (const m of text.matchAll(/(?:defineProps\s*\(|[^.\w]props\s*:)\s*\[([\s\S]*?)\]/g))
    for (const p of m[1].matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)) names.add(p[1]);
  return names;
}
export function extractReact(text) {
  const names = new Set();
  // interface XProps { ... }  /  type XProps = { ... }
  for (const m of text.matchAll(/(?:interface|type)\s+\w*Props\b[^{]*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) names.add(p[1]);
  // destructured function params: function C({ a, b }  /  const C = ({ a, b }
  for (const m of text.matchAll(/(?:function\s+[A-Z][\w$]*|(?:const|let|var)\s+[A-Z][\w$]*\s*=)\s*(?:function\s*)?\(\s*\{([\s\S]*?)\}/g))
    for (const id of idsFromDestructure(m[1])) names.add(id);
  // C.propTypes = { a: ..., b: ... }
  for (const m of text.matchAll(/\.propTypes\s*=\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(p[1]);
  return names;
}
export function extractSvelte(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}
const PROP_EXTRACTORS = {
  '.vue': extractVue,
  '.svelte': extractSvelte,
  '.tsx': extractReact, '.jsx': extractReact, '.ts': extractReact, '.js': extractReact,
};
export function extractProps(file, text) {
  const fn = PROP_EXTRACTORS[extname(file)];
  return fn ? fn(text) : new Set();
}

const _LIT = `(['"\`][^'"\`]*['"\`]|true|false|-?\\d+(?:\\.\\d+)?)`;
const _unq = (s) => String(s).replace(/^['"`]|['"`]$/g, '').trim();
// Best-effort: code prop -> default value (normalised prop name -> literal string).
// Covers React default params & defaultProps, Vue withDefaults / defineProps({default}).
export function extractDefaults(text) {
  const out = new Map();
  const put = (name, val) => { if (name) out.set(norm(name), _unq(val)); };
  for (const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${_LIT}`, 'g'))) put(m[1], m[2]);   // ({ a = 'x' })
  for (const m of text.matchAll(/withDefaults\s*\([\s\S]*?,\s*\{([\s\S]*?)\}\s*\)/g))
    for (const p of m[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${_LIT}`, 'g'))) put(p[1], p[2]);
  for (const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*\\{[^{}]*\\bdefault\\s*:\\s*${_LIT}`, 'g'))) put(m[1], m[2]);
  for (const m of text.matchAll(/defaultProps\s*=\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${_LIT}`, 'g'))) put(p[1], p[2]);
  return out;
}
// Best-effort: code prop -> the set of string-literal options it accepts, from a TS
// union type (`size?: 'small' | 'medium' | 'large'`). Used to check variant coverage.
export function extractOptions(text) {
  const out = new Map();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*((?:['"`][^'"`]*['"`]\s*\|\s*)+['"`][^'"`]*['"`])/g)) {
    const opts = [...m[2].matchAll(/['"`]([^'"`]*)['"`]/g)].map((x) => norm(x[1]));
    if (opts.length >= 2) out.set(norm(m[1]), new Set(opts));
  }
  return out;
}
// A Figma INSTANCE_SWAP property is a SLOT, not a value prop - it maps to a code slot (Vue
// <slot>, React children/ReactNode). Best-effort detection of the code's slots.
export function extractSlots(text) {
  const named = new Set();
  let hasDefault = false;
  for (const m of text.matchAll(/<slot\b[^>]*\bname\s*=\s*['"`]([\w-]+)['"`]/g)) named.add(norm(m[1]));  // Vue named
  if (/<slot(\s|\/|>)/.test(text) && !/<slot\b[^>]*\bname\s*=/.test(text)) hasDefault = true;            // Vue default
  for (const m of text.matchAll(/defineSlots\s*<\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) named.add(norm(p[1]));                  // Vue defineSlots
  if (/\bchildren\b/.test(text)) hasDefault = true;                                                      // React children
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*React\.?ReactNode/g)) named.add(norm(m[1])); // React ReactNode props as slots
  return { named, hasDefault };
}

// The text reading of one component file, in the shape component-api.mjs merges.
//   { props: { name: { default?, options? } }, slots: { named: [...], default: bool } }
export function textComponentApi(file, text) {
  const defaults = extractDefaults(text), options = extractOptions(text);
  const props = {};
  for (const p of extractProps(file, text)) {
    const e = {};
    if (defaults.has(norm(p))) e.default = defaults.get(norm(p));
    if (options.has(norm(p))) e.options = [...options.get(norm(p))];
    props[p] = e;
  }
  const s = extractSlots(text);
  return { props, slots: { named: [...s.named], default: s.hasDefault } };
}

// ── Nesting (text patterns) ───────────────────────────────────────────────────
// Which DS components does a text use? A sub-component is "used" when its base selector, or its
// name as a JSX tag / import, appears. `universe` = [{ name, selNorm }].
export function usedComponents(text, universe) {
  const tn = norm(text);
  const used = new Set();
  for (const u of universe) {
    if (u.selNorm.length >= 4 && tn.includes(u.selNorm)) { used.add(u.name); continue; }
    if (new RegExp(`<${esc(u.name)}\\b|\\b${esc(u.name)}\\b\\s*(?:from|,|})`).test(text)) used.add(u.name);   // JSX tag / import
  }
  return used;
}
