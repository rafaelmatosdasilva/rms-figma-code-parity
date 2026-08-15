// motion-check.mjs — Gate: motion-token parity (easing + duration variables → CSS).
//
// DS-AGNOSTIC and OPT-IN. A no-op (exit 0) unless BOTH:
//   • the snapshot has a `motion` map ({ tokenName: value }), and
//   • ds-config.json declares `figma.motion`.
// Then each motion token's Figma value is compared to its CSS var, resolved through :root.
//
// ds-config.json → figma.motion:
//   { "explicit": { "motion/easing/standard": "--easing-standard" }, "skip": ["motion/internal/x"] }
//   Tokens not listed use the default name mapping (motion/easing/standard → --motion-easing-standard).
//
// Values compared as normalised literals (whitespace-collapsed, lowercased), so
// "cubic-bezier(0.2, 0, 0, 1)" == "cubic-bezier(0.2,0,0,1)" and "200ms" == "200MS".
//
// Exit 0 = all declared motion tokens match (or not configured).  Exit 1 = a mismatch.

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

const snap   = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const motion = snap.motion || {};
const mcfg   = cfg.figma?.motion || null;

if (!mcfg || Object.keys(motion).length === 0) {
  console.log('\n⏭  Motion parity — not configured (no snapshot.motion or figma.motion). Skipped.\n');
  process.exit(0);
}

const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const { resolveRaw } = buildResolver(rawCss, [{ name: 'Base', snapshotKey: 'root', cssSelector: 'root' }]);

const explicit = mcfg.explicit || {};
const skip     = new Set(mcfg.skip || []);
const norm     = (s) => String(s).trim().replace(/\s+/g, '').toLowerCase();
function tokenToVar(t) {
  if (skip.has(t)) return null;
  if (Object.prototype.hasOwnProperty.call(explicit, t)) return explicit[t];
  return '--' + t.replace(/\//g, '-');
}

const OK = [], BAD = [], SKIPPED = [];
for (const [token, figmaVal] of Object.entries(motion)) {
  const cssVar = tokenToVar(token);
  if (cssVar === null) { SKIPPED.push(`${token} (documented)`); continue; }
  const css = resolveRaw(cssVar, 'root');
  if (css == null) { SKIPPED.push(`${token} (no CSS var ${cssVar})`); continue; }
  if (norm(css) === norm(figmaVal)) OK.push(token);
  else BAD.push({ token, cssVar, figmaVal, css });
}

console.log(`\n✅ MATCH     ${OK.length}`);
console.log(`❌ MISMATCH  ${BAD.length}`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}`);
if (BAD.length) {
  console.log('\n─── Motion mismatches ────────────────────────────────────────────');
  for (const b of BAD) console.log(`  ❌ ${b.token} → ${b.cssVar}: Figma ${b.figmaVal}, CSS ${b.css}`);
  console.log('');
  process.exit(1);
}
console.log('\nAll declared motion tokens match Figma. ✓\n');
process.exit(0);
