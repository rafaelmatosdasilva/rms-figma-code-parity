// naming-convention.mjs — the ONE place that maps a Figma token path ⇄ a CSS custom-property name.
//
// Every DS may name its tokens and its CSS vars differently, so the mapping is NOT hardcoded: each
// project declares its own convention in `ds-config.json → figma.namingConvention`, and this module
// applies it. Zero-config reproduces the historical behaviour EXACTLY (no regression). No DS shape is
// imposed — this honours the No-imposed-structure principle. It replaces ~6 duplicated inline copies
// of the convention that previously lived (and drifted) across the gate scripts, and that baked one
// DS's quirks (`iconText`→`text`, drop `/default`) into the engine.
//
//   figma.namingConvention: {
//     prefix?:       "--",                 // CSS custom-property prefix
//     separator?:    "-",                  // what joins the token path segments in the CSS var
//     dropSegments?: ["color", "default"], // trailing path segments dropped before mapping
//     aliases?:      { iconText: "text" }, // per-segment renames (Figma segment → CSS segment)
//     iconTextAlias?: true,                // legacy shorthand: false removes the iconText→text alias
//     case?:         "preserve"            // per-segment case: "preserve" | "kebab"
//                                          //   "kebab" splits camelCase (selectedHover → selected-hover),
//                                          //   so a DS that flattens combined states in code can match.
//   }
//
// `dropSegments` and `iconTextAlias` are the SAME keys parity-check.mjs already reads — this module is
// the one place every other gate now shares, so the schema stays single. Importing this runs nothing.

export const DEFAULT_NAMING = {
  prefix: '--',
  separator: '-',
  dropSegments: ['color', 'default'],
  aliases: { iconText: 'text' },
  case: 'preserve',
};

// Build the effective spec from ds-config, honouring the legacy `iconTextAlias` boolean.
export function resolveNamingSpec(cfg = {}) {
  const nc = (cfg && cfg.figma && cfg.figma.namingConvention) || {};
  const aliases = { ...(nc.aliases ?? DEFAULT_NAMING.aliases) };
  if (nc.iconTextAlias === false) delete aliases.iconText;
  return {
    prefix:       nc.prefix       ?? DEFAULT_NAMING.prefix,
    separator:    nc.separator    ?? DEFAULT_NAMING.separator,
    dropSegments: nc.dropSegments ?? DEFAULT_NAMING.dropSegments,
    aliases,
    case:         nc.case         ?? DEFAULT_NAMING.case,
  };
}

// selectedHover → "selected<sep>hover" (lowercased). Only splits a lower/digit→Upper boundary,
// so an already-kebab or single-word segment is unchanged.
function applyCase(seg, mode, sep) {
  if (mode === 'kebab') return seg.replace(/([a-z0-9])([A-Z])/g, `$1${sep}$2`).toLowerCase();
  return seg;
}

// Map a Figma token PATH ("node/border/selected/color") to a CSS var ("--node-border-selected").
// `raw:true` skips dropSegments + aliases + case — the purely structural form (effect/motion style
// names): just prefix + segments joined by the separator.
export function tokenToVar(token, spec = DEFAULT_NAMING, { raw = false } = {}) {
  let segs = String(token).split('/');
  if (!raw) {
    while (segs.length > 1 && spec.dropSegments.includes(segs[segs.length - 1])) segs.pop();
    segs = segs.map((s) => spec.aliases[s] ?? s);
    segs = segs.map((s) => applyCase(s, spec.case, spec.separator));
  }
  return spec.prefix + segs.join(spec.separator);
}

// Best-effort reverse: a CSS var ("--node-border-selected") back to a token path
// ("node/border/selected"). Used by the CSS→Figma round-trip (naming gate).
export function varToToken(cssVar, spec = DEFAULT_NAMING) {
  const body = cssVar.startsWith(spec.prefix) ? cssVar.slice(spec.prefix.length) : cssVar.replace(/^--/, '');
  return body.split(spec.separator).join('/');
}
