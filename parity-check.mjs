// parity-check.mjs - Run from project root: node scripts/parity-check.mjs [--fix]
//
// --fix: auto-apply sizing/typography value fixes directly to theme.css.
//        Color divergences are printed as actionable fix hints only -
//        alias chains require manual review to avoid breaking other tokens.
//
// Resolves every CSS var chain for all configured modes and diffs against
// the Figma snapshot across three dimensions:
//   1. Color      - every component color token, all configured modes
//   2. Sizing     - gap / padding / radii / thickness / min-height
//   3. Typography - type scale (size, weight, line-height)
//
// Requires at project root:
//   ds-config.json   - themeCSS + snapshotVars paths + figma.modes config
//   parity-map.mjs   - EXPLICIT, SKIP_TOKENS, NULL_TOKENS, KNOWN_NULL,
//                       EXPLICIT_SIZING, SIZING_SKIP, TYPO,
//                       NEUTRAL_LIGHT, NEUTRAL_DARK, NEUTRAL_VAR_RE,
//                       NEUTRAL_MAPS (for 3+ modes - { modeName: {...} } or array)
//
// Exit 0 = full parity. Exit 1 = at least one FAIL or NEW SKIP.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { loadTokensDict, tokenSource } from './fix-hint.mjs';
import { loadCssSources, rootTokens, blankComments, neverAppliedRootSelectors } from './css-source.mjs';
import { readFreshSnapshot } from './code-capture.mjs';
import { colorHex, sameColor, sameValue } from './css-values.mjs';   // #fff = #ffffff, rgb()/hsl()/oklch() = hex, 0.5rem = 8px   // the cascade-aware theme reader (shared with the code capture)
import { resolveNamingSpec, tokenToVar as toVar } from './naming-convention.mjs';   // shared Figma↔code naming convention

const ROOT     = process.cwd();
import { pathToFileURL } from 'url';
const FIX_MODE  = process.argv.includes('--fix');
const JSON_MODE = process.argv.includes('--json');

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

// Emitted DTCG dictionary (feature #1): lets a divergence cite the token's verified value and the
// file that declares it. Absent when contracts have not been generated yet - citations degrade.
const CONTRACTS_REL  = cfg.contracts?.out ?? 'contracts';
const TOKENS_DICT    = loadTokensDict(ROOT, join(ROOT, CONTRACTS_REL));

const THEME_PATHS   = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const THEME_PATH    = THEME_PATHS[0]; // primary - used in fix hints
const THEME_LABEL   = THEME_PATHS.length === 1 ? THEME_PATHS[0] : `[${THEME_PATHS.map(p=>p.split('/').pop()).join(', ')}]`;
const SNAPSHOT_PATH = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';

// ── Mode configuration ────────────────────────────────────────────────────────
// New: cfg.figma.modes = [{ name, snapshotKey?, cssSelector }]
//   cssSelector values:
//     "root"                - :root { }
//     "dark-media"          - @media (prefers-color-scheme: dark) { :root { } }
//     "high-contrast-media" - @media (prefers-contrast: more) { :root { } }
//     "class:<name>"        - :root.<name> { }   (the older ".<name> :root { }" is still read, and flagged)
//     "data:<attr>=<val>"   - :root[data-theme="dark"] { }   (the older "[data-theme=…] :root" likewise)
//
// Legacy: cfg.figma.lightMode / cfg.figma.darkMode → synthesized to two-mode array
const figmaCfg = cfg.figma ?? {};
let MODES;
if (figmaCfg.modes && Array.isArray(figmaCfg.modes) && figmaCfg.modes.length) {
  MODES = figmaCfg.modes.map(m => ({
    name:        m.name,
    snapshotKey: (m.snapshotKey ?? m.name).toLowerCase().replace(/\s+/g, '-'),
    cssSelector: m.cssSelector ?? 'root',
  }));
} else {
  MODES = [
    { name: figmaCfg.lightMode ?? 'Light', snapshotKey: 'light', cssSelector: 'root' },
    { name: figmaCfg.darkMode  ?? 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
  ];
}

// ── Load parity-map.mjs (project-specific token mappings) ────────────────────
const PRIMITIVE_PREFIX = cfg.figma?.primitivePrefix ?? 'primitives/';
// Segments to strip from token paths when deriving CSS var names.
// Default: drop trailing /color and /default (common DS conventions).
// Set to [] in ds-config.json → figma.namingConvention.dropSegments to keep all segments.
const DROP_SEGMENTS   = cfg.figma?.namingConvention?.dropSegments   ?? ['color', 'default'];
// When true (default), /iconText/ in token path is normalized to /text/ for CSS var derivation.
// Set to false in ds-config.json → figma.namingConvention.iconTextAlias when CSS keeps "iconText".
const ICON_TEXT_ALIAS = cfg.figma?.namingConvention?.iconTextAlias  ?? true;
// The shared convention (naming-convention.mjs) reads these SAME ds-config keys. DROP_SEGMENTS /
// ICON_TEXT_ALIAS above stay for the alias-chain + primitive specifics below that need the
// intermediate (pre-hyphen) form; the plain token→var derivations route through NAMING.
const NAMING = resolveNamingSpec(cfg);

let EXPLICIT = {}, NULL_TOKENS = new Set(), SKIP_TOKENS = new Set(),
    KNOWN_NULL = new Set(), EXPLICIT_SIZING = {}, SIZING_SKIP = new Map(), TYPO = {},
    BOOLEAN_SKIP = new Set(),
    EFFECTS = [], SCOPE_RULES = [], FOCUS_CONTRACT = [];
let NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;
// neutralMaps[i] = { key: '#hex' } for mode i - keys match NEUTRAL_VAR_RE capture group
let neutralMaps = MODES.map(() => ({}));

try {
  const map = await import(pathToFileURL(join(ROOT, 'parity-map.mjs')).href);
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.NULL_TOKENS)     NULL_TOKENS     = map.NULL_TOKENS;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.KNOWN_NULL)      KNOWN_NULL      = map.KNOWN_NULL;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
  if (map.SIZING_SKIP)     SIZING_SKIP     = map.SIZING_SKIP;
  if (map.TYPO)            TYPO            = map.TYPO;
  if (map.NEUTRAL_VAR_RE)  NEUTRAL_VAR_RE  = map.NEUTRAL_VAR_RE;
  if (map.BOOLEAN_SKIP)    BOOLEAN_SKIP   = map.BOOLEAN_SKIP instanceof Set ? map.BOOLEAN_SKIP : new Set(map.BOOLEAN_SKIP);
  if (map.EFFECTS)         EFFECTS        = Array.isArray(map.EFFECTS) ? map.EFFECTS : [];
  if (map.SCOPE_RULES)     SCOPE_RULES    = Array.isArray(map.SCOPE_RULES) ? map.SCOPE_RULES : [];
  if (map.FOCUS_CONTRACT)  FOCUS_CONTRACT = Array.isArray(map.FOCUS_CONTRACT) ? map.FOCUS_CONTRACT : [];
  // Multi-mode: NEUTRAL_MAPS overrides NEUTRAL_LIGHT / NEUTRAL_DARK
  if (map.NEUTRAL_MAPS) {
    if (Array.isArray(map.NEUTRAL_MAPS)) {
      map.NEUTRAL_MAPS.forEach((nm, i) => { if (nm && i < neutralMaps.length) neutralMaps[i] = nm; });
    } else {
      MODES.forEach((m, i) => { if (map.NEUTRAL_MAPS[m.name]) neutralMaps[i] = map.NEUTRAL_MAPS[m.name]; });
    }
  } else {
    // Legacy two-mode fallback
    if (map.NEUTRAL_LIGHT) neutralMaps[0] = map.NEUTRAL_LIGHT;
    if (map.NEUTRAL_DARK && neutralMaps.length > 1) neutralMaps[1] = map.NEUTRAL_DARK;
  }
} catch {
  console.warn('⚠️  parity-map.mjs not found - running with empty token maps.');
  console.warn('   All non-standard token names will appear as FAIL or NEW SKIP.');
  console.warn('   Copy parity-map.example.mjs → parity-map.mjs to configure.\n');
}

// ── Parse token CSS (all configured files merged) ─────────────────────────────
const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

// ── Token values per mode ─────────────────────────────────────────────────────
// css-source.mjs reads the theme the way the browser applies it: every :root block (not only the
// first), @import, and each mode resolved by the real cascade (importance, specificity, source
// order). It is the same reading the code capture uses, so this gate and code.snapshot.json agree.
// modeVars[i] = the declared value of every token in mode i (a mode's value falls back to the base
// where the mode does not override it, exactly as the browser does).
const TOKEN_SOURCES = loadCssSources(ROOT, THEME_PATHS).files;
const declaredByMode = MODES.map(m => rootTokens(TOKEN_SOURCES, m));
const modeVars = declaredByMode.map(d => Object.fromEntries([...d].map(([k, v]) => [k, v.value])));

// ── Where each token is declared (for fix hints) ──────────────────────────────
// The winning declaration's file and line, base mode first, then any mode that declares it.
const varLineMap = {}, varFileMap = {};
for (const d of declaredByMode) for (const [k, v] of d) if (!(k in varLineMap)) { varLineMap[k] = v.line; varFileMap[k] = v.file; }

// ── Declared-var index: locate a token's CSS var even under a different case or
// scope, WITHOUT weakening detection. A token's kebab var may be declared with a
// different case (Figma "Advanced/Toast/…" → --Advanced-…, the code writes
// --advanced-…) or inside a component rule rather than :root. locateVar finds the
// var that is ACTUALLY declared so a var that genuinely EXISTS is never reported
// "not declared"; a var that is truly absent everywhere still returns null (and
// still fails). A :root match (exact or case-insensitive) is value-checked exactly
// as before - a wrong value still FAILS. A var found only outside :root is reported
// as an accurate, non-failing status (this gate only ever verified :root tokens).
// Per-mode case-insensitive index: modeByLower[0] = base :root, modeByLower[i>0] =
// mode i's override block. A colour var may live in the base OR a mode override, so
// locateVar takes the mode index; sizing/typography/strings call it with the default 0.
const modeByLower = modeVars.map(mv => new Map(Object.keys(mv).map(n => [n.toLowerCase(), n])));
const allDeclaredLower = new Set();
for (const src of [css, ...TOKEN_SOURCES.map(f => blankComments(f.text))]) for (const mm of src.matchAll(/(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) allDeclaredLower.add(mm[1].toLowerCase());
function locateVar(expected, modeIdx = 0) {
  if (modeVars[0][expected]) return { name: expected, root: true };                            // exact base
  if (modeIdx > 0 && modeVars[modeIdx]?.[expected]) return { name: expected, root: true };     // exact override
  const ciBase = modeByLower[0].get(expected.toLowerCase());
  if (ciBase) return { name: ciBase, root: true };                                             // base, other case
  if (modeIdx > 0) { const ciOv = modeByLower[modeIdx]?.get(expected.toLowerCase()); if (ciOv) return { name: ciOv, root: true }; } // override, other case
  if (allDeclaredLower.has(expected.toLowerCase())) return { name: expected, root: false };    // declared, not :root
  return null;                                                                                 // truly absent
}

// Vars REFERENCED in the DS's own component code (var(--x) under componentSrcDirs).
// A runtime-token DS injects its token CSS from a backend at run time (e.g. an
// index.html <link id="dynamic-stylesheet"> with no static href), so no static
// value exists for these and the gate cannot compare them - but a var that is USED
// in the code is plainly not "missing" or "invented". This set lets the sizing
// dimension separate a runtime-injected token (accurate skip) from a genuinely
// absent one (still a fail). No componentSrcDirs -> empty set -> behaviour unchanged.
const usedVarsLower = new Set();
(function scanUsedVars() {
  const dirs = [cfg.componentSrcDirs].flat().filter(Boolean);
  if (!dirs.length) return;
  const EXT = /\.(vue|css|scss|sass|less|html|ts|tsx|js|jsx)$/i;
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries; try { entries = readdirSync(join(ROOT, dir)); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
      const rel = join(dir, e); let st; try { st = statSync(join(ROOT, rel)); } catch { continue; }
      if (st.isDirectory()) walk(rel, depth + 1);
      else if (EXT.test(e) && st.size < 2_000_000) {
        try { for (const mm of readFileSync(join(ROOT, rel), 'utf8').matchAll(/var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)/g)) usedVarsLower.add(mm[1].toLowerCase()); } catch {}
      }
    }
  };
  for (const d of dirs) walk(d);
})();

// ── Resolver caches - one Map per mode for color, one for scalar ─────────────
// Keyed by var name; populated on first resolve, returned instantly on repeat.
// Cuts redundant chain-walks when many tokens alias through the same primitives.
const resolveCache  = MODES.map(() => new Map());
const scalarCache   = new Map();

// ── Color resolver (multi-mode, index-based) ──────────────────────────────────
// Mode 0 = base vars. Mode i > 0 = override vars + fallback to base.
function resolve(varName, modeIdx, depth = 0) {
  if (depth > 8) return null;
  const cache = resolveCache[modeIdx];
  if (cache.has(varName)) return cache.get(varName);

  const nm = varName.match(NEUTRAL_VAR_RE);
  if (nm) {
    const nmap   = neutralMaps[modeIdx] ?? {};
    const result = nmap[nm[1]] ?? nmap[+nm[1]] ?? null;
    cache.set(varName, result);
    return result;
  }
  const override = modeIdx > 0 ? modeVars[modeIdx]?.[varName] : undefined;
  const raw = override ?? modeVars[0][varName];
  if (!raw) { cache.set(varName, null); return null; }
  const t = raw.trim();
  const vMatch  = t.match(/^var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*\)$/);
  if (vMatch)  { const r = resolve(vMatch[1],  modeIdx, depth + 1); cache.set(varName, r); return r; }
  const vfMatch = t.match(/^var\((--.+?),/);
  if (vfMatch) { const r = resolve(vfMatch[1], modeIdx, depth + 1); cache.set(varName, r); return r; }
  // Any colour the browser understands (short hex, rgb(), hsl(), oklch(), color(srgb …)) is read
  // as canonical hex, so a spelling difference is never reported as a design difference.
  const hex = colorHex(t);
  if (hex) {
    cache.set(varName, hex);
    return hex;
  }
  cache.set(varName, null);
  return null;
}

// ── Scalar resolver (single-mode: sizing + typography) ───────────────────────
function resolveScalar(varName, depth = 0) {
  if (depth > 8) return null;
  if (depth === 0 && scalarCache.has(varName)) return scalarCache.get(varName);
  const raw = modeVars[0][varName]; if (!raw) return null;
  const t = raw.trim();
  const v  = t.match(/^var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*\)$/);   if (v)  { const r = resolveScalar(v[1],  depth + 1); if (depth === 0) scalarCache.set(varName, r); return r; }
  const vf = t.match(/^var\((--.+?),/);      if (vf) { const r = resolveScalar(vf[1], depth + 1); if (depth === 0) scalarCache.set(varName, r); return r; }
  if (depth === 0) scalarCache.set(varName, t);
  return t;
}

// ── Alias chain helpers ────────────────────────────────────────────────────────
// Returns the immediate var() target (one hop), or null if the value is a literal.
function resolveCSSAlias(varName, modeIdx) {
  const raw = (modeIdx > 0 ? modeVars[modeIdx]?.[varName] : undefined) ?? modeVars[0][varName];
  if (!raw) return null;
  const vm = raw.trim().match(/^var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*(?:,[^)]*)?\)$/);   // accept a fallback: var(--x, …)
  return vm ? vm[1] : null;
}

// Converts a Figma alias hop name to CSS var, applying the project's naming conventions:
// preserves case for semantic tokens and drops DROP_SEGMENTS suffixes. Used for full
// intermediate chain comparisons.
function aliasHopToVar(hop) {
  if (hop.startsWith(PRIMITIVE_PREFIX)) {
    const bare = hop.slice(PRIMITIVE_PREFIX.length);
    return '--' + bare.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
  }
  let v = ICON_TEXT_ALIAS ? hop.replace(/\/iconText\//g, '/text/') : hop;
  if (DROP_SEGMENTS.includes('color'))   v = v.replace(/\/color$/, '');
  if (DROP_SEGMENTS.includes('default')) v = v.replace(/\/default$/, '');
  // An intermediate hop is a token in its own right, so it obeys the same EXPLICIT
  // name overrides as a top-level one. Deriving it by convention alone makes every
  // token that chains through a renamed semantic var report ALIAS FAIL - the CSS is
  // correct, the expectation is not. Check both the dropped-suffix form and the raw
  // hop, since EXPLICIT keys may be written either way.
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, v))   return EXPLICIT[v];
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, hop)) return EXPLICIT[hop];
  return toVar(hop, NAMING);   // final derivation via the shared convention (honours separator/case)
}

// ── Fix hint helpers ──────────────────────────────────────────────────────────
// Reverse-lookup: given a target hex, find the matching neutral var name for a mode
function hexToNeutralVar(hex, modeIdx) {
  const nmap = neutralMaps[modeIdx] ?? {};
  for (const [key, h] of Object.entries(nmap)) {
    if (h && h.toLowerCase() === hex.toLowerCase()) return `var(--neutral-${key})`;
  }
  return null;
}

function colorFixHint(cssVar, figmaHex, modeIdx) {
  const line    = varLineMap[cssVar];
  const suggest = hexToNeutralVar(figmaHex, modeIdx);
  const current = (modeIdx > 0 ? modeVars[modeIdx]?.[cssVar] : undefined) ?? modeVars[0][cssVar];
  const loc     = line ? `${varFileMap[cssVar] ?? THEME_PATH}:${line}` : THEME_PATH;
  if (suggest)
    return `${loc} - ${cssVar}: ${current ?? '?'} should resolve to ${suggest} (${figmaHex})`;
  return `${loc} - chain should resolve to ${figmaHex} (no matching neutral found)`;
}

function sizingFixHint(cssVar, figmaVal) {
  const line    = varLineMap[cssVar];
  const current = modeVars[0][cssVar];
  if (!line) return `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}`;
  return `${varFileMap[cssVar] ?? THEME_PATH}:${line} - change ${cssVar}: ${current ?? '?'} → ${figmaVal}`;
}

// ── Token → CSS var (convention) ─────────────────────────────────────────────
function tokenToVar(token) {
  if (SKIP_TOKENS.has(token) || NULL_TOKENS.has(token)) return null;
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, token)) return EXPLICIT[token];
  return toVar(token, NAMING);
}

function sizingTokenToVar(token) {
  if (SIZING_SKIP.has(token)) return null;
  if (EXPLICIT_SIZING[token]) return EXPLICIT_SIZING[token];
  return toVar(token, NAMING, { raw: true });
}

// ── Breakpoint media-query parser ─────────────────────────────────────────────
// Returns { root: {'--var': 'val'}, '768': {...}, ... } keyed by min-width string.
// The 'root' key holds all vars declared in :root without a media query wrapper.
function parseMediaQueries(cssText) {
  const result = { root: {} };
  const rootBlock = cssText.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  for (const m of rootBlock.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;]+);/g))
    result.root[`--${m[1]}`] = m[2].trim();
  const mediaRe = /@media[^{]*\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\)[^{]*\{([\s\S]*?)\}\s*\}/g;
  for (const m of cssText.matchAll(mediaRe)) {
    result[m[1]] = {};
    for (const vm of m[2].matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;]+);/g))
      result[m[1]][`--${vm[1]}`] = vm[2].trim();
  }
  return result;
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8'));

// ── Primitive ramp: derived from the snapshot, not restated in parity-map ────
// The ramp used to be hand-maintained in parity-map.mjs (NEUTRAL_LIGHT / NEUTRAL_DARK)
// while the same numbers also lived in the token CSS and in Figma - three copies that
// drift independently. When a DS primitive moves, updating the CSS alone leaves the
// resolver comparing against the old hex and every token aliasing that primitive fails,
// pointing at the tokens rather than at the stale map.
//
// When Phase 1 captures a `primitives` section, it wins: the snapshot is the closest
// thing to Figma we have. parity-map stays as the fallback for projects that have not
// refreshed yet, so this is backwards-compatible.
//
// Keys are the trailing number of the primitive's name ("primitives/Neutral 800" → 800)
// to match NEUTRAL_VAR_RE's capture group. Override the extraction with
// `figma.primitiveKeyRe` in ds-config.json if a DS names its ramp differently.
if (snap.primitives && typeof snap.primitives === 'object') {
  const keyRe = cfg.figma?.primitiveKeyRe ? new RegExp(cfg.figma.primitiveKeyRe) : /(\d+)\s*$/;
  MODES.forEach((m, i) => {
    const src = snap.primitives[m.snapshotKey] ?? snap.primitives[m.name];
    if (!src || typeof src !== 'object') return;
    const derived = {};
    for (const [name, hex] of Object.entries(src)) {
      const k = String(name).match(keyRe)?.[1];
      if (k && hex) derived[k] = hex;
    }
    // Merge over the parity-map values rather than replacing wholesale, so a primitive
    // the capture missed still resolves from the map instead of silently vanishing.
    if (Object.keys(derived).length) neutralMaps[i] = { ...neutralMaps[i], ...derived };
  });
}

// Source snapshot (DS library file) - populated by Phase 1 when figmaSourceKey is set.
// When present, value mismatches are cross-checked: if source matches CSS, the consumer
// file just has a pending library update → PENDING_FIGMA_SYNC (not a gate failure).
const sourceSnap = snap.source ?? null;

// ── Accumulators ──────────────────────────────────────────────────────────────
const FAIL = [], PASS = [], SKIP = [], NEW_SKIP = [], ALIAS_FAIL = [], PENDING_FIGMA_SYNC = [], BOOL_INFO = [], TYPO_INFO = [], EFFECTS_FAIL = [], SCOPE_FAIL = [], FOCUS_INFO = [];
const autoFixes = []; // { cssVar, newVal, line } - applied when --fix

// ── 1. COLOR ──────────────────────────────────────────────────────────────────
const seen = new Set();
for (let modeIdx = 0; modeIdx < MODES.length; modeIdx++) {
  const modeMeta = MODES[modeIdx];
  for (const [tokenKey, figmaHex] of Object.entries(snap.color?.[modeMeta.snapshotKey] ?? {})) {
    const token     = DROP_SEGMENTS.includes('color') ? tokenKey.replace(/\/color$/, '') : tokenKey;
    const dedupeKey = `${token}:${modeMeta.snapshotKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const cssVar = tokenToVar(token);
    if (cssVar === null) {
      SKIP.push({ dimension: 'color', token, mode: modeMeta.name, reason: 'no dedicated CSS var (known skip / shared primitive / rgba)' });
      continue;
    }
    if (figmaHex === null) {
      if (KNOWN_NULL.has(token))
        SKIP.push({ dimension: 'color', token, mode: modeMeta.name, reason: 'Figma value null (known)' });
      else
        NEW_SKIP.push({ dimension: 'color', token, mode: modeMeta.name, reason: 'Figma value is NEW null - add to KNOWN_NULL in parity-map.mjs' });
      continue;
    }
    const loc = locateVar(cssVar, modeIdx);
    if (!loc) {
      // Absent from the static token CSS (base and mode override). Used in the
      // component code -> runtime-injected (backend stylesheet), not missing.
      if (usedVarsLower.has(cssVar.toLowerCase())) {
        SKIP.push({ dimension: 'color', token, cssVar, mode: modeMeta.name, reason: 'runtime-injected - used in code, not in static token CSS (backend stylesheet)' });
      } else {
        FAIL.push({ dimension: 'color', token, cssVar, mode: modeMeta.name, issue: `CSS var not declared in token CSS`, fixHint: `Add ${cssVar} to ${THEME_LABEL}` });
      }
      continue;
    }
    if (!loc.root) {
      SKIP.push({ dimension: 'color', token, cssVar: loc.name, mode: modeMeta.name, reason: 'declared outside :root (component-scoped) - not compared by this gate' });
      continue;
    }
    const actualVar = loc.name;   // real declared name (handles a differing case)
    const cssHex = resolve(actualVar, modeIdx);
    if (cssHex === null) {
      NEW_SKIP.push({ dimension: 'color', token, cssVar: actualVar, mode: modeMeta.name, reason: 'CSS value is not a colour this gate can read (a gradient, a display-p3 colour, a keyword) - add to SKIP_TOKENS in parity-map.mjs if intentional' });
      continue;
    }
    const sameHex = sameColor(figmaHex, cssHex) ?? (figmaHex.toLowerCase() === cssHex.toLowerCase());
    if (!sameHex) {
      // Cross-check against DS source: if source matches CSS, consumer just has a pending
      // library update - this is not a code bug. Route to PENDING_FIGMA_SYNC instead of FAIL.
      const sourceHex = sourceSnap?.[modeMeta.snapshotKey]?.[tokenKey]
                     ?? sourceSnap?.[modeMeta.snapshotKey]?.[token] ?? null;
      if (sourceHex && (sameColor(sourceHex, cssHex) ?? sourceHex.toLowerCase() === cssHex.toLowerCase())) {
        PENDING_FIGMA_SYNC.push({ token, cssVar: actualVar, mode: modeMeta.name, consumerFigma: figmaHex, css: cssHex });
      } else {
        FAIL.push({
          dimension: 'color', token, cssVar: actualVar, mode: modeMeta.name,
          figma: figmaHex, css: cssHex,
          hint:    `CSS resolves ${actualVar} → ${cssHex} but Figma says ${figmaHex}`,
          fixHint: colorFixHint(actualVar, figmaHex, modeIdx),
        });
      }
    } else {
      PASS.push(`color ${token}:${modeMeta.snapshotKey}`);

      // Alias chain check - CSS var() chain must route through same primitive as Figma.
      // Same hex can pass value check while chain goes through a different primitive - still wrong.
      const figmaRaw = snap.aliases?.[modeMeta.snapshotKey]?.[tokenKey]
                    ?? snap.aliases?.[modeMeta.snapshotKey]?.[token] ?? null;
      if (figmaRaw) {
        const rawHops = Array.isArray(figmaRaw) ? figmaRaw : [figmaRaw];
        const figmaChain = rawHops.map(hop => aliasHopToVar(hop));
        const lastFigmaHop = figmaChain[figmaChain.length - 1];

        // Only check when Figma chain ends in a known primitive
        if (rawHops[rawHops.length - 1].startsWith(PRIMITIVE_PREFIX)) {
          const cssChain = [];
          let cur = actualVar;
          for (let i = 0; i < 10; i++) {
            const next = resolveCSSAlias(cur, modeIdx);
            if (!next) break;
            cssChain.push(next);
            cur = next;
          }

          const lastCSSHop = cssChain[cssChain.length - 1] ?? null;

          // Final primitive must match
          if (lastCSSHop !== lastFigmaHop) {
            ALIAS_FAIL.push({ token, cssVar: actualVar, mode: modeMeta.name, figmaChain, cssChain,
              mismatchAt: cssChain.length - 1,
              expected: lastFigmaHop, actual: lastCSSHop ?? '(no alias chain - hardcoded hex)' });
          } else {
            // Check intermediate hops where both chains have a value.
            // If CSS arrives at the final primitive directly (skipping semantic intermediates),
            // that's allowed - break early. Only flag if CSS routes through a different semantic var.
            for (let i = 0; i < figmaChain.length - 1; i++) {
              const csshop = cssChain[i];
              if (csshop === undefined) break; // CSS chain is shorter - skip remaining
              if (csshop === lastFigmaHop) break; // CSS arrived at primitive directly - OK
              if (csshop !== figmaChain[i]) {
                ALIAS_FAIL.push({ token, cssVar: actualVar, mode: modeMeta.name, figmaChain, cssChain,
                  mismatchAt: i,
                  expected: figmaChain[i], actual: csshop });
                break;
              }
            }
          }
        }
      }
    }
  }
}

// ── 2. SIZING ─────────────────────────────────────────────────────────────────
for (const [token, figmaVal] of Object.entries(snap.sizing ?? {})) {
  const cssVar = sizingTokenToVar(token);
  if (cssVar === null) {
    SKIP.push({ dimension: 'sizing', token, mode: '-', reason: SIZING_SKIP.get(token) ?? 'no CSS var' });
    continue;
  }
  const loc = locateVar(cssVar);
  if (!loc) {
    // Absent from the static token CSS. If the DS's own component code USES the
    // var, it is runtime-injected (a backend-loaded stylesheet) - not verifiable
    // here, but not missing or invented either. Otherwise it is genuinely absent.
    if (usedVarsLower.has(cssVar.toLowerCase())) {
      SKIP.push({ dimension: 'sizing', token, cssVar, mode: '-', reason: 'runtime-injected - used in code, not in static token CSS (backend stylesheet)' });
    } else {
      FAIL.push({ dimension: 'sizing', token, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}` });
    }
    continue;
  }
  if (!loc.root) {
    // Declared, but outside :root (component-scoped). This gate compares :root
    // tokens; report accurately instead of the false "not declared".
    SKIP.push({ dimension: 'sizing', token, cssVar: loc.name, mode: '-', reason: 'declared outside :root (component-scoped) - not compared by this gate' });
    continue;
  }
  const actualVar = loc.name;   // real declared name (handles a differing case)
  const cssVal = resolveScalar(actualVar);
  if (cssVal === null) {
    NEW_SKIP.push({ dimension: 'sizing', token, cssVar: actualVar, mode: '-', reason: 'CSS var did not resolve to a literal' });
    continue;
  }
  if (!(sameValue(figmaVal, cssVal, 'length') ?? String(figmaVal).trim() === cssVal.trim())) {
    const fixHint = sizingFixHint(actualVar, figmaVal);
    FAIL.push({ dimension: 'sizing', token, cssVar: actualVar, mode: '-', figma: figmaVal, css: cssVal, hint: `CSS resolves ${actualVar} → ${cssVal} but Figma says ${figmaVal}`, fixHint });
    if (FIX_MODE) {
      const line = varLineMap[actualVar];
      if (line && varFileMap[actualVar] === THEME_PATH) autoFixes.push({ cssVar: actualVar, newVal: String(figmaVal).trim(), line });
    }
  } else {
    PASS.push(`sizing ${token}`);
  }
}

// ── 3. TYPOGRAPHY ─────────────────────────────────────────────────────────────
if (snap.typography && Object.keys(TYPO).length) {
  for (const [cssVar, [scale, prop]] of Object.entries(TYPO)) {
    const figmaVal = snap.typography[scale]?.[prop];
    if (figmaVal === undefined || figmaVal === null) {
      SKIP.push({ dimension: 'typography', token: `${scale}/${prop}`, mode: '-', reason: 'no Figma value in snapshot' });
      continue;
    }
    const loc = locateVar(cssVar);
    if (!loc) {
      if (usedVarsLower.has(cssVar.toLowerCase())) {
        SKIP.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar, mode: '-', reason: 'runtime-injected - used in code, not in static token CSS (backend stylesheet)' });
      } else {
        FAIL.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}` });
      }
      continue;
    }
    if (!loc.root) {
      SKIP.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar: loc.name, mode: '-', reason: 'declared outside :root (component-scoped) - not compared by this gate' });
      continue;
    }
    const actualVar = loc.name;
    const cssVal = resolveScalar(actualVar);
    if (cssVal === null) {
      NEW_SKIP.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar: actualVar, mode: '-', reason: 'CSS var did not resolve' });
      continue;
    }
    if (!(sameValue(figmaVal, cssVal, 'any') ?? String(figmaVal).trim() === cssVal.trim())) {
      const fixHint = sizingFixHint(actualVar, figmaVal);
      FAIL.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar: actualVar, mode: '-', figma: figmaVal, css: cssVal, hint: `CSS resolves ${actualVar} → ${cssVal} but Figma says ${figmaVal}`, fixHint });
      if (FIX_MODE) {
        const line = varLineMap[actualVar];
        if (line && varFileMap[actualVar] === THEME_PATH) autoFixes.push({ cssVar: actualVar, newVal: String(figmaVal).trim(), line });
      }
    } else {
      PASS.push(`typography ${scale}/${prop}`);
    }
  }
} else if (!snap.typography) {
  SKIP.push({ dimension: 'typography', token: 'ALL', mode: '-', reason: 'snapshot has no typography section - run /rms-parity Phase 1' });
} else if (!Object.keys(TYPO).length) {
  SKIP.push({ dimension: 'typography', token: 'ALL', mode: '-', reason: 'TYPO map empty in parity-map.mjs - add your type scale vars' });
}
// Advisory: snapshot has ls/textTransform fields not yet covered by a TYPO map entry.
// Phase 1 captures these when letterSpacing / textCase are present in the Figma text style.
// To gate-check them: add entries to parity-map.mjs TYPO, e.g.:
//   '--m-ls': ['m', 'ls'], '--m-text-transform': ['m', 'textTransform'],
if (snap.typography) {
  for (const [scale, entry] of Object.entries(snap.typography)) {
    for (const field of ['ls', 'textTransform']) {
      if (entry[field] === undefined) continue;
      const alreadyCovered = Object.entries(TYPO).some(([, [s, p]]) => s === scale && p === field);
      if (!alreadyCovered) {
        const cssSuffix = field === 'ls' ? 'ls' : 'text-transform';
        TYPO_INFO.push({
          cssVar: `--${scale}-${cssSuffix} (inferred)`,
          note: `snapshot has ${scale}.${field}="${entry[field]}" - add '--${scale}-${cssSuffix}': ['${scale}', '${field}'] to TYPO in parity-map.mjs to gate-check it`,
        });
      }
    }
  }
}

// Advisory: TYPO vars declared in :root but never used in any component-level CSS rule
if (Object.keys(TYPO).length) {
  const rulesOnlyCSS = rawCss.replace(/:root\s*\{[\s\S]*?\}/g, '');
  for (const cssVar of Object.keys(TYPO)) {
    const re = new RegExp(`var\\(${cssVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,)]`);
    if (!re.test(rulesOnlyCSS)) {
      TYPO_INFO.push({ cssVar, note: 'declared in :root but not applied in any component rule' });
    }
  }
}

// ── 4. STRINGS ────────────────────────────────────────────────────────────────
// STRING-typed Figma variables (font-family, font-weight, etc.) stored in snapshot.strings.
// Each maps to a CSS custom property with a bare string value (no px suffix).
const strSnap = snap.strings ?? {};
for (const [tokenName, expected] of Object.entries(strSnap)) {
  const cssVar = sizingTokenToVar(tokenName);
  if (cssVar === null) {
    SKIP.push({ dimension: 'strings', token: tokenName, mode: '-', reason: 'excluded in SIZING_SKIP' });
    continue;
  }
  const loc = locateVar(cssVar);
  if (!loc) {
    if (usedVarsLower.has(cssVar.toLowerCase())) {
      SKIP.push({ dimension: 'strings', token: tokenName, cssVar, mode: '-', reason: 'runtime-injected - used in code, not in static token CSS (backend stylesheet)' });
    } else {
      FAIL.push({ dimension: 'strings', token: tokenName, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${expected} to ${THEME_PATH}` });
    }
    continue;
  }
  if (!loc.root) {
    SKIP.push({ dimension: 'strings', token: tokenName, cssVar: loc.name, mode: '-', reason: 'declared outside :root (component-scoped) - not compared by this gate' });
    continue;
  }
  const actualVar = loc.name;
  const raw = modeVars[0][actualVar];
  const norm = s => String(s).replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (norm(raw) !== norm(expected)) {
    FAIL.push({ dimension: 'strings', token: tokenName, cssVar: actualVar, mode: '-', figma: expected, css: raw, hint: `CSS has ${actualVar}: ${raw} but Figma says "${expected}"`, fixHint: `${THEME_PATH} - change ${actualVar}: ${raw} → ${expected}` });
  } else {
    PASS.push(`strings ${tokenName}`);
  }
}

// ── 5. BREAKPOINTS ────────────────────────────────────────────────────────────
// Multi-mode FLOAT collection (e.g. Phone / Tablet / Laptop / Desktop).
// Each mode's 'viewport/min-width' value tells us the CSS @media min-width for that mode.
// The smallest-width mode is the base (:root); larger modes map to @media blocks.
const bpSnap = snap.breakpoints ?? {};
const bpModeNames = Object.keys(bpSnap);
if (bpModeNames.length > 0) {
  const cssBlocks = parseMediaQueries(rawCss.replace(/\/\*[\s\S]*?\*\//g, ''));
  const modeWidths = {};
  for (const [modeName, tokens] of Object.entries(bpSnap)) {
    const raw = tokens['viewport/min-width'];
    modeWidths[modeName] = raw ? parseFloat(raw) : 0;
  }
  const sortedModes = bpModeNames.slice().sort((a, b) => modeWidths[a] - modeWidths[b]);

  for (const [modeIdx, modeName] of sortedModes.entries()) {
    const width = modeWidths[modeName];
    const cssBlock = modeIdx === 0
      ? cssBlocks.root
      : (cssBlocks[String(width)] ?? cssBlocks[String(Math.round(width))] ?? null);
    const tokens = bpSnap[modeName];

    for (const [tokenName, expected] of Object.entries(tokens)) {
      if (tokenName.startsWith('viewport/')) continue; // viewport vars define breakpoints, not CSS props
      if (expected === 'true' || expected === 'false') {
        if (!BOOLEAN_SKIP.has(tokenName)) {
          const cssVar = sizingTokenToVar(tokenName) ?? toVar(tokenName, NAMING, { raw: true });
          BOOL_INFO.push({ token: tokenName, cssVar, breakpoint: modeName });
        }
        continue;
      }
      const cssVar = sizingTokenToVar(tokenName);
      if (cssVar === null) {
        SKIP.push({ dimension: 'breakpoints', token: tokenName, mode: modeName, reason: 'excluded in SIZING_SKIP' });
        continue;
      }
      const actual = cssBlock?.[cssVar];
      if (!actual) {
        const rootVal = cssBlocks.root[cssVar];
        if (rootVal === expected) { PASS.push(`breakpoints ${tokenName}@${modeName}`); continue; }
        const fix = modeIdx === 0
          ? `Add ${cssVar}: ${expected} to :root in ${THEME_PATH}`
          : `Add ${cssVar}: ${expected} inside @media (min-width: ${width}px) in ${THEME_PATH}`;
        FAIL.push({ dimension: 'breakpoints', token: tokenName, cssVar, mode: modeName, issue: modeIdx === 0 ? 'CSS var not declared in :root' : `missing in @media (min-width: ${width}px)`, fixHint: fix });
      } else if (actual !== expected) {
        FAIL.push({ dimension: 'breakpoints', token: tokenName, cssVar, mode: modeName, figma: expected, css: actual, hint: `@media ${width}px: CSS has ${actual} but Figma says ${expected}` });
      } else {
        PASS.push(`breakpoints ${tokenName}@${modeName}`);
      }
    }
  }
}

// ── 6. BOOLEANS ───────────────────────────────────────────────────────────────
// BOOLEAN-typed Figma variables from any collection (theme toggles, feature flags,
// display controls). Advisory only - document implemented vars in BOOLEAN_SKIP.
const boolSnap = snap.booleans ?? {};
const boolSeen = new Set();
for (const [modeName, tokens] of Object.entries(boolSnap)) {
  for (const [tokenName] of Object.entries(tokens)) {
    if (!boolSeen.has(tokenName) && !BOOLEAN_SKIP.has(tokenName)) {
      boolSeen.add(tokenName);
      const cssVar = sizingTokenToVar(tokenName) ?? toVar(tokenName, NAMING, { raw: true });
      BOOL_INFO.push({ token: tokenName, cssVar, breakpoint: modeName });
    }
  }
}

// ── 7. ANIMATION ──────────────────────────────────────────────────────────────
// Retired: motion parity (easing + duration) is owned by Gate 20 (motion-check.mjs), which reads
// snap.motion. The documented Phase 1 capture emits { motion, effects } and never a snap.animation
// key, so this dimension had no producer (dead), and its exact string compare would have false-failed
// on whitespace (cubic-bezier(0.2, 0, 0, 1) vs cubic-bezier(0.2,0,0,1)) - which motion-check's norm()
// avoids. Removed to keep this gate to the value dimensions it uniquely owns.

// ── EFFECTS: declared CSS effects must be present in the merged CSS ───────────
// Verifies that hardcoded visual effects (backdrop-filter, box-shadow, filter) declared
// in EFFECTS are present in the actual CSS. Not driven by Figma variables - these are
// design-system-level effects documented manually in parity-map.mjs.
for (const { selector, prop, expected } of EFFECTS) {
  const sEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pEsc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const eEsc = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`${sEsc}[^{]*\\{[\\s\\S]*?${pEsc}\\s*:[^;]*${eEsc}`);
  if (!blockRe.test(css)) {
    EFFECTS_FAIL.push({ selector, prop, expected, issue: `${prop}: ${expected} not found in "${selector}" rule` });
  }
}

// ── FOCUS CONTRACT: verify focus treatment per component selector ──────────────
// FOCUS_CONTRACT in parity-map.mjs declares how each interactive component handles focus.
// type 'visible'  → :focus-visible rule must exist for the selector
// type 'within'   → :focus-within rule must exist
// type 'suppress' → outline: none must be declared in the selector's rule block
for (const { selector, type } of FOCUS_CONTRACT) {
  const sEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let ok = false;
  if (type === 'visible') {
    ok = new RegExp(`${sEsc}[^{,]*:focus-visible`).test(css);
    if (!ok) FOCUS_INFO.push({ selector, type, note: ':focus-visible rule not found - add focus-visible styling or change to "suppress"' });
  } else if (type === 'within') {
    ok = new RegExp(`${sEsc}[^{,]*:focus-within`).test(css);
    if (!ok) FOCUS_INFO.push({ selector, type, note: ':focus-within rule not found' });
  } else if (type === 'suppress') {
    ok = new RegExp(`${sEsc}[^{]*\\{[\\s\\S]*?outline\\s*:\\s*none`).test(css);
    if (!ok) FOCUS_INFO.push({ selector, type, note: 'outline: none not found in selector block - add it or document as "visible"' });
  }
}

// ── SCOPE RULES: CSS vars must only appear in allowed CSS property types ───────
// SCOPE_RULES in parity-map.mjs: [{ var: '--text', allowedProps: ['color'] }, ...]
// Scans all non-:root CSS rules for scope violations (e.g. color var used as padding).
if (SCOPE_RULES.length) {
  const rulesCSS = css.replace(/:root\s*\{[\s\S]*?\}/g, '');
  for (const { var: varName, allowedProps } of SCOPE_RULES) {
    const varEsc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleRe = new RegExp(`([\\w-]+)\\s*:[^;{]*var\\(${varEsc}[,)][^;{]*;`, 'g');
    for (const m of rulesCSS.matchAll(ruleRe)) {
      const usedProp = m[1].trim();
      if (!allowedProps.includes(usedProp)) {
        SCOPE_FAIL.push({ var: varName, usedProp, allowedProps, issue: `${varName} used in "${usedProp}:" - allowed only in [${allowedProps.join(', ')}]` });
      }
    }
  }
}

// ── Tokens the code capture could not read reliably ──────────────────────────
// When the browser and the CSS text disagree about a token (code.snapshot.json marks it
// uncertain), a mismatch on it is a reading problem, not a design difference: it is listed as
// not verified instead of failed. Only a snapshot that still matches the code is used.
{
  const cap = await readFreshSnapshot(ROOT, cfg).catch(() => null);
  const unsure = new Map();
  for (const [name, tk] of Object.entries(cap?.tokens ?? {})) {
    const bad = Object.entries(tk.modes ?? {}).filter(([, f]) => f.confidence === 'uncertain');
    if (bad.length) unsure.set(name, bad.map(([m, f]) => `${m}: browser ${f.readings?.browser} · CSS ${f.readings?.static}`).join('; '));
  }
  if (unsure.size) {
    for (let i = FAIL.length - 1; i >= 0; i--) {
      const f = FAIL[i];
      if (!f.cssVar || !unsure.has(f.cssVar) || f.figma == null) continue;
      FAIL.splice(i, 1);
      NEW_SKIP.push({ dimension: f.dimension, token: f.token, cssVar: f.cssVar, mode: f.mode, reason: `could not read reliably - ${unsure.get(f.cssVar)}` });
      for (let j = autoFixes.length - 1; j >= 0; j--) if (autoFixes[j].cssVar === f.cssVar) autoFixes.splice(j, 1);
    }
  }
}

// ── Auto-fix: apply sizing/typography fixes to theme.css ─────────────────────
if (FIX_MODE && autoFixes.length > 0 && THEME_PATHS.length > 1) {
  // rawCss is every theme file concatenated; writing it back would merge them all into the
  // first file. Auto-fix only supports a single theme file - skip rather than corrupt.
  console.log(`\n⚠️  --fix supports a single theme file, but ${THEME_PATHS.length} are configured (${THEME_PATHS.join(', ')}).`);
  console.log('   Skipping auto-fix to avoid merging the files; apply the fix hints below by hand.');
} else if (FIX_MODE && autoFixes.length > 0) {
  let lines = rawCss.split('\n');
  let fixedCount = 0;
  for (const fix of autoFixes) {
    const idx    = fix.line - 1;
    const before = lines[idx];
    lines[idx]   = lines[idx].replace(
      new RegExp(`(${fix.cssVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*)[^;]+`),
      `$1${fix.newVal}`
    );
    if (lines[idx] !== before) fixedCount++;
  }
  writeFileSync(join(ROOT, THEME_PATH), lines.join('\n'));
  console.log(`\n🔧 Auto-fixed ${fixedCount} sizing/typography value(s) in ${THEME_PATH}`);
  const colorFails = FAIL.filter(f => f.dimension === 'color').length;
  if (colorFails > 0)
    console.log(`   ℹ️  ${colorFails} color divergence(s) need manual review - see Fix hints below`);
}

// ── Mode blocks a browser never applies ──────────────────────────────────────
// ".dark :root { … }" and "[data-theme=dark] :root { … }" are still read as the mode's block (the
// engine used to document them), but no browser applies them: :root has no ancestor. Advisory.
const NEVER_APPLIED = neverAppliedRootSelectors(TOKEN_SOURCES);

// ── Report ────────────────────────────────────────────────────────────────────
const _extraDims = [
  Object.keys(strSnap).length  > 0 && 'font strings',
  bpModeNames.length > 0 && `breakpoints (${bpModeNames.length} modes)`,
].filter(Boolean);
const _passLabel = ['color · radius · gap · padding · stroke · typography', ..._extraDims].join(' · ');
console.log(`\n✅ PASS  ${PASS.length}   (${_passLabel})`);
console.log(`⏭  SKIP  ${SKIP.length}`);
console.log(`⚠️  NEW SKIP  ${NEW_SKIP.length}`);
console.log(`❌ FAIL  ${FAIL.length}`);
if (NEVER_APPLIED.length) {
  console.log(`⚠️  NEVER APPLIED ${NEVER_APPLIED.length}  (token block under an ancestor of :root - a browser never uses it)`);
  for (const n of NEVER_APPLIED.slice(0, 10)) console.log(`     ℹ️  ${n.file}:${n.line}  ${n.selector}${n.suggest ? `  → write ${n.suggest}` : ''}`);
}
if (snap.aliases) console.log(`🔗 ALIAS FAIL  ${ALIAS_FAIL.length}  (same hex, wrong primitive chain)`);
if (sourceSnap)   console.log(`⏳ PENDING FIGMA SYNC  ${PENDING_FIGMA_SYNC.length}  (code matches DS source; consumer file has a pending library update)`);
if (BOOL_INFO.length) console.log(`ℹ️  BOOLEAN TOKENS  ${BOOL_INFO.length}  (implement via display rules or class toggles - add to BOOLEAN_SKIP in parity-map.mjs to suppress)`);
if (EFFECTS_FAIL.length) console.log(`❌ EFFECTS FAIL  ${EFFECTS_FAIL.length}  (declared CSS effects missing - update EFFECTS in parity-map.mjs)`);
if (SCOPE_FAIL.length)   console.log(`❌ SCOPE FAIL  ${SCOPE_FAIL.length}  (token used in wrong CSS property type - fix or update SCOPE_RULES)`);
if (TYPO_INFO.length)    console.log(`ℹ️  TYPO UNUSED  ${TYPO_INFO.length}  (typography vars not applied in component rules)`);
if (FOCUS_INFO.length)   console.log(`ℹ️  FOCUS GAPS  ${FOCUS_INFO.length}  (update FOCUS_CONTRACT in parity-map.mjs)`);

if (SKIP.length) {
  console.log('\n─── Skipped (expected - each has a documented reason) ─────────');
  for (const s of SKIP) console.log(`  ⏭  [${s.dimension}/${s.mode}] ${s.token} - ${s.reason}`);
}
if (NEW_SKIP.length) {
  console.log('\n─── ⚠️ NEW / UNEXPECTED SKIPS (must be signed off) ───────────');
  for (const s of NEW_SKIP) console.log(`  ⚠️  [${s.dimension}/${s.mode}] ${s.token} - ${s.reason}`);
}
if (FAIL.length) {
  console.log('\n─── Divergences ──────────────────────────────────────────────');
  for (const f of FAIL) {
    if (f.issue) {
      console.log(`  ❌ [${f.dimension}/${f.mode}] ${f.token} → ${f.cssVar}: ${f.issue}`);
    } else {
      console.log(`  ❌ [${f.dimension}/${f.mode}] ${f.token} → ${f.cssVar}`);
      console.log(`       Figma: ${f.figma}   CSS: ${f.css}`);
    }
    if (f.fixHint) console.log(`       Fix:  ${f.fixHint}`);
    if (f.token) { const src = tokenSource(f.token, { dict: TOKENS_DICT, contractsDir: CONTRACTS_REL }); if (src) console.log(`       ${src}`); }
  }
}
if (ALIAS_FAIL.length) {
  console.log('\n─── 🔗 Alias mismatches (same hex, wrong primitive chain) ─────');
  for (const a of ALIAS_FAIL) {
    console.log(`  🔗 [color/${a.mode}] ${a.token} → ${a.cssVar}`);
    console.log(`       Figma chain:  ${a.figmaChain.join(' → ')}`);
    console.log(`       CSS chain:    ${a.cssChain?.join(' → ') || '(no alias chain - hardcoded hex)'}`);
    if (a.mismatchAt !== undefined)
      console.log(`       Mismatch at hop #${a.mismatchAt}: expected ${a.expected}  got ${a.actual}`);
  }
}
if (PENDING_FIGMA_SYNC.length) {
  console.log('\n─── ⏳ Pending Figma library updates (not failures) ────────────');
  console.log('   Code matches DS source. Consumer Figma file has a pending library update.');
  for (const p of PENDING_FIGMA_SYNC) {
    console.log(`  ⏳ [color/${p.mode}] ${p.token} → ${p.cssVar}`);
    console.log(`       CSS (matches source): ${p.css}   Consumer Figma: ${p.consumerFigma}`);
  }
}

if (BOOL_INFO.length) {
  console.log('\n─── ℹ️  Boolean tokens (need implementation map) ──────────────');
  console.log('   Figma BOOLEAN vars control visibility, feature flags, or theme toggles.');
  console.log('   Implement via display rules, data-* attributes, or JS class toggles,');
  console.log('   then add each token to BOOLEAN_SKIP in parity-map.mjs to suppress.');
  for (const b of BOOL_INFO) {
    console.log(`  ℹ️  [${b.breakpoint}] ${b.token}  →  ${b.cssVar}`);
  }
}
if (TYPO_INFO.length) {
  console.log('\n─── ℹ️  Typography vars not applied in component rules ─────────');
  console.log('   These vars are declared in :root with the right Figma value but never');
  console.log('   referenced in any component-level CSS rule (font-size/weight/lh).');
  for (const t of TYPO_INFO) console.log(`  ℹ️  ${t.cssVar}  -  ${t.note}`);
}
if (EFFECTS_FAIL.length) {
  console.log('\n─── ❌ Missing declared CSS effects ────────────────────────────');
  console.log('   These effects are declared in EFFECTS (parity-map.mjs) but not found in CSS.');
  for (const e of EFFECTS_FAIL) console.log(`  ❌  ${e.selector}  -  ${e.issue}`);
}
if (FOCUS_INFO.length) {
  console.log('\n─── ℹ️  Focus contract gaps ─────────────────────────────────────');
  console.log('   Declare focus treatment in FOCUS_CONTRACT (parity-map.mjs).');
  for (const f of FOCUS_INFO) console.log(`  ℹ️  ${f.selector} [${f.type}]  -  ${f.note}`);
}
if (SCOPE_FAIL.length) {
  console.log('\n─── ❌ Token scope violations ───────────────────────────────────');
  console.log('   CSS var used in a property type outside its declared SCOPE_RULES.');
  for (const s of SCOPE_FAIL) console.log(`  ❌  ${s.issue}`);
}

if (JSON_MODE) {
  writeFileSync(join(ROOT, 'parity-check-result.json'), JSON.stringify({
    pass: FAIL.length === 0 && NEW_SKIP.length === 0 && ALIAS_FAIL.length === 0 && EFFECTS_FAIL.length === 0 && SCOPE_FAIL.length === 0,
    fail: FAIL, aliasFail: ALIAS_FAIL, newSkip: NEW_SKIP, skip: SKIP,
    pendingFigmaSync: PENDING_FIGMA_SYNC,
    boolInfo: BOOL_INFO, typoInfo: TYPO_INFO,
    effectsFail: EFFECTS_FAIL, focusInfo: FOCUS_INFO, scopeFail: SCOPE_FAIL,
    passList: PASS,
  }, null, 2));
}

if (FAIL.length === 0 && NEW_SKIP.length === 0 && ALIAS_FAIL.length === 0 && EFFECTS_FAIL.length === 0 && SCOPE_FAIL.length === 0) {
  console.log('\nAll resolved CSS values match Figma snapshot. ✓\n');
  process.exit(0);
} else { console.log(''); process.exit(1); }
