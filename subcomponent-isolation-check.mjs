// subcomponent-isolation-check.mjs — Run from project root: node scripts/subcomponent-isolation-check.mjs
//
// Hard Rule #8 — Sub-component style isolation:
//   A DS sub-component nested inside another DS component must always retain
//   its own CSS styles. This is what gives the UI consistency: a buttonTertiary
//   inside a node looks the same as a buttonTertiary anywhere else.
//
//   The trap: a parent component's rule ".parentClass svg { color: X }" uses a
//   DIRECT selector on the element — direct targeting beats inheritance. So even
//   if the sub-component sets "color: Y" on its container, the parent's rule wins
//   for SVGs inside it because it targets the SVG directly.
//
//   This script detects every CSS rule that combines a DS component class with a
//   bare element tag AND sets a visual property. Each such rule is a potential
//   sub-component override trap.
//
//   Every detected rule must appear in the ALLOWED map below, documenting:
//     a) LEAF — no DS sub-components nest inside this component class, OR
//     b) ISOLATED — explicit sub-component overrides are present later in the cascade
//     c) NON-VISUAL — rule sets only layout/motion properties (no color/fill/stroke)
//     d) OWNED CHILDREN — children are native HTML elements, not DS sub-components
//     e) ISOLATION FIX — this rule IS the override (it corrects a parent's broad rule)
//     f) PLUGIN-SPECIFIC — product-level wrapper whose children are not DS components
//     g) DECORATIVE — icon/illustration slot with no DS sub-components
//
// Requires at project root:
//   ds-config.json   — themeCSS + pluginCSS paths (sources to scan)
//
// Exit 0 = all broad rules documented. Exit 1 = new undocumented rule.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATHS = [].concat(cfg.paths?.themeCSS ?? 'src/theme.css');
const PLUGIN_CSS = cfg.paths?.pluginCSS ?? [];
const SOURCES = [...THEME_PATHS, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));

// ── Load project-specific ALLOWED broad rules from structure-contract.mjs ──────
// Export ALLOWED_BROAD_RULES from structure-contract.mjs at the project root.
// Key   = normalized selector (single spaces, no leading/trailing whitespace).
// Value = isolation proof (LEAF / ISOLATED / NON-VISUAL / OWNED CHILDREN /
//         ISOLATION FIX / PLUGIN-SPECIFIC / DECORATIVE).
// PLUGIN_DS_OVERRIDES: allowlist for plugin-file rules that restyle a DS base class
// (see the second check below). Key = normalized selector, value = reason.
let ALLOWED = {}, PLUGIN_OVERRIDES_ALLOWED = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.ALLOWED_BROAD_RULES && typeof m.ALLOWED_BROAD_RULES === 'object') {
    ALLOWED = m.ALLOWED_BROAD_RULES;
  }
  if (m.PLUGIN_DS_OVERRIDES && typeof m.PLUGIN_DS_OVERRIDES === 'object') {
    PLUGIN_OVERRIDES_ALLOWED = m.PLUGIN_DS_OVERRIDES;
  }
} catch { /* structure-contract.mjs optional */ }

// ── Visual properties that trigger the isolation check ───────────────────────
const VISUAL_RE = /\b(color|background|fill|stroke|border(-color)?)\s*:/;

// ── Bare element tags that form broad selectors when combined with a component class ──
const BARE_ELEMENTS = new Set(['svg', 'span', 'div', 'button', 'input', 'a', 'label', 'select', 'textarea']);

// ── CSS block extractor ───────────────────────────────────────────────────────
function extractRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i); if (open < 0) break;
    const selector = stripped.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < stripped.length && depth > 0) {
      if (stripped[j] === '{') depth++; else if (stripped[j] === '}') depth--; j++;
    }
    const body = stripped.slice(open + 1, j - 1).trim();
    if (body.includes('{')) rules.push(...extractRules(body));
    else for (const sel of selector.split(',')) rules.push({ selector: sel.trim(), body });
    i = j;
  }
  return rules;
}

function normalizeSelector(sel) { return sel.replace(/\s+/g, ' ').trim(); }

function broadElementTag(sel) {
  const m = sel.match(/\s+(svg|span|div|button|input|a|label|select|textarea)(?:[:.][a-zA-Z0-9-:()]+)*$/);
  if (!m || !BARE_ELEMENTS.has(m[1])) return null;
  if (!/\.[a-zA-Z]/.test(sel.slice(0, sel.lastIndexOf(m[0])))) return null;
  return m[1];
}

// ── Run the check ─────────────────────────────────────────────────────────────
const newRules = [], documented = [];

for (const srcPath of SOURCES) {
  const text = readFileSync(join(ROOT, srcPath), 'utf8');
  for (const { selector, body } of extractRules(text)) {
    const tag = broadElementTag(selector);
    if (!tag || !VISUAL_RE.test(body)) continue;
    const key = normalizeSelector(selector);
    if (ALLOWED[key]) documented.push({ key, reason: ALLOWED[key], file: srcPath });
    else newRules.push({ key, body: body.slice(0, 120), file: srcPath });
  }
}

// ── Plugin overrides of DS base classes ───────────────────────────────────────
// A class with a standalone base rule in theme CSS (`.x { ... }`) is a DS component
// class — its visual identity belongs to the base. Any PLUGIN-file rule that targets
// such a class AND sets identity properties (color, background, border, padding, gap,
// height, font, radius, opacity, shadow) overrides the DS and must be documented in
// PLUGIN_DS_OVERRIDES (structure-contract.mjs) with a reason. Layout-only rules
// (width, margin, position, flex, z-index, ...) are consumer placement and pass freely.
const IDENTITY_RE = /(^|[;{]|\s)(color|background[\w-]*|border[\w-]*|padding[\w-]*|gap|height|min-height|font-size|font-weight|line-height|letter-spacing|text-transform|opacity|box-shadow|fill|stroke)\s*:/;

const dsBaseClasses = new Set();
for (const themePath of THEME_PATHS.filter(f => existsSync(join(ROOT, f)))) {
  const text = readFileSync(join(ROOT, themePath), 'utf8');
  for (const { selector } of extractRules(text)) {
    const m = selector.match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)$/);
    if (m) dsBaseClasses.add(m[1]);
  }
}

const overrideNew = [], overrideDocumented = [];
for (const srcPath of PLUGIN_CSS.filter(f => existsSync(join(ROOT, f)))) {
  const text = readFileSync(join(ROOT, srcPath), 'utf8');
  for (const { selector, body } of extractRules(text)) {
    if (!IDENTITY_RE.test(body)) continue;
    const hit = [...dsBaseClasses].find(c => new RegExp(`\\.${c}(?![\\w-])`).test(selector));
    if (!hit) continue;
    const key = normalizeSelector(selector);
    if (PLUGIN_OVERRIDES_ALLOWED[key]) overrideDocumented.push({ key, reason: PLUGIN_OVERRIDES_ALLOWED[key], file: srcPath });
    else overrideNew.push({ key, cls: hit, body: body.slice(0, 120), file: srcPath });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n─── Sub-component style isolation (Hard Rule #8) ───────────────────\n');

if (documented.length) {
  console.log(`✅ DOCUMENTED  ${documented.length}  (broad rules verified safe)`);
  for (const r of documented) {
    console.log(`   ✅ ${r.key}`);
    console.log(`      ${r.reason}`);
  }
  console.log();
}

if (newRules.length === 0) {
  console.log('✅ No new undocumented broad element selectors with visual properties.\n');
} else {
  console.log(`❌ UNDOCUMENTED  ${newRules.length}  (new broad rules — verify sub-component isolation)\n`);
  for (const r of newRules) {
    console.log(`   ❌ "${r.key}"  in ${r.file}`);
    console.log(`      body: { ${r.body.replace(/\n/g, ' ').replace(/\s+/g, ' ')} }`);
    console.log(`      → Either prove this is a LEAF component (add to ALLOWED with reason),`);
    console.log(`        or add explicit .<subComponent> elementTag { } override rules later in the cascade.\n`);
  }
}

console.log('\n─── Plugin overrides of DS base classes ─────────────────────────────\n');
console.log(`   (${dsBaseClasses.size} DS base classes derived from theme CSS)`);

if (overrideDocumented.length) {
  console.log(`✅ DOCUMENTED  ${overrideDocumented.length}  (plugin overrides with a recorded reason)`);
  for (const r of overrideDocumented) {
    console.log(`   ✅ ${r.key}`);
    console.log(`      ${r.reason}`);
  }
  console.log();
}

if (overrideNew.length === 0) {
  console.log('✅ No undocumented plugin overrides of DS base classes.\n');
} else {
  console.log(`❌ UNDOCUMENTED  ${overrideNew.length}  (plugin rules restyling a DS base class)\n`);
  for (const r of overrideNew) {
    console.log(`   ❌ "${r.key}"  in ${r.file}  (DS class: .${r.cls})`);
    console.log(`      body: { ${r.body.replace(/\n/g, ' ').replace(/\s+/g, ' ')} }`);
    console.log(`      → Move the styling into the DS base (theme CSS), or document the override`);
    console.log(`        in PLUGIN_DS_OVERRIDES (structure-contract.mjs) with a really good reason.\n`);
  }
}

process.exit(newRules.length === 0 && overrideNew.length === 0 ? 0 : 1);
