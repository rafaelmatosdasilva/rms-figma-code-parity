// mode-resolver.mjs — shared, N-mode CSS variable resolution for the mode-aware gates
// (Gate [5] mode-completeness, Gate [6] exemption validity, and any future consumer).
//
// A DS is NOT necessarily light/dark, and NOT necessarily one global mode axis. Two things vary:
//   1. `ds-config.json → figma.modes` may list any number of COLOR modes (light/dark, plus
//      high-contrast, …), each with a `cssSelector` saying where that mode's overrides live.
//   2. `ds-config.json → figma.collections` (optional) may declare OTHER typed collections — a
//      sizing collection whose values change per breakpoint, a string collection that changes per
//      locale — each with ITS OWN mode set and cssSelectors, independent of the color axis.
//
// `cssSelector` values (mobile-first / base-first: the first mode is usually `root`, the rest override):
//   'root'                 → :root { }                              (base, no override layer)
//   'dark-media'           → @media (prefers-color-scheme: dark) { :root { } }
//   'high-contrast-media'  → @media (prefers-contrast: more) { :root { } }
//   'media:<condition>'    → @media <condition> { :root { } }       (e.g. 'media:(min-width: 768px)')
//   'class:<name>'         → .<name> :root { }   (or :root.<name> { })
//   'data:<attr>=<val>'    → [data-<attr>="<val>"] :root { }
//
// The 2-mode light/dark case is a strict subset — resolution is byte-identical there. This
// module is the ONE place that hardcodes nothing about a specific DS's modes or collections.

export function loadModes(cfg) {
  if (cfg?.figma?.modes && cfg.figma.modes.length) return cfg.figma.modes;
  // Legacy two-mode fallback (honours figma.lightMode / figma.darkMode overrides).
  return [
    { name: cfg?.figma?.lightMode ?? 'Light', snapshotKey: 'light', cssSelector: 'root' },
    { name: cfg?.figma?.darkMode  ?? 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
  ];
}

// loadCollections(cfg) → the OTHER typed collections a DS wants mode-checked, beyond the color axis.
// Each: { name, kind: 'color'|'scalar'|'string', modes: [{ name, snapshotKey, cssSelector }] }.
// Absent (or empty) → [] — the legacy single-axis behaviour, so a DS that never declares this is
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

function overrideBlockFor(rawCss, cssSelector) {
  if (!cssSelector || cssSelector === 'root') return {};
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let inner = '';
  if (cssSelector === 'dark-media')
    inner = rawCss.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? '';
  else if (cssSelector === 'high-contrast-media')
    inner = rawCss.match(/@media\s*\(prefers-contrast:\s*more\)\s*\{[\s\S]*?:root\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? '';
  else if (cssSelector.startsWith('media:')) {
    // Generic @media. Build the condition regex from the whitespace-stripped condition, allowing
    // optional whitespace between every character, so 'media:(min-width: 768px)' matches
    // `@media (min-width:768px)` and vice-versa. Mirrors the dark-media capture shape.
    const condRe = cssSelector.slice(6).trim().replace(/\s+/g, '').split('').map(esc).join('\\s*');
    inner = rawCss.match(new RegExp('@media\\s*' + condRe + '\\s*\\{[\\s\\S]*?:root\\s*\\{([\\s\\S]*?)\\}', 'i'))?.[1] ?? '';
  } else if (cssSelector.startsWith('class:')) {
    const c = esc(cssSelector.slice(6));
    inner = rawCss.match(new RegExp(`\\.${c}\\s+:root\\s*\\{([\\s\\S]*?)\\}`))?.[1]
         ?? rawCss.match(new RegExp(`:root\\.${c}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
  } else if (cssSelector.startsWith('data:')) {
    const [attr, val] = cssSelector.slice(5).split('=');
    inner = rawCss.match(new RegExp(`\\[data-${esc(attr)}="?${esc(val ?? '')}"?\\]\\s*:root\\s*\\{([\\s\\S]*?)\\}`))?.[1]
         ?? rawCss.match(new RegExp(`:root\\[data-${esc(attr)}="?${esc(val ?? '')}"?\\]\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
  }
  return parseVarBlock(inner);
}

// buildResolver(rawCss, MODES, { NL, ND, NEUTRAL_MAPS, NEUTRAL_VAR_RE })
//   → { resolve(varName, modeKey) → hex|null,
//       resolveRaw(varName, modeKey) → literal|null,   // hex OR scalar ('8px') OR string ('Inter')
//       rootVars, modeBlocks }
// A var resolves in a mode via that mode's override block, falling back to :root (CSS cascade).
// Neutral primitives resolve through NEUTRAL_MAPS[modeKey] (N-mode) or the legacy NL/ND (2-mode).
export function buildResolver(rawCss, MODES, prims = {}) {
  const { NL = {}, ND = {}, NEUTRAL_MAPS = null, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/ } = prims;
  const rootVars = parseVarBlock(rawCss.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? '');
  const modeBlocks = Object.fromEntries(MODES.map(m => [m.snapshotKey, overrideBlockFor(rawCss, m.cssSelector)]));
  const neutralFor = (key) => (NEUTRAL_MAPS && NEUTRAL_MAPS[key]) || (key === 'light' ? NL : ND);

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
