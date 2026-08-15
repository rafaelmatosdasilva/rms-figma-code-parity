// effect-check.mjs — Gate: effect-style parity (Figma shadow styles → CSS box-shadow).
//
// DS-AGNOSTIC and OPT-IN. A no-op (exit 0) unless BOTH:
//   • the snapshot has an `effects` map ({ styleName: "<canonical box-shadow>" }), captured from
//     Figma's local effect styles (drop/inner shadows → "x y blur spread color[, …]"), and
//   • ds-config.json declares `figma.effects` mapping each style to a CSS var holding its box-shadow.
//
// ds-config.json → figma.effects:
//   { "explicit": { "elevation/1": "--shadow-1" }, "skip": ["internal/only"] }
//   Styles not listed use the default name mapping (elevation/1 → --elevation-1).
//
// Effects parity requires the shadow to be TOKENISED as a CSS var (good practice). Box-shadows
// hardcoded inline in rules aren't resolved here. Colours are normalised to rgba() on both sides so
// #rrggbb vs rgb()/rgba() don't cause false diffs; whitespace is collapsed.
//
// Exit 0 = all declared effect styles match (or not configured).  Exit 1 = a mismatch.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildResolver } from './mode-resolver.mjs';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS   = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();

const snap    = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const effects = snap.effects || {};
const ecfg    = cfg.figma?.effects || null;

if (!ecfg || Object.keys(effects).length === 0) {
  console.log('\n⏭  Effect parity — not configured (no snapshot.effects or figma.effects). Skipped.\n');
  process.exit(0);
}

const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const { resolveRaw } = buildResolver(rawCss, [{ name: 'Base', snapshotKey: 'root', cssSelector: 'root' }]);

const explicit = ecfg.explicit || {};
const skip     = new Set(ecfg.skip || []);
function styleToVar(name) {
  if (skip.has(name)) return null;
  if (Object.prototype.hasOwnProperty.call(explicit, name)) return explicit[name];
  return '--' + name.replace(/\//g, '-');
}

// Canonicalise a box-shadow so equivalent colour/space forms compare equal:
// lowercase, collapse whitespace after commas, and rewrite #rgb/#rrggbb[aa] → rgba(r, g, b, a).
function hexToRgba(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8) return hex;
  const [r, g, b, a] = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
}
function canon(shadow) {
  return String(shadow).trim().toLowerCase()
    .replace(/#[0-9a-f]{3,8}\b/g, m => hexToRgba(m))
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/rgba?\(([^)]*)\)/g, (_, inner) => 'rgba(' + inner.replace(/\s+/g, '') + ')'); // strip spaces INSIDE color fns
}

const OK = [], BAD = [], SKIPPED = [];
for (const [name, figmaShadow] of Object.entries(effects)) {
  const cssVar = styleToVar(name);
  if (cssVar === null) { SKIPPED.push(`${name} (documented)`); continue; }
  const css = resolveRaw(cssVar, 'root');
  if (css == null) { SKIPPED.push(`${name} (no CSS var ${cssVar})`); continue; }
  if (canon(css) === canon(figmaShadow)) OK.push(name);
  else BAD.push({ name, cssVar, figmaShadow, css });
}

console.log(`\n✅ MATCH     ${OK.length}`);
console.log(`❌ MISMATCH  ${BAD.length}`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}`);
if (BAD.length) {
  console.log('\n─── Effect mismatches ────────────────────────────────────────────');
  for (const b of BAD) {
    console.log(`  ❌ ${b.name} → ${b.cssVar}`);
    console.log(`       Figma: ${b.figmaShadow}`);
    console.log(`       CSS:   ${b.css}`);
  }
  console.log('');
  process.exit(1);
}
console.log('\nAll declared effect styles match Figma. ✓\n');
process.exit(0);
