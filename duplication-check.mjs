// duplication-check.mjs - single-source-of-truth / list-duplication advisory (I21).
//
// A DS list - component names, token names - copied by hand into an agent-instruction file, a skill,
// or a doc will drift into a stale parallel truth the moment the DS changes, and a stale list is
// exactly what makes an agent hallucinate ("the docs say these 8 components exist"). The engine
// already generates the authoritative index (llms.txt + contracts); this surfaces HAND-MAINTAINED
// surfaces that restate a CLUSTER of DS names, so they can point at the generated index instead of
// keeping a copy. Mechanical, advisory, never fails.
//
// Opt-in and generic: runs only on surfaces the project DECLARES as hand-maintained
//   ds-config.json → "duplication": { "surfaces": ["AGENTS.md", ".cursorrules", …], "minCluster": 5 }
// Generated surfaces (the styleguide, llms.txt) are NOT listed here - listing all components is their
// job. Pure + testable.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The subset of `names` that appear in `text` as a whole token. `/` and `-` count as part of a name,
// so "radii/button" matches exactly and never inside "radii/buttonLarge" or "myButtonPrimary".
export function findNameMentions(text, names) {
  if (typeof text !== 'string' || !Array.isArray(names)) return [];
  const found = [];
  for (const n of names) {
    if (!n) continue;
    const re = new RegExp(`(?<![\\w/-])${escapeRe(n)}(?![\\w/-])`);
    if (re.test(text)) found.push(n);
  }
  return found;
}

// surfaces: [{ name, text }] (hand-maintained files). componentNames / tokenNames: the generated DS
// truth. A surface that restates >= minCluster names of a kind is flagged as a copied list (a passing
// mention of one or two names is not). Returns per-surface findings plus `parallel` - a kind restated
// across >=2 surfaces (the strongest "parallel truths that will diverge" signal).
export function duplicationFindings({ surfaces = [], componentNames = [], tokenNames = [], minCluster = 5 } = {}) {
  const comps = [...new Set((componentNames || []).filter(Boolean))];
  const toks  = [...new Set((tokenNames || []).filter(Boolean))];
  const findings = [];
  for (const s of (surfaces || [])) {
    if (!s || typeof s.text !== 'string') continue;
    const mc = findNameMentions(s.text, comps);
    const mt = findNameMentions(s.text, toks);
    if (mc.length >= minCluster) findings.push({ surface: s.name, kind: 'components', matched: mc, count: mc.length, total: comps.length });
    if (mt.length >= minCluster) findings.push({ surface: s.name, kind: 'tokens',     matched: mt, count: mt.length, total: toks.length });
  }
  const bykind = {};
  for (const f of findings) (bykind[f.kind] ??= new Set()).add(f.surface);
  const parallel = Object.entries(bykind)
    .filter(([, set]) => set.size >= 2)
    .map(([kind, set]) => ({ kind, surfaces: [...set] }));
  return { findings, parallel };
}
