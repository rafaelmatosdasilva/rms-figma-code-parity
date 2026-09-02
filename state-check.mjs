// state-check.mjs — Run from project root: node scripts/state-check.mjs
// Gate [10]: every token found in a full COMPONENT_SET variant walk must be
// covered by a CSS var, an EXPLICIT mapping, or an approved COVERED entry.
//
// Unlike bound-check.mjs (which only sees tokens used in instantiated DS frames),
// this gate walks ALL COMPONENT_SET states (hover, selected, disabled, etc.) so
// that state tokens defined in the DS but not yet used in any plugin frame are
// still verified.
//
// Requires at project root:
//   ds-config.json              — themeCSS + pluginCSS paths
//   parity-map.mjs              — COVERED_STATE (or COVERED), COVERED_PREFIX, EXPLICIT
//   component-state-tokens.json — output of Phase 2 COMPONENT_SET state walk
//
// Exit 0 = all state tokens covered.
// Exit 1 = uncovered state token(s).
// Exit 2 = component-state-tokens.json missing (gate did NOT run — never a pass).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}
const THEME_PATH = cfg.paths?.themeCSS  ?? 'src/theme.css';
const PLUGIN_CSS = cfg.paths?.pluginCSS ?? [];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let COVERED = new Set(), COVERED_PREFIX = [], EXPLICIT = {}, EXPLICIT_SIZING = {};
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  // Prefer COVERED_STATE (state-walk superset) if provided, fall back to COVERED
  if (map.COVERED_STATE)  COVERED        = map.COVERED_STATE;
  else if (map.COVERED)   COVERED        = map.COVERED;
  if (map.COVERED_PREFIX) COVERED_PREFIX = map.COVERED_PREFIX;
  if (map.EXPLICIT)       EXPLICIT       = map.EXPLICIT;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
} catch { /* optional — runs with empty maps */ }

// ── Load component-state-tokens.json ─────────────────────────────────────────
if (!existsSync(join(ROOT, 'component-state-tokens.json'))) {
  console.log('\n⚠️  component-state-tokens.json not found at project root.');
  console.log('   Run Phase 2 COMPONENT_SET state walk in Figma and save output here.');
  console.log('   (exit 2 — treated as "not run", never as a pass)\n');
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(join(ROOT, 'component-state-tokens.json'), 'utf8'));
// _-prefixed keys are metadata (_updated stamp), not tokens
const stateTokens = Object.keys(parsed).filter(t => !t.startsWith('_'));
// Hard Rule 7: tokens bound only on hidden nodes are not a hard requirement in this
// project — the element is switched off here (it may be toggled on elsewhere). They
// are deferred, not failed. _hiddenToggleable is the subset gated by a visibility
// boolean ("off in this project"); the rest are statically hidden.
const hiddenOnly   = new Set(Array.isArray(parsed._hiddenOnly) ? parsed._hiddenOnly : []);
const hiddenToggle = new Set(Array.isArray(parsed._hiddenToggleable) ? parsed._hiddenToggleable : []);

// ── Collect declared CSS vars ─────────────────────────────────────────────────
const declared = new Set();
const sources = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
for (const f of sources) {
  const txt = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of txt.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);
}

// ── Coverage check ────────────────────────────────────────────────────────────
function normalize(token) { return token.replace(/\/color$/, ''); }

function isCovered(token) {
  const t = normalize(token);
  if (t.startsWith('primitives/')) return true;
  if (COVERED.has(t)) return true;
  if (COVERED_PREFIX.some(p => t.startsWith(p))) return true;
  if (EXPLICIT[t] && declared.has(EXPLICIT[t])) return true;
  if (EXPLICIT_SIZING[t] && declared.has(EXPLICIT_SIZING[t])) return true;
  const v = '--' + t.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
  if (declared.has(v)) return true;
  if (declared.has('--' + t.replace(/\//g, '-'))) return true;
  return false;
}

// Hard Rule 7 — three states, not two:
//   • visible token          → REQUIRED now; missing var ⇒ ❌ UNCOVERED (fails the gate)
//   • hidden + boolean        → may be TOGGLED ON later; the code must PERMIT that. If the
//                               CSS var exists the code already supports activation (OK); if
//                               it is missing, the element would not render when switched on
//                               ⇒ ⚠️ advisory (surfaced, but does NOT fail — it is off here)
//   • hidden, no boolean      → statically off/dead ⇒ ⏭ ignored, never a requirement
const UNCOVERED = [], OK = [], TOGGLE_WARN = [], HIDDEN_STATIC = [];
for (const token of stateTokens) {
  const covered = isCovered(token);
  if (!hiddenOnly.has(token)) {
    (covered ? OK : UNCOVERED).push(token);            // visible — required now
  } else if (hiddenToggle.has(token)) {
    if (covered) OK.push(token);                       // code already permits activation
    else TOGGLE_WARN.push(token);                      // activation NOT yet supported — advise
  } else {
    HIDDEN_STATIC.push(token);                         // dead here — ignore
  }
}

console.log(`\n✅ COVERED   ${OK.length}`);
console.log(`❌ UNCOVERED ${UNCOVERED.length}`);
if (TOGGLE_WARN.length)   console.log(`⚠️ UNCOVERED-TOGGLEABLE ${TOGGLE_WARN.length} (hidden+boolean, no CSS var — code cannot render it when toggled on; advisory, not blocking)`);
if (HIDDEN_STATIC.length) console.log(`⏭ HIDDEN-STATIC ${HIDDEN_STATIC.length} (hidden, no visibility boolean — not a requirement)`);

if (TOGGLE_WARN.length) {
  console.log('\n─── Advisory: hidden but visibility-toggleable — the element can be switched on later, so verify the code PERMITS it (declare the CSS var so it renders when shown) ──');
  for (const t of TOGGLE_WARN.slice(0, 12)) console.log(`  ⚠️ ${t}`);
}
if (HIDDEN_STATIC.length) {
  console.log('\n─── Ignored: statically hidden (off, no visibility boolean) ──');
  for (const t of HIDDEN_STATIC.slice(0, 20)) console.log(`  ⏭ ${t}`);
}

if (UNCOVERED.length) {
  console.log('\n─── In COMPONENT_SET variants (visible), no CSS var (implement or add to COVERED_STATE in parity-map.mjs) ──');
  for (const t of UNCOVERED) console.log(`  ❌ ${t}`);
  console.log('');
  process.exit(1);
} else {
  console.log('\nAll visible COMPONENT_SET state tokens are implemented. Toggleable-hidden advisories above (if any) do not block. ✓\n');
  process.exit(0);
}
