// effect-check.mjs - Gate: effect-style parity (Figma shadow styles → CSS box-shadow).
//
// DS-AGNOSTIC and OPT-IN. A no-op (exit 0) unless BOTH:
//   • the snapshot has an `effects` map ({ styleName: "<canonical box-shadow>" }), captured from
//     Figma's local effect styles (drop/inner shadows → "x y blur spread color[, …]"), and
//   • ds-config.json declares `figma.effects` mapping each style to a CSS var holding its box-shadow.
//
// ds-config.json → figma.effects:
//   { "explicit": { "elevation/1": "--shadow-1", "glass": { "shadow": "--glass", "blur": "--glass-blur" } },
//     "skip": ["internal/only"], "blurScale": 0.5 }
//   Styles not listed use the default name mapping (elevation/1 → --elevation-1).
//
// Effects parity requires the shadow to be TOKENISED as a CSS var (good practice). Box-shadows
// hardcoded inline in rules aren't resolved here.
//
// The comparison is SEMANTIC, not textual: both sides are parsed into shadow layers
// { inset, x, y, blur, spread, rgba } so equivalent CSS spellings never cause a false diff
// (`0` vs `0px`, an omitted spread, `inset` first or last, colour first or last, hex vs rgb(),
// `rgb(0 0 0 / 20%)`, rem lengths, a colour held in a nested var()). Alpha is compared at 8-bit
// precision. Layers are compared as a set (Figma's effect list order and CSS paint order are
// easy to invert and rarely matter visually); a mismatch names the exact field that differs.
//
// The snapshot accepts BOTH capture shapes the guide documents:
//   • a canonical string   "0px 1px 3px rgba(0, 0, 0, 0.2)[, …]"
//   • a structured array   [{ type: 'drop-shadow'|'inner-shadow', x, y, blur, spread, color, opacity },
//                           { type: 'layer-blur'|'background-blur', blur }]
// Blur effects are checked too: a Figma layer/background blur maps to CSS `blur(Npx)` (for
// `filter` / `backdrop-filter`). Figma's blur radius is twice the CSS blur() radius, so the
// expected CSS value is radius × `figma.effects.blurScale` (default 0.5, as Figma's own Dev Mode
// export does). A blur-only style is expected in the style's var; a style with shadows AND a blur
// expects the blur in `<var>-blur`. `explicit` may map a style to { shadow: '--x', blur: '--y' }.
//
// Exit 0 = all declared effect styles match (or not configured).  Exit 1 = a mismatch.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildResolver } from './mode-resolver.mjs';
import { resolveNamingSpec, tokenToVar } from './naming-convention.mjs';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS   = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();

const snap    = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const effects = snap.effects || {};
const ecfg    = cfg.figma?.effects || null;

if (!ecfg || Object.keys(effects).length === 0) {
  console.log('\n⏭  Effect parity - not configured (no snapshot.effects or figma.effects). Skipped.\n');
  process.exit(0);
}

const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const { resolveRaw } = buildResolver(rawCss, [{ name: 'Base', snapshotKey: 'root', cssSelector: 'root' }]);

const explicit = ecfg.explicit || {};
const skip     = new Set(ecfg.skip || []);
const NAMING   = resolveNamingSpec(cfg);
const styleToVar = (name) => tokenToVar(name, NAMING, { raw: true });

const BLUR_SCALE = Number.isFinite(+ecfg.blurScale) && +ecfg.blurScale > 0 ? +ecfg.blurScale : 0.5;
const REM_PX     = 16;

// ── Parsing ─────────────────────────────────────────────────────────────────────
// Substitute nested var() references (e.g. a shadow colour token) with their resolved literal.
function expandVars(value, depth = 0) {
  if (value == null || depth > 8) return value;
  return String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (m, name, fb) => {
    const r = resolveRaw(name, 'root');
    if (r != null) return expandVars(r, depth + 1);
    return fb != null ? expandVars(fb.trim(), depth + 1) : m;
  });
}

// Split on top-level commas only (commas inside rgba()/var() belong to the colour).
function splitTop(str, sep = ',') {
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

const NAMED = { black: [0, 0, 0, 1], white: [255, 255, 255, 1], transparent: [0, 0, 0, 0] };
// Any CSS colour we can reason about → [r, g, b, a] with a quantised to 8 bits; null if unknown.
function parseColor(tok) {
  const t = String(tok).trim().toLowerCase();
  let rgba = null;
  if (NAMED[t]) rgba = [...NAMED[t]];
  else if (/^#[0-9a-f]{3,8}$/.test(t)) {
    let h = t.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    const [r, g, b, a] = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16));
    rgba = [r, g, b, a / 255];
  } else {
    const m = t.match(/^rgba?\((.*)\)$/);
    if (!m) return null;
    const parts = m[1].includes(',') ? m[1].split(',') : m[1].replace('/', ' / ').split(/\s+/).filter(p => p && p !== '/');
    if (parts.length < 3) return null;
    const num = (p, scale) => p.trim().endsWith('%') ? parseFloat(p) / 100 * scale : parseFloat(p);
    rgba = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), parts[3] != null ? num(parts[3], 1) : 1];
    if (rgba.some(n => !Number.isFinite(n))) return null;
  }
  return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), Math.round(rgba[3] * 255) / 255];
}
const fmtColor = (c) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+c[3].toFixed(3)})`;

function parseLength(tok) {
  const m = String(tok).trim().toLowerCase().match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!m[2] && n !== 0) return null;          // a unitless non-zero length is invalid CSS
  return m[2] === 'rem' ? n * REM_PX : n;
}

// Tokenise one shadow layer (spaces at depth 0), classify inset / colour / lengths in any order.
function parseShadowLayer(str) {
  const toks = []; let depth = 0, cur = '';
  for (const ch of str.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) toks.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) toks.push(cur);
  let inset = false, color = null; const lens = [];
  for (const t of toks) {
    if (t.toLowerCase() === 'inset') { inset = true; continue; }
    const len = parseLength(t);
    if (len != null) { lens.push(len); continue; }
    const c = parseColor(t);
    if (c && !color) { color = c; continue; }
    return null;                                // unknown token → not a shadow we can compare
  }
  if (lens.length < 2 || lens.length > 4) return null;
  return { inset, x: lens[0], y: lens[1], blur: lens[2] ?? 0, spread: lens[3] ?? 0, color: color ?? [0, 0, 0, 1] };
}
function parseShadowList(str) {
  const s = String(str).trim();
  if (!s || s.toLowerCase() === 'none') return [];
  const layers = splitTop(s).map(parseShadowLayer);
  return layers.every(Boolean) ? layers : null;
}
function parseBlur(str) {
  const m = String(str).trim().toLowerCase().match(/^blur\(\s*([^)]+)\)$/);
  return m ? parseLength(m[1]) : parseLength(str);
}

// Normalise either snapshot shape → { shadows: [layer], blur: { layer?, background? }, bad? }.
function normaliseFigma(value) {
  if (typeof value === 'string') {
    const shadows = parseShadowList(value);
    return shadows ? { shadows, blur: {} } : { bad: `unparseable snapshot value "${value}"` };
  }
  if (!Array.isArray(value)) return { bad: 'snapshot value is neither a string nor an effect list' };
  const shadows = [], blur = {};
  for (const e of value) {
    if (!e || e.visible === false) continue;
    const type = String(e.type || '').toLowerCase().replace(/_/g, '-');
    if (type === 'drop-shadow' || type === 'inner-shadow') {
      let color = parseColor(e.color ?? '#000000') ?? [0, 0, 0, 1];
      // A 6-digit hex carries no alpha; the capture stores it in `opacity` instead.
      if (/^#[0-9a-f]{6}$/i.test(String(e.color ?? '')) && Number.isFinite(+e.opacity))
        color = [color[0], color[1], color[2], Math.round(+e.opacity * 255) / 255];
      shadows.push({ inset: type === 'inner-shadow', x: +e.x || 0, y: +e.y || 0, blur: +e.blur || 0, spread: +e.spread || 0, color });
    } else if (type === 'layer-blur') blur.layer = +e.blur || 0;
    else if (type === 'background-blur') blur.background = +e.blur || 0;
  }
  return { shadows, blur };
}

const EPS = 0.01;
const same = (a, b) => Math.abs(a - b) < EPS;
const layerKey = (l) => `${l.inset ? 'inset ' : ''}${+l.x.toFixed(2)}px ${+l.y.toFixed(2)}px ${+l.blur.toFixed(2)}px ${+l.spread.toFixed(2)}px ${fmtColor(l.color)}`;
const sameLayer = (a, b) => a.inset === b.inset && same(a.x, b.x) && same(a.y, b.y) && same(a.blur, b.blur)
  && same(a.spread, b.spread) && a.color.every((v, i) => same(v, b.color[i]));

// Set comparison of shadow layers; returns [] when equal, else human-readable field diffs.
function diffShadows(fig, css) {
  const left = [...css]; const unmatched = [];
  for (const f of fig) {
    const i = left.findIndex(c => sameLayer(f, c));
    if (i >= 0) left.splice(i, 1); else unmatched.push(f);
  }
  if (!unmatched.length && !left.length) return [];
  if (fig.length !== css.length) return [`layer count: Figma ${fig.length}, CSS ${css.length}`];
  // Same count: pair the leftovers in order and name each differing field.
  const out = [];
  unmatched.forEach((f, k) => {
    const c = left[k]; const n = fig.indexOf(f) + 1; const d = [];
    if (f.inset !== c.inset) d.push(`inset: Figma ${f.inset}, CSS ${c.inset}`);
    for (const fld of ['x', 'y', 'blur', 'spread']) if (!same(f[fld], c[fld])) d.push(`${fld}: Figma ${+f[fld].toFixed(2)}px, CSS ${+c[fld].toFixed(2)}px`);
    if (!f.color.every((v, i) => same(v, c.color[i]))) d.push(`color: Figma ${fmtColor(f.color)}, CSS ${fmtColor(c.color)}`);
    out.push(`layer ${n} ${d.join('; ')}`);
  });
  return out;
}

function varsFor(name, fig) {
  if (skip.has(name)) return null;
  const ex = Object.prototype.hasOwnProperty.call(explicit, name) ? explicit[name] : undefined;
  const hasBlur = fig.blur.layer != null || fig.blur.background != null;
  if (ex && typeof ex === 'object') return { shadow: ex.shadow ?? null, blur: ex.blur ?? null };
  const base = ex ?? styleToVar(name);
  if (!fig.shadows.length) return { shadow: null, blur: hasBlur ? base : null };
  return { shadow: base, blur: hasBlur ? `${base}-blur` : null };
}

// ── Compare ─────────────────────────────────────────────────────────────────────
const OK = [], BAD = [], SKIPPED = [];
for (const [name, value] of Object.entries(effects)) {
  if (skip.has(name)) { SKIPPED.push(`${name} (documented)`); continue; }
  const fig = normaliseFigma(value);
  if (fig.bad) { BAD.push({ name, cssVar: '-', diffs: [fig.bad] }); continue; }
  const vars = varsFor(name, fig);
  const diffs = []; const checked = []; const missing = [];

  if (fig.shadows.length && vars.shadow) {
    const raw = resolveRaw(vars.shadow, 'root');
    if (raw == null) missing.push(vars.shadow);
    else {
      const css = parseShadowList(expandVars(raw));
      if (!css) diffs.push(`${vars.shadow}: CSS value is not a parseable box-shadow ("${raw}")`);
      else diffs.push(...diffShadows(fig.shadows, css).map(d => `${vars.shadow}: ${d}`));
      checked.push(vars.shadow);
    }
  }
  const blurFig = fig.blur.layer ?? fig.blur.background;
  if (blurFig != null && vars.blur) {
    const raw = resolveRaw(vars.blur, 'root');
    if (raw == null) missing.push(vars.blur);
    else {
      const css = parseBlur(expandVars(raw));
      const want = blurFig * BLUR_SCALE;
      if (css == null) diffs.push(`${vars.blur}: CSS value is not a blur() length ("${raw}")`);
      else if (!same(css, want)) diffs.push(`${vars.blur}: blur Figma ${blurFig}px → CSS blur(${+want.toFixed(2)}px) expected, CSS has blur(${+css.toFixed(2)}px)`);
      checked.push(vars.blur);
    }
  }

  if (diffs.length) BAD.push({ name, cssVar: checked.join(' + ') || '-', diffs, value });
  else if (checked.length) OK.push(name);
  else SKIPPED.push(`${name} (no CSS var ${missing.join(' / ') || '(unmapped)'})`);
}

console.log(`\n✅ MATCH     ${OK.length}`);
console.log(`❌ MISMATCH  ${BAD.length}`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}`);
if (SKIPPED.length) for (const s of SKIPPED) console.log(`     ⏭  ${s}`);
if (BAD.length) {
  console.log('\n─── Effect mismatches ────────────────────────────────────────────');
  for (const b of BAD) {
    console.log(`  ❌ ${b.name} → ${b.cssVar}`);
    for (const d of b.diffs) console.log(`       ${d}`);
  }
  console.log('');
  process.exit(1);
}
console.log('\nAll declared effect styles match Figma. ✓\n');
process.exit(0);
