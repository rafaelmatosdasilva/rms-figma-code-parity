// state-opacity-check.mjs - part of Gate 11 (All states are built).
// Run from project root: node scripts/state-opacity-check.mjs
//
// A state often dims the component (a disabled button at opacity 0.4). This verifies
// that per-state opacity VALUE in the code matches Figma. Reads an optional per-state
// opacity map from the structure snapshot:
//   components[Comp].variantOpacity = { "disabled": 0.4, "hover": 1 }
// (or a single components[Comp].disabledOpacity = 0.4). Inert until the snapshot carries
// it - so it never false-positives before the capture is updated.
//
// Exit 0 = every captured state opacity matches the CSS (or there is nothing to check).
// Exit 1 = a state's CSS opacity differs from Figma.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}
const SNAP_STRUCT = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';
let components = {};
try { components = JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8')).components ?? {}; } catch {
  console.log('⏭  state opacity: no structure snapshot - skipped'); process.exit(0);
}

const THEME = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const PLUGIN = cfg.paths?.pluginCSS ?? [];
let css = '';
for (const f of [...THEME, ...PLUGIN]) { try { css += '\n' + readFileSync(join(ROOT, f), 'utf8'); } catch { /* optional */ } }
css = css.replace(/\/\*[\s\S]*?\*\//g, '');   // strip comments

const baseSelector = (name) => cfg.componentSelectors?.[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// state word -> the CSS selector fragments that express it
const STATE_SEL = {
  disabled: [':disabled', '.disabled', '[disabled]', '.is-disabled'],
  hover:    [':hover', '.hover', '.is-hover'],
  focus:    [':focus', ':focus-visible', '.focus'],
  active:   [':active', '.active', '.is-active'],
  pressed:  [':active', '.pressed'],
  selected: ['.selected', '[aria-selected="true"]', '.is-selected'],
  checked:  [':checked', '.checked'],
  loading:  ['.loading', '.is-loading', '[aria-busy="true"]'],
};

// Read the opacity declared on a rule whose selector is base+stateFragment.
function cssOpacity(base, fragment) {
  const re = new RegExp(`${esc(base)}\\s*${esc(fragment)}[^{]*\\{([^}]*)\\}`, 'i');
  const block = css.match(re)?.[1];
  if (!block) return null;
  const m = block.match(/(?:^|;|\{)\s*opacity\s*:\s*([0-9.]+)/i);
  return m ? parseFloat(m[1]) : null;
}

const PASS = [], FAIL = [], SKIP = [];
for (const [comp, c] of Object.entries(components)) {
  const map = c?.variantOpacity ?? (typeof c?.disabledOpacity === 'number' ? { disabled: c.disabledOpacity } : null);
  if (!map || typeof map !== 'object') continue;
  const base = baseSelector(comp);
  for (const [state, expected] of Object.entries(map)) {
    if (typeof expected !== 'number') continue;
    const frags = STATE_SEL[state.toLowerCase()];
    if (!frags) { SKIP.push(`${comp}/${state}: unknown state - no CSS selector mapping`); continue; }
    let got = null;
    for (const f of frags) { got = cssOpacity(base, f); if (got != null) break; }
    if (got == null) { SKIP.push(`${comp}/${state}: no opacity rule found on ${base}${frags[0]} - not verified`); continue; }
    if (Math.abs(got - expected) < 1e-6) PASS.push(`${comp}/${state} opacity ${got}`);
    else FAIL.push(`${comp}/${state}: CSS opacity ${got} ≠ Figma ${expected}  (${base}${frags[0]})`);
  }
}

console.log(`\n✅ CORRECT   ${PASS.length}`);
console.log(`❌ MISMATCH  ${FAIL.length}   (state opacity differs from Figma)`);
if (SKIP.length) console.log(`⏭ SKIP      ${SKIP.length}   (no captured value or no rule found - advisory)`);
if (FAIL.length) { console.log('\n─── State opacity differs from Figma ──'); for (const l of FAIL) console.log(`  ❌ ${l}`); }
if (!PASS.length && !FAIL.length) console.log('   (no per-state opacity captured in the snapshot yet - nothing to check)');

process.exit(FAIL.length ? 1 : 0);
