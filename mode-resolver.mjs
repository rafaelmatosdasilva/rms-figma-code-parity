// mode-resolver.mjs — shared, N-mode CSS variable resolution for the mode-aware gates
// (Gate [5] mode-completeness, Gate [6] exemption validity, and any future consumer).
//
// A DS is NOT necessarily light/dark. `ds-config.json → figma.modes` may list any number of
// modes (light/dark, plus compact, high-contrast, breakpoint sizes, …), each with a
// `cssSelector` telling us where that mode's overrides live in CSS:
//   'root'                 → :root { }                              (base, no override layer)
//   'dark-media'           → @media (prefers-color-scheme: dark) { :root { } }
//   'high-contrast-media'  → @media (prefers-contrast: more) { :root { } }
//   'class:<name>'         → .<name> :root { }   (or :root.<name> { })
//   'data:<attr>=<val>'    → [data-<attr>="<val>"] :root { }
//
// The 2-mode light/dark case is a strict subset — resolution is byte-identical there. This
// module is the ONE place that hardcodes nothing about a specific DS's modes.

export function loadModes(cfg) {
  if (cfg?.figma?.modes && cfg.figma.modes.length) return cfg.figma.modes;
  // Legacy two-mode fallback (honours figma.lightMode / figma.darkMode overrides).
  return [
    { name: cfg?.figma?.lightMode ?? 'Light', snapshotKey: 'light', cssSelector: 'root' },
    { name: cfg?.figma?.darkMode  ?? 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
  ];
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
  else if (cssSelector.startsWith('class:')) {
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
//   → { resolve(varName, modeKey) → hex|null, rootVars, modeBlocks }
// A var resolves in a mode via that mode's override block, falling back to :root. Neutral
// primitives resolve through NEUTRAL_MAPS[modeKey] (N-mode) or the legacy NL/ND (2-mode).
export function buildResolver(rawCss, MODES, prims = {}) {
  const { NL = {}, ND = {}, NEUTRAL_MAPS = null, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/ } = prims;
  const rootVars = parseVarBlock(rawCss.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? '');
  const modeBlocks = Object.fromEntries(MODES.map(m => [m.snapshotKey, overrideBlockFor(rawCss, m.cssSelector)]));
  const neutralFor = (key) => (NEUTRAL_MAPS && NEUTRAL_MAPS[key]) || (key === 'light' ? NL : ND);
  function resolve(varName, modeKey, depth = 0) {
    if (depth > 8) return null;
    const nm = varName.match(NEUTRAL_VAR_RE);
    if (nm) return neutralFor(modeKey)[nm[1]] ?? null;
    const block = modeBlocks[modeKey];
    const raw = (block && block[varName]) ? block[varName] : rootVars[varName];
    if (!raw) return null;
    const t = raw.trim();
    const v = t.match(/^var\((--.+?)\)$/);
    if (v) return resolve(v[1], modeKey, depth + 1);
    if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t.toLowerCase();
    return null;
  }
  return { resolve, rootVars, modeBlocks };
}
