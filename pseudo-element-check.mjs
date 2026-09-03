// pseudo-element-check.mjs - Run from project root: node ../rms-parity/pseudo-element-check.mjs
//
// Hard Rule #14 - Pseudo-element content audit:
//   Every ::before / ::after rule on a DS component selector that sets `content`
//   (creating a visible layer) must be declared in PSEUDO_ELEMENTS in
//   structure-contract.mjs with what Figma layer it corresponds to.
//
//   Why: pseudo-elements are invisible to token checks - they can add visual
//   content (chevrons, pills, indicators) that has no Figma backing. Without
//   this gate, those additions silently diverge from DS design.
//
//   Each entry in PSEUDO_ELEMENTS must be one of:
//     DS PILL      - pill/fill layer that exists in the Figma DS component
//     DS INDICATOR - visual indicator explicitly in the DS component
//     LAYOUT       - non-visual utility (resize handles, clearfixes, etc.)
//
// Requires at project root:
//   ds-config.json   - themeCSS + pluginCSS paths (sources to scan)
//   structure-contract.mjs - PSEUDO_ELEMENTS export
//
// Exit 0 = all content-setting pseudo-elements documented. Exit 1 = new ones found.

import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();   // themeCSS may be an array of files
const THEME_PATH  = THEME_PATHS[0];
const PLUGIN_CSS = cfg.paths?.pluginCSS ?? [];
const SOURCES = [...THEME_PATHS, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));

// ── Load PSEUDO_ELEMENTS from structure-contract.mjs ─────────────────────────
let ALLOWED = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.PSEUDO_ELEMENTS && typeof m.PSEUDO_ELEMENTS === 'object') {
    ALLOWED = m.PSEUDO_ELEMENTS;
  }
} catch { /* optional */ }

// ── CSS rule extractor (handles nesting: :root {}, @media {}) ─────────────────
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

// Matches ::before or ::after anywhere in the selector
const PSEUDO_RE = /::(?:before|after)/;
// A pseudo-element sets VISIBLE content when it declares `content:` with a value other than
// the empty string, `none`, or `normal` (all of which render nothing). Parsing the value
// (rather than a lookahead) avoids the `\s*` backtracking that let `content: none` through.
function setsVisibleContent(body) {
  for (const m of body.matchAll(/\bcontent\s*:\s*([^;}]+)/g)) {
    const v = m[1].replace(/!important/i, '').trim();
    if (!/^(?:''|""|none|normal)$/.test(v)) return true;
  }
  return false;
}

// ── Scan ──────────────────────────────────────────────────────────────────────
const undocumented = [], documented = [];

for (const srcPath of SOURCES) {
  const text = readFileSync(join(ROOT, srcPath), 'utf8');
  for (const { selector, body } of extractRules(text)) {
    if (!PSEUDO_RE.test(selector)) continue;
    if (!setsVisibleContent(body)) continue;
    const key = normalizeSelector(selector);
    if (ALLOWED[key]) documented.push({ key, reason: ALLOWED[key], file: srcPath });
    else              undocumented.push({ key, body: body.slice(0, 120), file: srcPath });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n─── Pseudo-element content audit (Hard Rule #14) ───────────────────\n');

if (documented.length) {
  console.log(`✅ DOCUMENTED  ${documented.length}  (pseudo-elements verified against Figma DS)`);
  for (const r of documented) {
    console.log(`   ✅ ${r.key}`);
    console.log(`      ${r.reason}`);
  }
  console.log();
}

if (undocumented.length === 0) {
  console.log('✅ No undocumented content-setting pseudo-elements.\n');
  process.exit(0);
} else {
  console.log(`❌ UNDOCUMENTED  ${undocumented.length}  (pseudo-elements with no Figma DS backing declared)\n`);
  for (const r of undocumented) {
    console.log(`   ❌ "${r.key}"  in ${r.file}`);
    console.log(`      body: { ${r.body.replace(/\n/g, ' ').replace(/\s+/g, ' ')} }`);
    console.log(`      → Check Figma DS: does this state/component have this visual layer?`);
    console.log(`        If yes: add to PSEUDO_ELEMENTS in structure-contract.mjs with "DS PILL/INDICATOR" reason.`);
    console.log(`        If no:  remove the pseudo-element rule from CSS.\n`);
  }
  process.exit(1);
}
