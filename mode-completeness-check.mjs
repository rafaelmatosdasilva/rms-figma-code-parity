// mode-completeness-check.mjs — Gate [5]: verify every token whose Figma value differs across
// the modes of ITS collection actually resolves to a different value in CSS for those modes.
//
// Gate [2] catches wrong values. This gate catches the structural gap: a missing per-mode
// override causes a var to silently fall through to the base value even when Figma specifies a
// different value in another mode.
//
// DS-AGNOSTIC. Two independent things vary and this gate handles both from config alone:
//   • The COLOR axis — `figma.modes` (light/dark, high-contrast, …). Compared as hex.
//   • Any OTHER typed collection declared in `figma.collections` — a sizing collection that
//     changes per breakpoint, a string collection that changes per locale — each with ITS OWN
//     modes and cssSelectors. Compared as literals (scalar '12px', string 'Inter').
// A DS that declares no extra collections runs exactly the legacy colour-only check (byte-identical).
//
// A token "adapts" when, for every mode-pair whose Figma values differ, the CSS resolves to
// different values too. It is exempt when it has no CSS var (SKIP / null EXPLICIT) or the value is
// unresolvable (e.g. rgba with no comparison).
//
// Requires at project root:
//   ds-config.json   — snapshot path, themeCSS, figma.modes, figma.collections (optional)
//   parity-map.mjs   — EXPLICIT, SKIP_TOKENS, NEUTRAL_LIGHT/DARK, NEUTRAL_VAR_RE
//   figma-vars.snapshot.json — color.<mode> maps + (optional) modeVariants.<collection> maps
//
// Exit 0 = all mode-variant tokens adapt correctly.  Exit 1 = a missing per-mode override.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadModes, loadCollections, allModes, buildResolver } from './mode-resolver.mjs';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, SKIP_TOKENS = new Set();
let NL = {}, ND = {}, NEUTRAL_MAPS = null, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.NEUTRAL_LIGHT)   NL              = map.NEUTRAL_LIGHT;
  if (map.NEUTRAL_DARK)    ND              = map.NEUTRAL_DARK;
  if (map.NEUTRAL_MAPS)    NEUTRAL_MAPS    = map.NEUTRAL_MAPS;
  if (map.NEUTRAL_VAR_RE)  NEUTRAL_VAR_RE  = map.NEUTRAL_VAR_RE;
} catch { /* optional */ }

// ── Resolver over EVERY mode across every axis/collection ──────────────────────
const COLOR_MODES  = loadModes(cfg);
const COLLECTIONS  = loadCollections(cfg);
const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const { resolve, resolveRaw } = buildResolver(rawCss, allModes(cfg), { NL, ND, NEUTRAL_MAPS, NEUTRAL_VAR_RE });

// ── token → CSS var ───────────────────────────────────────────────────────────
function colorTokenToVar(token) {
  if (SKIP_TOKENS.has(token)) return null;
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, token)) return EXPLICIT[token];
  return '--' + token.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
}
function nonColorTokenToVar(col, token) {
  if (col.skip && col.skip.includes(token)) return null;
  if (col.explicit && Object.prototype.hasOwnProperty.call(col.explicit, token)) return col.explicit[token];
  return '--' + token.replace(/\//g, '-');
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));

// ── Build the unified list of checkable collections ───────────────────────────
// Each entry is a self-describing unit: its modes, how to read a token's Figma value per mode, how
// to map a token to a CSS var, and — PER TOKEN — its kind (a single collection may mix
// color/scalar/string/boolean). Kind decides the comparison (hex vs literal) and the resolver.
const eqHex     = (a, b) => a.toLowerCase() === b.toLowerCase();
const eqLiteral = (a, b) => String(a).trim() === String(b).trim();
const eqFor       = (kind) => (kind === 'color' ? eqHex : eqLiteral);
const resolveFor  = (kind) => (kind === 'color' ? resolve : resolveRaw);

const CHECKABLE = [];

// 1) The colour axis (legacy behaviour, unchanged) — every token is kind 'color'.
{
  const modeTokens = Object.fromEntries(COLOR_MODES.map(m => [m.snapshotKey, snap.color?.[m.snapshotKey] ?? {}]));
  const baseKey = COLOR_MODES[0].snapshotKey;
  const tokens = [...new Set(Object.keys(modeTokens[baseKey]).map(k => k.replace(/\/color$/, '')))];
  CHECKABLE.push({
    label: cfg.figma?.colorCollection || 'color',
    modes: COLOR_MODES,
    tokens,
    figmaOf: (mk, token) => modeTokens[mk]?.[token + '/color'] ?? modeTokens[mk]?.[token] ?? null,
    tokenToVar: colorTokenToVar,
    kindOf: () => 'color',
    // Colour value parity per mode is owned by Gate [2]/[3]; here we only check COMPLETENESS
    // (does it adapt at all) so we don't double-report or regress the colour baseline.
    valueParity: false,
  });
}

// 2) Declared collections, from the additive `modeVariants` section — each var carries its own kind.
// These have no other per-mode value gate, so here we check VALUE parity per mode: each mode's CSS
// must equal its Figma value. That subsumes completeness (a missing override leaves the base value
// in the other mode → mismatch) AND catches wrong overrides.
for (const col of COLLECTIONS) {
  const section = snap.modeVariants?.[col.name];
  if (!section || !section.vars) continue;   // not captured yet → nothing to check for this collection
  CHECKABLE.push({
    label: col.name,
    modes: col.modes,
    tokens: Object.keys(section.vars),
    figmaOf: (mk, token) => section.vars[token]?.values?.[mk] ?? null,
    tokenToVar: (t) => nonColorTokenToVar(col, t),
    kindOf: (t) => section.vars[t]?.kind || 'scalar',
    valueParity: true,
  });
}

// ── Check every collection with the same generic logic ────────────────────────
const MISSING = [], OK = [], SKIPPED = [];

for (const c of CHECKABLE) {
  const { modes } = c;
  if (modes.length < 2) continue;   // single-mode collection can't vary
  for (const token of c.tokens) {
    const kind = c.kindOf(token);
    const eq = eqFor(kind), cssResolve = resolveFor(kind);
    const figma = Object.fromEntries(modes.map(m => [m.snapshotKey, c.figmaOf(m.snapshotKey, token)]));

    // Which mode-pairs differ in Figma? Only those require a CSS difference.
    const varying = modes.some((a, i) => modes.slice(i + 1).some((b) => {
      const fa = figma[a.snapshotKey], fb = figma[b.snapshotKey];
      return fa != null && fb != null && !eq(String(fa), String(fb));
    }));
    if (!varying) continue;

    const cssVar = c.tokenToVar(token);
    if (cssVar === null) { SKIPPED.push(`${c.label}:${token} (no CSS var — documented)`); continue; }

    const css = Object.fromEntries(modes.map(m => [m.snapshotKey, cssResolve(cssVar, m.snapshotKey)]));

    if (c.valueParity) {
      // VALUE parity: every mode whose CSS resolves must equal its Figma value.
      let bad = null;
      for (const m of modes) {
        const mk = m.snapshotKey, f = figma[mk], v = css[mk];
        if (f == null || v == null) continue;   // unresolved / not represented in CSS → not this gate's failure
        if (!eq(String(f), String(v))) { bad = { mode: mk, figmaVal: f, cssVal: v }; break; }
      }
      if (bad) MISSING.push({ type: 'mismatch', label: c.label, token, cssVar, ...bad });
      else OK.push(`${c.label}:${token}`);
    } else {
      // COMPLETENESS: a static pair differs in Figma yet is identical (and resolvable) in CSS.
      let staticPair = null;
      for (let i = 0; i < modes.length && !staticPair; i++) {
        for (let j = i + 1; j < modes.length; j++) {
          const ka = modes[i].snapshotKey, kb = modes[j].snapshotKey;
          const fa = figma[ka], fb = figma[kb];
          if (fa == null || fb == null || eq(String(fa), String(fb))) continue;
          if (css[ka] != null && css[kb] != null && eq(String(css[ka]), String(css[kb]))) { staticPair = [ka, kb]; break; }
        }
      }
      if (staticPair) {
        const [ka, kb] = staticPair;
        MISSING.push({ type: 'static', label: c.label, token, cssVar, modeA: ka, modeB: kb, figmaA: figma[ka], figmaB: figma[kb], cssResolved: css[ka] });
      } else {
        OK.push(`${c.label}:${token}`);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const total = OK.length + MISSING.length;
const axisLabel = CHECKABLE.map(c => `${c.label}[${c.modes.map(m => m.snapshotKey).join('/')}]`).join('  ');
console.log(`\n✅ OK        ${OK.length}/${total}  (adapts across modes, and matches Figma per mode where value-checked)`);
console.log(`❌ FAIL      ${MISSING.length}/${total}  (missing per-mode override, or CSS ≠ Figma in a mode)`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}  (no CSS var, documented)`);
console.log(`   collections: ${axisLabel}`);

if (MISSING.length) {
  console.log('\n─── Mode failures ────────────────────────────────────────────────');
  for (const m of MISSING) {
    console.log(`  ❌ [${m.label}] ${m.token} → ${m.cssVar}`);
    if (m.type === 'mismatch') {
      console.log(`       ${m.mode}: Figma ${m.figmaVal}, CSS ${m.cssVal}  (value mismatch)`);
    } else {
      console.log(`       Figma: ${m.modeA}=${m.figmaA}  ${m.modeB}=${m.figmaB}`);
      console.log(`       CSS:   resolves to ${m.cssResolved} in both ${m.modeA} and ${m.modeB}  (override missing)`);
    }
  }
  console.log('');
  process.exit(1);
} else {
  console.log(`\nAll mode-variant tokens adapt correctly across every configured mode. ✓\n`);
  process.exit(0);
}
