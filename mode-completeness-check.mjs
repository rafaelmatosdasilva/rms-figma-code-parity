// dark-mode-check.mjs — Gate [12]: verify every color token with a different
// Figma light vs. dark value actually resolves to a different hex in CSS dark mode.
//
// Gate [2] catches wrong values. This gate catches the structural gap: a missing
// dark override causes the var to silently fall through to the light value, even
// when Figma specifies a different dark hex.
//
// A token "adapts" when:
//   • resolve(cssVar, 'dark') !== resolve(cssVar, 'light')  → different hex ✅
//   • token is in SKIP_TOKENS (no CSS var — documented) ✅
//   • EXPLICIT maps it to null (rgba — no comparison) ✅
//
// Requires at project root:
//   ds-config.json   — snapshot path, themeCSS
//   parity-map.mjs   — EXPLICIT, SKIP_TOKENS, NEUTRAL_LIGHT/DARK, NEUTRAL_VAR_RE
//
// Exit 0 = all mode-variant tokens adapt correctly.  Exit 1 = missing dark adaptation.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadModes, buildResolver } from './mode-resolver.mjs';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const THEME_PATH  = THEME_PATHS[0];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, SKIP_TOKENS = new Set();
let NL = {}, ND = {}, NEUTRAL_MAPS = null, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.NEUTRAL_LIGHT)   NL              = map.NEUTRAL_LIGHT;
  if (map.NEUTRAL_DARK)    ND              = map.NEUTRAL_DARK;
  if (map.NEUTRAL_MAPS)    NEUTRAL_MAPS    = map.NEUTRAL_MAPS;   // { <snapshotKey>: {100:'#..',…}, … } for 3+ modes
  if (map.NEUTRAL_VAR_RE)  NEUTRAL_VAR_RE  = map.NEUTRAL_VAR_RE;
} catch { /* optional */ }

// ── Modes + resolver: every configured mode, not just light/dark ──────────────
// The gate compares each mode-pair whose Figma values differ; the 2-mode (light/dark)
// case is a subset, so this is byte-identical there. A DS with 3+ modes (compact,
// high-contrast, breakpoints) is now fully covered instead of silently light-vs-dark only.
const MODES = loadModes(cfg);
const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const { resolve } = buildResolver(rawCss, MODES, { NL, ND, NEUTRAL_MAPS, NEUTRAL_VAR_RE });

function tokenToVar(token) {
  if (SKIP_TOKENS.has(token)) return null;
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, token)) return EXPLICIT[token];
  return '--' + token.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const modeTokens = Object.fromEntries(MODES.map(m => [m.snapshotKey, snap.color?.[m.snapshotKey] ?? {}]));
const baseKey = MODES[0].snapshotKey;   // enumerate tokens from the first (base) mode

// ── Check ─────────────────────────────────────────────────────────────────────
// A token is STATIC (missing an override) when some pair of modes has DIFFERENT Figma
// values but the CSS resolves to the SAME hex in both — i.e. one mode never overrode it.
const MISSING = [], OK = [], SKIPPED = [];
const seen = new Set();
const figmaOf = (key, token) => modeTokens[key][token + '/color'] ?? modeTokens[key][token] ?? null;

for (const tokenKey of Object.keys(modeTokens[baseKey])) {
  const token = tokenKey.replace(/\/color$/, '');
  if (seen.has(token)) continue;
  seen.add(token);

  // Which mode-pairs differ in Figma? Only those need a CSS difference.
  const figma = Object.fromEntries(MODES.map(m => [m.snapshotKey, figmaOf(m.snapshotKey, token)]));
  const varying = MODES.some((a, i) => MODES.slice(i + 1).some((b) => {
    const fa = figma[a.snapshotKey], fb = figma[b.snapshotKey];
    return fa != null && fb != null && fa.toLowerCase() !== fb.toLowerCase();
  }));
  if (!varying) continue;

  const cssVar = tokenToVar(token);
  if (cssVar === null) { SKIPPED.push(`${token} (no CSS var — documented)`); continue; }

  const css = Object.fromEntries(MODES.map(m => [m.snapshotKey, resolve(cssVar, m.snapshotKey)]));
  // Find a mode-pair that varies in Figma yet is identical (and resolvable) in CSS.
  let staticPair = null;
  for (let i = 0; i < MODES.length && !staticPair; i++) {
    for (let j = i + 1; j < MODES.length; j++) {
      const ka = MODES[i].snapshotKey, kb = MODES[j].snapshotKey;
      const fa = figma[ka], fb = figma[kb];
      if (fa == null || fb == null || fa.toLowerCase() === fb.toLowerCase()) continue;
      if (css[ka] !== null && css[kb] !== null && css[ka] === css[kb]) { staticPair = [ka, kb]; break; }
    }
  }
  if (staticPair) {
    const [ka, kb] = staticPair;
    MISSING.push({ token, cssVar, modeA: ka, modeB: kb, figmaA: figma[ka], figmaB: figma[kb], cssResolved: css[ka] });
  } else {
    OK.push(token);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const total = OK.length + MISSING.length;
const modeLabel = MODES.map(m => m.snapshotKey).join('/');
console.log(`\n✅ ADAPTS    ${OK.length}/${total}  (CSS resolves to different hex where Figma modes differ)`);
console.log(`❌ STATIC    ${MISSING.length}/${total}  (CSS same hex across a differing mode-pair — override missing)`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}  (no CSS var, documented)   [modes: ${modeLabel}]`);

if (MISSING.length) {
  console.log('\n─── Missing mode adaptation ──────────────────────────────────────');
  for (const m of MISSING) {
    console.log(`  ❌ ${m.token} → ${m.cssVar}`);
    console.log(`       Figma: ${m.modeA}=${m.figmaA}  ${m.modeB}=${m.figmaB}`);
    console.log(`       CSS:   resolves to ${m.cssResolved} in both ${m.modeA} and ${m.modeB}`);
  }
  console.log('');
  process.exit(1);
} else {
  console.log(`\nAll mode-variant tokens adapt correctly across every configured mode (${modeLabel}). ✓\n`);
  process.exit(0);
}
