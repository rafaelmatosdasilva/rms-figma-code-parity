// component-selector-check.mjs - Gate [17]: state var → state selector.
// For each DS component-prefixed CSS var ending with a state keyword
// (hover/selected/disabled/focus/checked), verify it only appears in selectors
// that have a matching state indicator.
// A state var in a default-state selector means the wrong value applies to the
// wrong interaction state - the kind of drift Gate [4] never catches.
//
// State indicator detection (two sources):
//   1. Standard CSS patterns - :hover, .selected, :disabled, :focus, :checked, etc.
//   2. CONTRACT.propertyMap - project-specific state selectors derived from Figma states
//      (e.g. radioButton.State.Selected → ".depth-option.done"; "done" in selector)
//
// Only checks vars where the prefix before the state suffix is a known DS component name.
// System/semantic vars like --text-disabled or --text-muted are intentionally skipped.
//
// "active" is excluded from STATE_SUFFIXES - buttonTertiary maps its Figma "active"
// state to CSS :hover, making the mismatch intentional everywhere.
//
// Requires at project root:
//   ds-config.json          - themeCSS + pluginCSS + optional knownStateExemptions[]
//   structure-contract.mjs  - CONTRACT (for propertyMap-derived state selectors)
//   parity-map.mjs          - SYSTEM_VARS (excluded from this check)
//
// Exit 0 = all state vars appear in matching state selectors.  Exit 1 = mismatches found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const PLUGIN_CSS  = cfg.paths?.pluginCSS ?? [];

// Exemptions: { var: "--foo-bar-hover", selector: ".some-selector" } pairs
// that are intentional mismatches (mirrors, semantic reuse, etc.).
const EXEMPTIONS = new Set(
  (cfg.knownStateExemptions ?? []).map(({ var: v, selector: s }) => `${v}|${s}`)
);

let CONTRACT = {};
try {
  const mod = await import(join(ROOT, 'structure-contract.mjs'));
  CONTRACT = mod.CONTRACT ?? {};
} catch { /* no contract - runs with empty map */ }

let SYSTEM_VARS = new Set();
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.SYSTEM_VARS) SYSTEM_VARS = map.SYSTEM_VARS;
} catch { /* optional */ }

// ── Known DS component name prefixes ─────────────────────────────────────────
// Only vars where the prefix (before the state suffix) matches a known component
// are subject to this check. Semantic vars like --text-disabled are excluded.
const KNOWN_COMPONENTS = new Set([
  ...Object.keys(CONTRACT),
  ...Object.values(CONTRACT).map(e => e?.figmaName).filter(Boolean),
  // Common DS component prefixes not always in CONTRACT
  'buttonPrimary', 'emptyState', 'listItem', 'statusbar', 'tableRow',
  'radioButton', 'overflowList', 'dividerSection',
]);
// Normalised lookup too, so a figmaName like "Radio Button" (spaces/caps) still matches a
// var-derived candidate like "radio-button" / "radioButton".
const _normComp = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const KNOWN_COMPONENTS_NORM = new Set([...KNOWN_COMPONENTS].map(_normComp));

// ── Build state indicator sets ────────────────────────────────────────────────
// Uses substring match (no dot/colon required) so ".node-selected", ".inputWrap--disabled",
// etc. all match without needing an exact pattern per component.
const stateIndicators = {
  hover:    new Set(['hover']),    // :hover, .hover, .hovered, *-hover
  selected: new Set(['selected']), // .selected, .node-selected, aria-selected
  disabled: new Set(['disabled']), // :disabled, .disabled, .inputWrap--disabled
  focus:    new Set(['focus']),    // :focus, :focus-within, .focused
  checked:  new Set(['checked']),  // :checked
};

// Augment from CONTRACT.propertyMap: Figma state names → CSS selectors.
// e.g. radioButton.State.Selected → ".depth-option.done" → adds "done" to selected indicators
// and adds ".depth-option.done" as an exact fragment.
for (const def of Object.values(CONTRACT)) {
  if (!def.propertyMap) continue;
  for (const [, propVal] of Object.entries(def.propertyMap)) {
    if (!propVal || typeof propVal !== 'object') continue;
    for (const [stateKey, stateSel] of Object.entries(propVal)) {
      if (!stateSel || typeof stateSel !== 'string') continue;
      if (stateSel.startsWith('@')) continue;
      const k = stateKey.toLowerCase();
      for (const suffix of Object.keys(stateIndicators)) {
        if (k === suffix || k.includes(suffix)) {
          // Add the full selector as a known indicator fragment.
          stateIndicators[suffix].add(stateSel);
          // Also add the BEM modifier / class suffix (last class in the selector).
          const lastClass = stateSel.split(/[\s:>+~]/).pop();
          if (lastClass) stateIndicators[suffix].add(lastClass);
        }
      }
    }
  }
}

// ── STATE_SUFFIXES ────────────────────────────────────────────────────────────
// "active" is excluded - buttonTertiary maps Figma "active" → CSS :hover.
const STATE_SUFFIXES = new Set(['hover', 'selected', 'disabled', 'focus', 'checked']);

// ── Read and parse CSS ────────────────────────────────────────────────────────
const allCSS = [...THEME_PATHS, ...PLUGIN_CSS]
  .filter(p => existsSync(join(ROOT, p)))
  .map(p => {
    let src = readFileSync(join(ROOT, p), 'utf8');
    // Strip <script>...</script> blocks from HTML to avoid JS code being parsed as CSS.
    src = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    return src;
  })
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Parse flat CSS rules: selector → body pairs.
const rules = [];
for (const m of allCSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const raw = m[1].trim().replace(/\s+/g, ' ');
  const body = m[2];
  if (!raw || raw.startsWith('@')) continue;
  for (const part of raw.split(',')) {
    const sel = part.trim();
    if (sel) rules.push({ sel, body });
  }
}

// ── Check each rule ───────────────────────────────────────────────────────────
const mismatches = [];
const ok = [];

for (const { sel, body } of rules) {
  // Skip :root declarations (var definitions, not component usage).
  if (/^:root\b/.test(sel) || /^html\b/.test(sel) || sel === '*') continue;
  // Skip @media/@keyframes inside rules (shouldn't happen with flat regex, but guard anyway).
  if (sel.startsWith('@')) continue;

  for (const match of body.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    const varName = match[1];
    if (SYSTEM_VARS.has(varName)) continue; // system/semantic vars are exempt

    const parts = varName.slice(2).split('-'); // drop "--"

    // The last segment is the potential state suffix.
    const lastSeg = parts[parts.length - 1];
    if (!STATE_SUFFIXES.has(lastSeg)) continue;

    // Only check vars whose prefix matches a known DS component name.
    // e.g. "buttonList" from "--buttonList-text-hover"; "text" from "--text-disabled" → skip
    let compName = null;
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('-');
      if (KNOWN_COMPONENTS.has(candidate) || KNOWN_COMPONENTS_NORM.has(_normComp(candidate))) { compName = candidate; break; }
    }
    if (!compName) continue;

    // Apply per-entry exemptions.
    if (EXEMPTIONS.has(`${varName}|${sel}`)) { ok.push(`${varName}|${sel}`); continue; }

    // Check if selector contains any known state indicator for this suffix.
    const indicators = stateIndicators[lastSeg];
    const selectorLower = sel.toLowerCase();
    let hasIndicator = false;
    for (const ind of indicators) {
      if (selectorLower.includes(ind.toLowerCase())) { hasIndicator = true; break; }
    }

    if (hasIndicator) {
      ok.push(`${varName}|${sel}`);
    } else {
      mismatches.push({ varName, selector: sel, stateExpected: lastSeg });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const nOk = ok.length;
const nFail = mismatches.length;

console.log(`\n✅ CORRECT   ${nOk}  state-var usages in matching state selectors`);
console.log(`❌ MISMATCH  ${nFail}  state-var usages in non-state selectors`);

if (nFail > 0) {
  console.log('\n─── State var used outside its state selector ──');
  console.log('    (Fix: move to state selector, use a neutral var, or add to knownStateExemptions)');
  for (const { varName, selector, stateExpected } of mismatches) {
    console.log(`  🚨 ${varName}  in  "${selector}"  (expected "${stateExpected}" in selector)`);
  }
  console.log('');
  process.exit(1);
}

console.log('\nAll state vars appear inside matching state selectors. ✓\n');
process.exit(0);
