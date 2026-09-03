// naming-check.mjs - Gate [11]: CSS var naming round-trip.
// Every CSS var declared in ANY project CSS file (theme.css + pluginCSS) must
// trace back to a Figma token in the snapshot (via convention or EXPLICIT) or
// be on the SYSTEM_VARS exemption list in parity-map.mjs.
//
// Direction: CSS → Figma (reverse of Gates [2] and [4]).
// A var with no Figma backing is either hallucinated or needs to be documented.
//
// Requires at project root:
//   ds-config.json   - snapshot path, themeCSS, pluginCSS
//   parity-map.mjs   - EXPLICIT, EXPLICIT_SIZING, SKIP_TOKENS, SIZING_SKIP,
//                      SYSTEM_VARS (known structural/semantic vars with no 1:1 token)
//
// Exit 0 = all CSS vars traceable.  Exit 1 = uninvented vars found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadModes } from './mode-resolver.mjs';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const THEME_PATH  = THEME_PATHS[0];
const PLUGIN_CSS = cfg.paths?.pluginCSS    ?? [];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, EXPLICIT_SIZING = {}, SKIP_TOKENS = new Set();
let SIZING_SKIP = new Map(), SYSTEM_VARS = new Set(), typoMap = null;
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.SIZING_SKIP)     SIZING_SKIP     = map.SIZING_SKIP;
  if (map.SYSTEM_VARS)     SYSTEM_VARS     = map.SYSTEM_VARS;
  if (map.TYPO)            typoMap         = map.TYPO;
} catch { /* optional */ }

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const MODE_KEYS = loadModes(cfg).map(m => m.snapshotKey);
const figmaTokens = new Set([
  ...MODE_KEYS.flatMap(k => Object.keys(snap.color?.[k] ?? {}).map(t => t.replace(/\/color$/, ''))),
  ...Object.keys(snap.sizing ?? {}),
  ...Object.keys(snap.strings ?? {}),
  ...Object.keys(snap.animation ?? {}),
]);

// ── Build forward map: all CSS vars that ARE expected to exist ────────────────
const knownCSSVars = new Set(SYSTEM_VARS);

// EXPLICIT targets
for (const cssVar of Object.values(EXPLICIT))        if (cssVar) knownCSSVars.add(cssVar);
for (const cssVar of Object.values(EXPLICIT_SIZING)) if (cssVar) knownCSSVars.add(cssVar);
// TYPO map CSS var keys (typography vars auto-registered without needing SYSTEM_VARS entries)
if (typoMap) { for (const cssVar of Object.keys(typoMap)) knownCSSVars.add(cssVar); }

// Convention-derived vars from every Figma token
function conventionVar(token) {
  return '--' + token.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
}
for (const token of figmaTokens) {
  if (SKIP_TOKENS.has(token)) continue;
  if (token in EXPLICIT || token in EXPLICIT_SIZING) continue;
  if (SIZING_SKIP.has(token)) continue;
  knownCSSVars.add(conventionVar(token));
  knownCSSVars.add(conventionVar(token.replace(/\/color$/, '')));
}

// ── Collect declared CSS vars from all CSS files ──────────────────────────────
// Scans theme.css + every pluginCSS file. <script> blocks are stripped from
// HTML files first so JS object literals don't produce false positives.
function readCssContent(p) {
  let src = readFileSync(join(ROOT, p), 'utf8');
  if (p.endsWith('.html')) src = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return src;
}

const rawCss = [...THEME_PATHS, ...PLUGIN_CSS]
  .filter(p => existsSync(join(ROOT, p)))
  .map(readCssContent)
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const declared = new Set();
for (const m of rawCss.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);

// ── Theme vars (for plugin override detection) ────────────────────────────────
const themeRaw = THEME_PATHS
  .filter(p => existsSync(join(ROOT, p))).map(readCssContent)
  .join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const themeVarsDeclared = new Set();
for (const m of themeRaw.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) themeVarsDeclared.add('--' + m[1]);

// ── Plugin CSS override detection ─────────────────────────────────────────────
// Any plugin :root block that re-declares a theme var will override the DS token
// value for the plugin's runtime context - this is a hard parity violation.
// Exempt intentional overrides via ds-config.json → knownPluginOverrides: ["--var"].
const PLUGIN_OVERRIDE = [];
const knownPluginOverrides = new Set(cfg.knownPluginOverrides ?? []);
for (const pluginPath of PLUGIN_CSS.filter(p => existsSync(join(ROOT, p)))) {
  const pluginSrc = readCssContent(pluginPath).replace(/\/\*[\s\S]*?\*\//g, '');
  const rootRe = /:root\s*\{([^}]*)\}/g;
  let rm;
  while ((rm = rootRe.exec(pluginSrc)) !== null) {
    for (const vm of rm[1].matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) {
      const v = '--' + vm[1];
      if (themeVarsDeclared.has(v) && !knownPluginOverrides.has(v))
        PLUGIN_OVERRIDE.push({ file: pluginPath, var: v });
    }
  }
}

// ── Check ─────────────────────────────────────────────────────────────────────
const UNKNOWN = [], OK = [];

for (const cssVar of declared) {
  if (knownCSSVars.has(cssVar)) { OK.push(cssVar); continue; }

  // Reverse convention: --foo-bar-baz → try foo/bar/baz and sub-paths
  const asToken = cssVar.slice(2).replace(/-/g, '/');
  let found = false;
  for (let i = asToken.split('/').length; i >= 1; i--) {
    const candidate = asToken.split('/').slice(0, i).join('/');
    if (figmaTokens.has(candidate) || figmaTokens.has(candidate + '/color')) {
      found = true; break;
    }
  }
  if (found) { OK.push(cssVar); continue; }

  UNKNOWN.push(cssVar);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ TRACEABLE    ${OK.length}  (maps back to a Figma token or SYSTEM_VARS)`);
console.log(`❌ UNINVENTED   ${UNKNOWN.length}  (CSS var with no Figma token backing)`);
if (PLUGIN_OVERRIDE.length) console.log(`❌ OVERRIDES    ${PLUGIN_OVERRIDE.length}  (plugin re-declares a theme var in :root)`);

if (UNKNOWN.length) {
  console.log('\n─── CSS vars with no Figma token (add to DS, delete var, or add to SYSTEM_VARS) ──');
  for (const v of UNKNOWN) console.log(`  ❌ ${v}`);
  console.log('');
}

if (PLUGIN_OVERRIDE.length) {
  console.log('\n─── Plugin CSS overrides theme var in :root ─────────────────────────');
  for (const { file, var: v } of PLUGIN_OVERRIDE)
    console.log(`  ❌ ${file}: ${v}  (add to ds-config.json → knownPluginOverrides to allow)`);
  console.log('');
}

// ── SYSTEM_VARS staleness ─────────────────────────────────────────────────────
// Entries in SYSTEM_VARS that no longer appear as declarations in any CSS file.
// These are phantom exemptions - if a var is re-added later, the stale entry would
// silently exempt it from the naming round-trip check.
const STALE_SYSTEM_VARS = [...SYSTEM_VARS].filter(v => !declared.has(v));
if (STALE_SYSTEM_VARS.length) {
  console.log(`\nℹ️  STALE SYSTEM_VARS (${STALE_SYSTEM_VARS.length}) - in parity-map.mjs but not declared in any CSS file:`);
  for (const v of STALE_SYSTEM_VARS) console.log(`     ${v}`);
  console.log('   Remove these entries from SYSTEM_VARS to keep the exemption list accurate.\n');
}

// ── CSS class selector → CONTRACT cross-reference ─────────────────────────────
// Flags camelCase top-level CSS class selectors (e.g. .buttonPrimary, .sidePanel)
// that have no CONTRACT entry and no knownPluginSelectors exemption.
// FAIL - undocumented selectors indicate a plugin-specific component that should not exist.
const knownPluginSelectors = new Set(cfg.knownPluginSelectors ?? []);
let CONTRACT_KEYS = new Set();
try {
  const contract = await import(join(ROOT, 'structure-contract.mjs'));
  if (contract.CONTRACT) CONTRACT_KEYS = new Set(Object.keys(contract.CONTRACT));
} catch { /* structure-contract.mjs is optional */ }

let selectorFails = false;
if (CONTRACT_KEYS.size) {
  const seen = new Set();
  for (const m of rawCss.matchAll(/(?:^|[}\n])\s*\.([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\s*[{,]/gm)) {
    const cls = m[1];
    if (!CONTRACT_KEYS.has(cls) && !knownPluginSelectors.has(cls)) seen.add(cls);
  }
  if (seen.size) {
    selectorFails = true;
    console.log(`\n❌ UNDOCUMENTED SELECTORS (${seen.size}) - CSS component classes with no DS backing:\n`);
    for (const cls of [...seen].sort()) {
      console.log(`   .${cls}`);
      console.log(`     → Not in CONTRACT and not in ds-config.json → knownPluginSelectors.`);
      console.log(`     → Either add to CONTRACT (if it IS a DS component) or remove from CSS.\n`);
    }
  }
}

if (UNKNOWN.length || PLUGIN_OVERRIDE.length || selectorFails) {
  process.exit(1);
} else {
  console.log('\nAll CSS vars trace back to a Figma token or documented system var. ✓\n');
  process.exit(0);
}
