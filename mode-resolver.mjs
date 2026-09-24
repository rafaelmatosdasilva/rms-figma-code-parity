// mode-resolver.mjs - shared, N-mode CSS variable resolution for the mode-aware gates
// (Gate [5] mode-completeness, Gate [6] exemption validity, and any future consumer).
//
// A DS is NOT necessarily light/dark, and NOT necessarily one global mode axis. Two things vary:
//   1. `ds-config.json → figma.modes` may list any number of COLOR modes (light/dark, plus
//      high-contrast, …), each with a `cssSelector` saying where that mode's overrides live.
//   2. `ds-config.json → figma.collections` (optional) may declare OTHER typed collections - a
//      sizing collection whose values change per breakpoint, a string collection that changes per
//      locale - each with ITS OWN mode set and cssSelectors, independent of the color axis.
//
// `cssSelector` values (mobile-first / base-first: the first mode is usually `root`, the rest override):
//   'root'                 → :root { }                              (base, no override layer)
//   'dark-media'           → @media (prefers-color-scheme: dark) { :root { } }
//   'high-contrast-media'  → @media (prefers-contrast: more) { :root { } }
//   'media:<condition>'    → @media <condition> { :root { } }       (e.g. 'media:(min-width: 768px)')
//   'class:<name>'         → :root.<name> { }   (the older .<name> :root { } is read too, but no browser applies it)
//   'data:<attr>=<val>'    → :root[data-<attr>="<val>"] { }   (the older [data-…] :root { } likewise)
//
// The 2-mode light/dark case is a strict subset - resolution is byte-identical there. This
// module is the ONE place that hardcodes nothing about a specific DS's modes or collections.

import { rootTokens, blankComments } from './css-source.mjs';

export function loadModes(cfg) {
  const modes = (cfg?.figma?.modes && cfg.figma.modes.length)
    ? cfg.figma.modes
    // Legacy two-mode fallback (honours figma.lightMode / figma.darkMode overrides).
    : [
        { name: cfg?.figma?.lightMode ?? 'Light', snapshotKey: 'light', cssSelector: 'root' },
        { name: cfg?.figma?.darkMode  ?? 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
      ];
  // Derive snapshotKey / cssSelector exactly as parity-check.mjs does, so a config that
  // omits snapshotKey (which parity-check tolerates) doesn't silently turn the mode gates
  // into a no-op: every mode.snapshotKey would be undefined and dedupe to one empty mode.
  return modes.map(m => ({
    ...m,
    snapshotKey: (m.snapshotKey ?? m.name).toLowerCase().replace(/\s+/g, '-'),
    cssSelector: m.cssSelector ?? 'root',
  }));
}

// loadCollections(cfg) → the OTHER typed collections a DS wants mode-checked, beyond the color axis.
// Each: { name, kind: 'color'|'scalar'|'string', modes: [{ name, snapshotKey, cssSelector }] }.
// Absent (or empty) → [] - the legacy single-axis behaviour, so a DS that never declares this is
// unaffected. `kind` decides how a resolved value is compared: hex for color, literal otherwise.
export function loadCollections(cfg) {
  const cols = cfg?.figma?.collections;
  if (!Array.isArray(cols)) return [];
  return cols
    .filter(c => c && c.name && Array.isArray(c.modes) && c.modes.length)
    .map(c => ({ name: c.name, kind: c.kind || 'scalar', modes: c.modes }));
}

// The union of every mode across the color axis + declared collections, deduped by snapshotKey, so
// ONE resolver can resolve any snapshotKey the gates ask for (snapshotKeys are unique per DS).
export function allModes(cfg) {
  const seen = new Set();
  const out = [];
  for (const m of [...loadModes(cfg), ...loadCollections(cfg).flatMap(c => c.modes)]) {
    if (!m || seen.has(m.snapshotKey)) continue;
    seen.add(m.snapshotKey);
    out.push(m);
  }
  return out;
}

export function parseVarBlock(block) {
  const vars = {};
  for (const m of block.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*):\s*([^;]+);/g))
    vars['--' + m[1].trim()] = m[2].trim();
  return vars;
}

// Base :root must come from a TOP-LEVEL :root, not the first :root in file order - an
// @media/@supports block physically preceding it would otherwise poison every base value.
export function stripAtRules(s) {
  let out = s, prev;
  do { prev = out; out = out.replace(/@[a-zA-Z-]+[^{};]*\{(?:[^{}]|\{[^{}]*\})*\}/g, ' '); } while (out !== prev);
  return out;
}

// buildResolver(rawCss, MODES, { NL, ND, NEUTRAL_MAPS, NEUTRAL_VAR_RE })
//   → { resolve(varName, modeKey) → hex|null,
//       resolveRaw(varName, modeKey) → literal|null,   // hex OR scalar ('8px') OR string ('Inter')
//       rootVars, modeBlocks }
// A var resolves in a mode via that mode's override block, falling back to :root (CSS cascade).
// Neutral primitives resolve through NEUTRAL_MAPS[modeKey] (N-mode) or the legacy NL/ND (2-mode).
//
// The CSS is read by css-source.mjs, the reader the code capture uses: every :root block (not only
// the first), each mode resolved by the real cascade (importance, specificity, source order). Pass
// the theme as text, or as [{ file, text }] sources (loadCssSources) so local @import is followed.
// rootVars = every token's declared value in the base; modeBlocks[key] = every token's declared value
// in that mode (the base where the mode does not override it, as the browser does).
export function buildResolver(rawCss, MODES, prims = {}) {
  const { NL = {}, ND = {}, NEUTRAL_MAPS = null, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/ } = prims;
  const sources = Array.isArray(rawCss) ? rawCss.map((s) => ({ file: s.file ?? '', text: blankComments(s.text ?? '') })) : [{ file: '', text: blankComments(String(rawCss ?? '')) }];
  const asObject = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.value]));
  const rootVars = asObject(rootTokens(sources, { cssSelector: 'root' }));
  const modeBlocks = Object.fromEntries(MODES.map(m => [m.snapshotKey, asObject(rootTokens(sources, m))]));
  // NEUTRAL_MAPS may be an array (by mode index) or an object keyed by mode NAME (as
  // parity-map.mjs writes it) or by snapshotKey. Resolve it to snapshotKey → map so the
  // lookup below (which only knows the snapshotKey) works for every form; fall back to the
  // legacy NL/ND for the 2-mode light/dark case.
  const neutralByKey = {};
  if (Array.isArray(NEUTRAL_MAPS)) {
    MODES.forEach((m, i) => { if (NEUTRAL_MAPS[i]) neutralByKey[m.snapshotKey] = NEUTRAL_MAPS[i]; });
  } else if (NEUTRAL_MAPS) {
    for (const m of MODES) { const nm = NEUTRAL_MAPS[m.snapshotKey] ?? NEUTRAL_MAPS[m.name]; if (nm) neutralByKey[m.snapshotKey] = nm; }
  }
  const neutralFor = (key) => neutralByKey[key] || (key === 'light' ? NL : ND);

  // resolveRaw follows var() chains + the mode's override block and returns the LITERAL it lands on
  // (a hex, a '8px', an 'Inter', …). Neutral primitives short-circuit to their mapped hex.
  function resolveRaw(varName, modeKey, depth = 0) {
    if (depth > 8) return null;
    const nm = varName.match(NEUTRAL_VAR_RE);
    if (nm) return neutralFor(modeKey)[nm[1]] ?? null;
    const block = modeBlocks[modeKey];
    const raw = (block && block[varName]) ? block[varName] : rootVars[varName];
    if (!raw) return null;
    const t = raw.trim();
    const v = t.match(/^var\((--.+?)\)$/);
    if (v) return resolveRaw(v[1], modeKey, depth + 1);
    return t;
  }
  // resolve stays hex-only (unchanged semantics: lowercased hex, or null for anything else).
  function resolve(varName, modeKey) {
    const r = resolveRaw(varName, modeKey);
    return (r && /^#[0-9a-fA-F]{3,8}$/.test(r)) ? r.toLowerCase() : null;
  }
  return { resolve, resolveRaw, rootVars, modeBlocks };
}
