// eval-check.mjs - DS-conformance core for evals (I7).
//
// Given a candidate code blob an agent PRODUCED (an HTML / JSX / Vue snippet) and the DS context,
// flag the mechanical DS violations - the same failure modes the gates catch, but applied to
// GENERATED output instead of the repo:
//   • raw color / dimension literals that should be a DS token/var,
//   • var(--x) where --x is not a known DS var (invented),
//   • (metric) how many DS component classes the candidate actually used.
// Pure, framework-light and deterministic, so it is unit-testable without a network or a live agent.
// The eval runner and the live-agent generation adapter build on top of this (see the evals spec).
//
// It re-implements a light version of the gate-6/gate-7 checks here (those live inline in the repo
// audit and are not yet exported); a later refactor can share one implementation.

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_HSL = /\b(?:rgb|hsl)a?\([^)]*\)/gi;
const DIMENSION = /\b\d+(?:\.\d+)?(?:px|rem|em)\b/g;
const VAR_USE = /var\(\s*(--[a-zA-Z][\w-]*)/g;
const INLINE_STYLE = /\bstyle\s*=\s*["'{]/gi;   // style="…" (HTML) or style={…} (JSX): a hardcoded-styling smell

// Zero-length dimensions are fine unitless, and a bare "0px" carries no design decision.
const isBenignDim = (d) => /^0(?:px|rem|em)$/.test(d);

/**
 * @param {string} code   candidate output (html/jsx/vue/css blob)
 * @param {{cssVars?: Set<string>|string[], dsClasses?: Set<string>|string[]}} ctx
 * @returns {{violations: Array<{type:string,value:string}>, metrics: object}}
 */
export function evalConformance(code, ctx = {}) {
  const src = String(code || '');
  const cssVars = ctx.cssVars instanceof Set ? ctx.cssVars : new Set(ctx.cssVars || []);
  const dsClasses = ctx.dsClasses instanceof Set ? ctx.dsClasses : new Set(ctx.dsClasses || []);

  // Strip whole var(...) expressions first, so a fallback literal inside a var() - e.g.
  // var(--x, #fff) - is NOT counted as a raw literal (the code correctly went through a token).
  const scan = src.replace(/var\([^)]*\)/g, ' ');

  const rawColors = [...(scan.match(HEX) || []), ...(scan.match(RGB_HSL) || [])];
  const rawDims = (scan.match(DIMENSION) || []).filter((d) => !isBenignDim(d));

  const usedVars = [...src.matchAll(VAR_USE)].map((m) => m[1]);
  // Only judge var provenance when we actually know the DS var universe.
  const inventedVars = cssVars.size ? [...new Set(usedVars.filter((v) => !cssVars.has(v)))] : [];

  const usedDsClasses = [...dsClasses].filter((raw) => {
    const name = String(raw).replace(/^\./, '');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the class token appears as a whole word (in a class/className attribute or a selector)
    return new RegExp(`(?:^|[^\\w-])${esc}(?![\\w-])`).test(src);
  });

  const violations = [];
  for (const c of rawColors) violations.push({ type: 'raw-color', value: c });
  for (const d of rawDims) violations.push({ type: 'raw-dimension', value: d });
  for (const v of inventedVars) violations.push({ type: 'invented-var', value: v });

  return {
    violations,
    metrics: {
      produced: src.trim().length > 0,
      clean: src.trim().length > 0 && violations.length === 0,   // "zero-fix": produced AND needs no correction
      rawColors: rawColors.length,
      rawDimensions: rawDims.length,
      inventedVars: inventedVars.length,
      dsClassesUsed: usedDsClasses.length,
      inlineStyles: (src.match(INLINE_STYLE) || []).length,   // metric (S16): fewer is better
    },
  };
}
