// parity-check.mjs — Run from project root: node scripts/parity-check.mjs [--fix]
//
// --fix: auto-apply sizing/typography value fixes directly to theme.css.
//        Color divergences are printed as actionable fix hints only —
//        alias chains require manual review to avoid breaking other tokens.
//
// Resolves every CSS var chain for all configured modes and diffs against
// the Figma snapshot across three dimensions:
//   1. Color      — every component color token, all configured modes
//   2. Sizing     — gap / padding / radii / thickness / min-height
//   3. Typography — type scale (size, weight, line-height)
//
// Requires at project root:
//   ds-config.json   — themeCSS + snapshotVars paths + figma.modes config
//   parity-map.mjs   — EXPLICIT, SKIP_TOKENS, NULL_TOKENS, KNOWN_NULL,
//                       EXPLICIT_SIZING, SIZING_SKIP, TYPO,
//                       NEUTRAL_LIGHT, NEUTRAL_DARK, NEUTRAL_VAR_RE,
//                       NEUTRAL_MAPS (for 3+ modes — { modeName: {...} } or array)
//
// Exit 0 = full parity. Exit 1 = at least one FAIL or NEW SKIP.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT     = process.cwd();
const FIX_MODE  = process.argv.includes('--fix');
const JSON_MODE = process.argv.includes('--json');

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATHS   = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const THEME_PATH    = THEME_PATHS[0]; // primary — used in fix hints
const THEME_LABEL   = THEME_PATHS.length === 1 ? THEME_PATHS[0] : `[${THEME_PATHS.map(p=>p.split('/').pop()).join(', ')}]`;
const SNAPSHOT_PATH = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';

// ── Mode configuration ────────────────────────────────────────────────────────
// New: cfg.figma.modes = [{ name, snapshotKey?, cssSelector }]
//   cssSelector values:
//     "root"                — :root { }
//     "dark-media"          — @media (prefers-color-scheme: dark) { :root { } }
//     "high-contrast-media" — @media (prefers-contrast: more) { :root { } }
//     "class:<name>"        — .<name> :root { } or :root.<name> { }
//     "data:<attr>=<val>"   — [data-theme="dark"] :root { }
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

let EXPLICIT = {}, NULL_TOKENS = new Set(), SKIP_TOKENS = new Set(),
    KNOWN_NULL = new Set(), EXPLICIT_SIZING = {}, SIZING_SKIP = new Map(), TYPO = {},
    BOOLEAN_SKIP = new Set(), ANIMATION_SKIP = new Set();
let NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;
// neutralMaps[i] = { key: '#hex' } for mode i — keys match NEUTRAL_VAR_RE capture group
let neutralMaps = MODES.map(() => ({}));

try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.NULL_TOKENS)     NULL_TOKENS     = map.NULL_TOKENS;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.KNOWN_NULL)      KNOWN_NULL      = map.KNOWN_NULL;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
  if (map.SIZING_SKIP)     SIZING_SKIP     = map.SIZING_SKIP;
  if (map.TYPO)            TYPO            = map.TYPO;
  if (map.NEUTRAL_VAR_RE)  NEUTRAL_VAR_RE  = map.NEUTRAL_VAR_RE;
  if (map.BOOLEAN_SKIP)    BOOLEAN_SKIP   = map.BOOLEAN_SKIP instanceof Set ? map.BOOLEAN_SKIP : new Set(map.BOOLEAN_SKIP);
  if (map.ANIMATION_SKIP)  ANIMATION_SKIP = map.ANIMATION_SKIP instanceof Set ? map.ANIMATION_SKIP : new Set(map.ANIMATION_SKIP);
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
  console.warn('⚠️  parity-map.mjs not found — running with empty token maps.');
  console.warn('   All non-standard token names will appear as FAIL or NEW SKIP.');
  console.warn('   Copy parity-map.example.mjs → parity-map.mjs to configure.\n');
}

// ── Parse token CSS (all configured files merged) ─────────────────────────────
const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function parseVarBlock(block) {
  const vars = {};
  for (const m of block.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*):\s*([^;]+);/g))
    vars['--' + m[1].trim()] = m[2].trim();
  return vars;
}

function parseSelectorVars(css, selector) {
  let m;
  if (selector === 'root') {
    m = css.match(/:root\s*\{([\s\S]*?)\}/);
  } else if (selector === 'dark-media') {
    m = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{([\s\S]*?)\}\s*\}/);
  } else if (selector === 'high-contrast-media') {
    m = css.match(/@media\s*\(prefers-contrast:\s*(?:more|forced)\)\s*\{[\s\S]*?:root\s*\{([\s\S]*?)\}\s*\}/);
  } else if (selector.startsWith('class:')) {
    const cls = selector.slice(6).trim();
    m = css.match(new RegExp(`\\.${cls}\\s+:root\\s*\\{([\\s\\S]*?)\\}|:root\\.${cls}\\s*\\{([\\s\\S]*?)\\}`));
  } else if (selector.startsWith('data:')) {
    const parts = selector.slice(5).split('=');
    const attr = parts[0], val = parts.slice(1).join('=').replace(/^['"]|['"]$/g, '');
    m = css.match(new RegExp(`\\[${attr}=['"]?${val}['"]?\\]\\s*:root\\s*\\{([\\s\\S]*?)\\}|:root\\[${attr}=['"]?${val}['"]?\\]\\s*\\{([\\s\\S]*?)\\}`));
  } else {
    try { m = css.match(new RegExp(selector)); } catch { return {}; }
  }
  return m ? parseVarBlock(m[1] ?? m[2] ?? '') : {};
}

// modeVars[0] = base (:root), modeVars[i] = override vars for mode i
const modeVars = MODES.map(m => parseSelectorVars(css, m.cssSelector));

// ── Line-number index (for fix hints) ─────────────────────────────────────────
const rawLines = rawCss.split('\n');
const varLineMap = {};
for (let i = 0; i < rawLines.length; i++) {
  const m = rawLines[i].match(/^\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*:/);
  if (m) varLineMap[m[1]] = i + 1; // 1-indexed; keeps last occurrence
}

// ── Resolver caches — one Map per mode for color, one for scalar ─────────────
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
  const vMatch  = t.match(/^var\((--.+?)\)$/);
  if (vMatch)  { const r = resolve(vMatch[1],  modeIdx, depth + 1); cache.set(varName, r); return r; }
  const vfMatch = t.match(/^var\((--.+?),/);
  if (vfMatch) { const r = resolve(vfMatch[1], modeIdx, depth + 1); cache.set(varName, r); return r; }
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) {
    const r = t.toLowerCase();
    cache.set(varName, r);
    return r;
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
  const v  = t.match(/^var\((--.+?)\)$/);   if (v)  { const r = resolveScalar(v[1],  depth + 1); if (depth === 0) scalarCache.set(varName, r); return r; }
  const vf = t.match(/^var\((--.+?),/);      if (vf) { const r = resolveScalar(vf[1], depth + 1); if (depth === 0) scalarCache.set(varName, r); return r; }
  if (depth === 0) scalarCache.set(varName, t);
  return t;
}

// ── Alias chain helpers ────────────────────────────────────────────────────────
// Returns the immediate var() target (one hop), or null if the value is a literal.
function resolveCSSAlias(varName, modeIdx) {
  const raw = (modeIdx > 0 ? modeVars[modeIdx]?.[varName] : undefined) ?? modeVars[0][varName];
  if (!raw) return null;
  const vm = raw.trim().match(/^var\((--.+?)\)$/);
  return vm ? vm[1] : null;
}

// 'primitives/Neutral 300' → '--neutral-300'
function figmaAliasToCSSVar(alias) {
  const bare = alias.startsWith(PRIMITIVE_PREFIX) ? alias.slice(PRIMITIVE_PREFIX.length) : alias;
  return '--' + bare.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
}

// Converts a Figma alias hop name to CSS var, applying the project's naming conventions.
// Unlike figmaAliasToCSSVar: preserves case for semantic tokens and drops DROP_SEGMENTS suffixes.
// Used for full intermediate chain comparisons.
function aliasHopToVar(hop) {
  if (hop.startsWith(PRIMITIVE_PREFIX)) {
    const bare = hop.slice(PRIMITIVE_PREFIX.length);
    return '--' + bare.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
  }
  let v = ICON_TEXT_ALIAS ? hop.replace(/\/iconText\//g, '/text/') : hop;
  if (DROP_SEGMENTS.includes('color'))   v = v.replace(/\/color$/, '');
  if (DROP_SEGMENTS.includes('default')) v = v.replace(/\/default$/, '');
  return '--' + v.replace(/\//g, '-');
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
  const loc     = line ? `${THEME_PATH}:${line}` : THEME_PATH;
  if (suggest)
    return `${loc} — ${cssVar}: ${current ?? '?'} should resolve to ${suggest} (${figmaHex})`;
  return `${loc} — chain should resolve to ${figmaHex} (no matching neutral found)`;
}

function sizingFixHint(cssVar, figmaVal) {
  const line    = varLineMap[cssVar];
  const current = modeVars[0][cssVar];
  if (!line) return `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}`;
  return `${THEME_PATH}:${line} — change ${cssVar}: ${current ?? '?'} → ${figmaVal}`;
}

// ── Token → CSS var (convention) ─────────────────────────────────────────────
function tokenToVar(token) {
  if (SKIP_TOKENS.has(token) || NULL_TOKENS.has(token)) return null;
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, token)) return EXPLICIT[token];
  let v = ICON_TEXT_ALIAS ? token.replace(/\/iconText\//g, '/text/') : token;
  if (DROP_SEGMENTS.includes('default')) v = v.replace(/\/default$/, '');
  return '--' + v.replace(/\//g, '-');
}

function sizingTokenToVar(token) {
  if (SIZING_SKIP.has(token)) return null;
  if (EXPLICIT_SIZING[token]) return EXPLICIT_SIZING[token];
  return '--' + token.replace(/\//g, '-');
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

// Source snapshot (DS library file) — populated by Phase 1 when figmaSourceKey is set.
// When present, value mismatches are cross-checked: if source matches CSS, the consumer
// file just has a pending library update → PENDING_FIGMA_SYNC (not a gate failure).
const sourceSnap = snap.source ?? null;

// ── Accumulators ──────────────────────────────────────────────────────────────
const FAIL = [], PASS = [], SKIP = [], NEW_SKIP = [], ALIAS_FAIL = [], PENDING_FIGMA_SYNC = [], BOOL_INFO = [], ANIM_INFO = [];
const autoFixes = []; // { cssVar, newVal, line } — applied when --fix

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
        NEW_SKIP.push({ dimension: 'color', token, mode: modeMeta.name, reason: 'Figma value is NEW null — add to KNOWN_NULL in parity-map.mjs' });
      continue;
    }
    const inBase     = !!modeVars[0][cssVar];
    const inOverride = modeIdx > 0 && !!modeVars[modeIdx]?.[cssVar];
    if (!inBase && !inOverride) {
      FAIL.push({ dimension: 'color', token, cssVar, mode: modeMeta.name, issue: `CSS var not declared in token CSS`, fixHint: `Add ${cssVar} to ${THEME_LABEL}` });
      continue;
    }
    const cssHex = resolve(cssVar, modeIdx);
    if (cssHex === null) {
      NEW_SKIP.push({ dimension: 'color', token, cssVar, mode: modeMeta.name, reason: 'CSS resolves to non-hex — add to SKIP_TOKENS in parity-map.mjs if intentional' });
      continue;
    }
    if (figmaHex.toLowerCase() !== cssHex.toLowerCase()) {
      // Cross-check against DS source: if source matches CSS, consumer just has a pending
      // library update — this is not a code bug. Route to PENDING_FIGMA_SYNC instead of FAIL.
      const sourceHex = sourceSnap?.[modeMeta.snapshotKey]?.[tokenKey]
                     ?? sourceSnap?.[modeMeta.snapshotKey]?.[token] ?? null;
      if (sourceHex && sourceHex.toLowerCase() === cssHex.toLowerCase()) {
        PENDING_FIGMA_SYNC.push({ token, cssVar, mode: modeMeta.name, consumerFigma: figmaHex, css: cssHex });
      } else {
        FAIL.push({
          dimension: 'color', token, cssVar, mode: modeMeta.name,
          figma: figmaHex, css: cssHex,
          hint:    `CSS resolves ${cssVar} → ${cssHex} but Figma says ${figmaHex}`,
          fixHint: colorFixHint(cssVar, figmaHex, modeIdx),
        });
      }
    } else {
      PASS.push(`color ${token}:${modeMeta.snapshotKey}`);

      // Alias chain check — CSS var() chain must route through same primitive as Figma.
      // Same hex can pass value check while chain goes through a different primitive — still wrong.
      const figmaRaw = snap.aliases?.[modeMeta.snapshotKey]?.[tokenKey]
                    ?? snap.aliases?.[modeMeta.snapshotKey]?.[token] ?? null;
      if (figmaRaw) {
        const rawHops = Array.isArray(figmaRaw) ? figmaRaw : [figmaRaw];
        const figmaChain = rawHops.map(hop => aliasHopToVar(hop));
        const lastFigmaHop = figmaChain[figmaChain.length - 1];

        // Only check when Figma chain ends in a known primitive
        if (rawHops[rawHops.length - 1].startsWith(PRIMITIVE_PREFIX)) {
          const cssChain = [];
          let cur = cssVar;
          for (let i = 0; i < 10; i++) {
            const next = resolveCSSAlias(cur, modeIdx);
            if (!next) break;
            cssChain.push(next);
            cur = next;
          }

          const lastCSSHop = cssChain[cssChain.length - 1] ?? null;

          // Final primitive must match
          if (lastCSSHop !== lastFigmaHop) {
            ALIAS_FAIL.push({ token, cssVar, mode: modeMeta.name, figmaChain, cssChain,
              mismatchAt: cssChain.length - 1,
              expected: lastFigmaHop, actual: lastCSSHop ?? '(no alias chain — hardcoded hex)' });
          } else {
            // Check intermediate hops where both chains have a value.
            // If CSS arrives at the final primitive directly (skipping semantic intermediates),
            // that's allowed — break early. Only flag if CSS routes through a different semantic var.
            for (let i = 0; i < figmaChain.length - 1; i++) {
              const csshop = cssChain[i];
              if (csshop === undefined) break; // CSS chain is shorter — skip remaining
              if (csshop === lastFigmaHop) break; // CSS arrived at primitive directly — OK
              if (csshop !== figmaChain[i]) {
                ALIAS_FAIL.push({ token, cssVar, mode: modeMeta.name, figmaChain, cssChain,
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
  if (!modeVars[0][cssVar]) {
    FAIL.push({ dimension: 'sizing', token, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}` });
    continue;
  }
  const cssVal = resolveScalar(cssVar);
  if (cssVal === null) {
    NEW_SKIP.push({ dimension: 'sizing', token, cssVar, mode: '-', reason: 'CSS var did not resolve to a literal' });
    continue;
  }
  if (String(figmaVal).trim() !== cssVal.trim()) {
    const fixHint = sizingFixHint(cssVar, figmaVal);
    FAIL.push({ dimension: 'sizing', token, cssVar, mode: '-', figma: figmaVal, css: cssVal, hint: `CSS resolves ${cssVar} → ${cssVal} but Figma says ${figmaVal}`, fixHint });
    if (FIX_MODE) {
      const line = varLineMap[cssVar];
      if (line) autoFixes.push({ cssVar, newVal: String(figmaVal).trim(), line });
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
    if (!modeVars[0][cssVar]) {
      FAIL.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${figmaVal} to ${THEME_PATH}` });
      continue;
    }
    const cssVal = resolveScalar(cssVar);
    if (cssVal === null) {
      NEW_SKIP.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar, mode: '-', reason: 'CSS var did not resolve' });
      continue;
    }
    if (String(figmaVal).trim() !== cssVal.trim()) {
      const fixHint = sizingFixHint(cssVar, figmaVal);
      FAIL.push({ dimension: 'typography', token: `${scale}/${prop}`, cssVar, mode: '-', figma: figmaVal, css: cssVal, hint: `CSS resolves ${cssVar} → ${cssVal} but Figma says ${figmaVal}`, fixHint });
      if (FIX_MODE) {
        const line = varLineMap[cssVar];
        if (line) autoFixes.push({ cssVar, newVal: String(figmaVal).trim(), line });
      }
    } else {
      PASS.push(`typography ${scale}/${prop}`);
    }
  }
} else if (!snap.typography) {
  SKIP.push({ dimension: 'typography', token: 'ALL', mode: '-', reason: 'snapshot has no typography section — run /rms-parity Phase 1' });
} else if (!Object.keys(TYPO).length) {
  SKIP.push({ dimension: 'typography', token: 'ALL', mode: '-', reason: 'TYPO map empty in parity-map.mjs — add your type scale vars' });
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
  const raw = modeVars[0][cssVar];
  if (!raw) {
    FAIL.push({ dimension: 'strings', token: tokenName, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${expected} to ${THEME_PATH}` });
    continue;
  }
  const norm = s => String(s).replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (norm(raw) !== norm(expected)) {
    FAIL.push({ dimension: 'strings', token: tokenName, cssVar, mode: '-', figma: expected, css: raw, hint: `CSS has ${cssVar}: ${raw} but Figma says "${expected}"`, fixHint: `${THEME_PATH} — change ${cssVar}: ${raw} → ${expected}` });
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
          const cssVar = sizingTokenToVar(tokenName) ?? '--' + tokenName.replace(/\//g, '-');
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
// display controls). Advisory only — document implemented vars in BOOLEAN_SKIP.
const boolSnap = snap.booleans ?? {};
const boolSeen = new Set();
for (const [modeName, tokens] of Object.entries(boolSnap)) {
  for (const [tokenName] of Object.entries(tokens)) {
    if (!boolSeen.has(tokenName) && !BOOLEAN_SKIP.has(tokenName)) {
      boolSeen.add(tokenName);
      const cssVar = sizingTokenToVar(tokenName) ?? '--' + tokenName.replace(/\//g, '-');
      BOOL_INFO.push({ token: tokenName, cssVar, breakpoint: modeName });
    }
  }
}

// ── 7. ANIMATION ──────────────────────────────────────────────────────────────
// EASING and TIMING Figma variables — pre-formatted as CSS values in the snapshot:
//   EASING → 'cubic-bezier(p1x, p1y, p2x, p2y)'
//   TIMING → 'Nms'
// Each maps to a CSS custom property the same way sizing/string tokens do.
const animSnap = snap.animation ?? {};
for (const [tokenName, expected] of Object.entries(animSnap)) {
  if (ANIMATION_SKIP.has(tokenName)) {
    SKIP.push({ dimension: 'animation', token: tokenName, mode: '-', reason: 'excluded in ANIMATION_SKIP' });
    continue;
  }
  const cssVar = sizingTokenToVar(tokenName);
  if (cssVar === null) {
    SKIP.push({ dimension: 'animation', token: tokenName, mode: '-', reason: 'excluded in SIZING_SKIP' });
    continue;
  }
  const raw = modeVars[0][cssVar];
  if (!raw) {
    FAIL.push({ dimension: 'animation', token: tokenName, cssVar, mode: '-', issue: 'CSS var not declared', fixHint: `Add ${cssVar}: ${expected} to ${THEME_PATH}` });
    continue;
  }
  if (raw.trim() !== String(expected).trim()) {
    FAIL.push({ dimension: 'animation', token: tokenName, cssVar, mode: '-', figma: expected, css: raw, hint: `CSS has ${cssVar}: ${raw} but Figma says "${expected}"`, fixHint: `${THEME_PATH} — change ${cssVar}: ${raw} → ${expected}` });
  } else {
    PASS.push(`animation ${tokenName}`);
    // Usage advisory: var declared with right value but never referenced in transition/animation
    const usageRe = new RegExp(`var\\(${cssVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,)]`);
    if (!usageRe.test(rawCss)) {
      ANIM_INFO.push({ token: tokenName, cssVar, note: 'declared but not referenced in any transition/animation rule — add to ANIMATION_SKIP if used via JS' });
    }
  }
}

// ── Auto-fix: apply sizing/typography fixes to theme.css ─────────────────────
if (FIX_MODE && autoFixes.length > 0) {
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
    console.log(`   ℹ️  ${colorFails} color divergence(s) need manual review — see Fix hints below`);
}

// ── Report ────────────────────────────────────────────────────────────────────
const _extraDims = [
  Object.keys(strSnap).length  > 0 && 'font strings',
  bpModeNames.length > 0 && `breakpoints (${bpModeNames.length} modes)`,
  Object.keys(animSnap).length > 0 && 'animation',
].filter(Boolean);
const _passLabel = ['color · radius · gap · padding · stroke · typography', ..._extraDims].join(' · ');
console.log(`\n✅ PASS  ${PASS.length}   (${_passLabel})`);
console.log(`⏭  SKIP  ${SKIP.length}`);
console.log(`⚠️  NEW SKIP  ${NEW_SKIP.length}`);
console.log(`❌ FAIL  ${FAIL.length}`);
if (snap.aliases) console.log(`🔗 ALIAS FAIL  ${ALIAS_FAIL.length}  (same hex, wrong primitive chain)`);
if (sourceSnap)   console.log(`⏳ PENDING FIGMA SYNC  ${PENDING_FIGMA_SYNC.length}  (code matches DS source; consumer file has a pending library update)`);
if (BOOL_INFO.length) console.log(`ℹ️  BOOLEAN TOKENS  ${BOOL_INFO.length}  (implement via display rules or class toggles — add to BOOLEAN_SKIP in parity-map.mjs to suppress)`);

if (SKIP.length) {
  console.log('\n─── Skipped (expected — each has a documented reason) ─────────');
  for (const s of SKIP) console.log(`  ⏭  [${s.dimension}/${s.mode}] ${s.token} — ${s.reason}`);
}
if (NEW_SKIP.length) {
  console.log('\n─── ⚠️ NEW / UNEXPECTED SKIPS (must be signed off) ───────────');
  for (const s of NEW_SKIP) console.log(`  ⚠️  [${s.dimension}/${s.mode}] ${s.token} — ${s.reason}`);
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
  }
}
if (ALIAS_FAIL.length) {
  console.log('\n─── 🔗 Alias mismatches (same hex, wrong primitive chain) ─────');
  for (const a of ALIAS_FAIL) {
    console.log(`  🔗 [color/${a.mode}] ${a.token} → ${a.cssVar}`);
    console.log(`       Figma chain:  ${a.figmaChain.join(' → ')}`);
    console.log(`       CSS chain:    ${a.cssChain?.join(' → ') || '(no alias chain — hardcoded hex)'}`);
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
if (ANIM_INFO.length) {
  console.log('\n─── ℹ️  Animation vars not used in CSS transitions ────────────');
  console.log('   These vars are declared with the right value but not referenced in any');
  console.log('   transition/animation rule. Add to ANIMATION_SKIP if used via JS API.');
  for (const a of ANIM_INFO) {
    console.log(`  ℹ️  ${a.token}  →  ${a.cssVar}`);
  }
}

if (JSON_MODE) {
  writeFileSync(join(ROOT, 'parity-check-result.json'), JSON.stringify({
    pass: FAIL.length === 0 && NEW_SKIP.length === 0 && ALIAS_FAIL.length === 0,
    fail: FAIL, aliasFail: ALIAS_FAIL, newSkip: NEW_SKIP, skip: SKIP,
    pendingFigmaSync: PENDING_FIGMA_SYNC,
    boolInfo: BOOL_INFO,
    animInfo: ANIM_INFO,
    animationCount: Object.keys(animSnap).length,
    passList: PASS,
  }, null, 2));
}

if (FAIL.length === 0 && NEW_SKIP.length === 0 && ALIAS_FAIL.length === 0) {
  console.log('\nAll resolved CSS values match Figma snapshot. ✓\n');
  process.exit(0);
} else { console.log(''); process.exit(1); }
