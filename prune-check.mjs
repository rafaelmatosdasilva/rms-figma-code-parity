// prune-check.mjs - "prune candidates" advisory (I8).
//
// A leaner library is cheaper and less error-prone for an agent to read: everything it carries costs
// context and invites a wrong pick. This surfaces PRUNE CANDIDATES - deprecated tokens still present,
// variant axes that do not actually vary, and components used in exactly one place - so someone can
// decide whether to keep or drop them. Pure over already-emitted artifacts (the contracts, the DTCG
// dictionary, and the usageCounts reach); no new capture. Advisory only, never fails the audit. Every
// candidate is a QUESTION ("still needed?"), never a verdict - the engine surfaces, the human decides.

// Walk a DTCG dictionary collecting the dot-paths of every leaf marked $deprecated: true.
export function collectDeprecatedTokens(dict, prefix = '', out = []) {
  if (!dict || typeof dict !== 'object') return out;
  for (const [k, v] of Object.entries(dict)) {
    if (k.startsWith('$') || !v || typeof v !== 'object') continue;
    // $deprecated is true or (DTCG) a string explaining the deprecation.
    if (v.$value !== undefined) { if (v.$deprecated === true || (typeof v.$deprecated === 'string' && v.$deprecated !== '')) out.push(prefix ? `${prefix}.${k}` : k); }
    else collectDeprecatedTokens(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// Normalize usageCounts' component reach (a Map, or a plain object) to a Map<name, count>.
function reachMap(components) {
  if (components instanceof Map) return components;
  return new Map(Object.entries(components || {}));
}

// built:      [{ name, contract }]  (the emitted per-component contracts)
// usage:      { components: Map|obj }  from contract-gen usageCounts (component -> #parents that compose it)
// tokensDict: the emitted DTCG dictionary (for $deprecated leaves)
// Returns the candidate lists plus `total` (deprecated tokens/components + single-option variants +
// single-use components). Unreferenced components are reported separately and NOT counted - a
// component nobody composes is usually a top-level entry, not dead code.
export function pruneCandidates({ built = [], usage = null, tokensDict = null } = {}) {
  const deprecatedTokens = tokensDict ? collectDeprecatedTokens(tokensDict) : [];

  const singleOptionVariants = [];   // a "variant" prop with exactly one option - an axis that does not vary
  const deprecatedComponents = [];   // a contract marked deprecated (I33 status, or the legacy boolean)
  for (const { name, contract } of built) {
    if (contract?.deprecated === true || contract?.status?.state === 'deprecated') deprecatedComponents.push(name);
    for (const p of (contract?.props || [])) {
      if (p?.type === 'enum' && Array.isArray(p.options) && p.options.length === 1)
        singleOptionVariants.push({ component: name, prop: p.name, option: p.options[0] });
    }
  }

  const reach = reachMap(usage?.components);
  const singleUseComponents = [];    // composed by exactly one parent - candidate to inline
  const unreferencedComponents = []; // composed by nobody - top-level entry OR orphan (confirm)
  for (const { name } of built) {
    const n = reach.get(name) ?? 0;
    if (n === 1) singleUseComponents.push(name);
    else if (n === 0) unreferencedComponents.push(name);
  }

  const total = deprecatedTokens.length + deprecatedComponents.length + singleOptionVariants.length + singleUseComponents.length;
  return { deprecatedTokens, deprecatedComponents, singleOptionVariants, singleUseComponents, unreferencedComponents, total };
}
