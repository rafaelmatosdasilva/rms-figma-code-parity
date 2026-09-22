// tier-check.mjs - project-DECLARED token-tier validation (I10b).
//
// The North star forbids IMPOSING a tier model (primitive/semantic/component): DSes tier differently,
// or not at all. So this runs ONLY when a project declares its own tiers in ds-config.json, and the
// rules come entirely from that declaration:
//   "tiers": [
//     { "name": "primitive", "match": "^primitives/" },
//     { "name": "semantic",  "match": "^semantic/",  "mayReference": ["primitive"] },
//     { "name": "component", "match": ".",           "mayReference": ["semantic", "primitive"] }
//   ]
// `match` is a regex on the token path (first matching tier wins, so a catch-all goes LAST).
// `mayReference` (optional) lists the tiers a token in this tier is allowed to alias. A token that
// aliases a token in a tier NOT on that list is a cross-tier violation. Advisory - the engine surfaces
// it; it never imposes and (by default) never fails.

// First matching tier, or null. A bad regex is skipped (never throws).
export function classifyTier(tokenPath, tiers) {
  for (const t of tiers || []) {
    if (!t || !t.name || t.match == null) continue;
    try { if (new RegExp(t.match).test(tokenPath)) return t.name; } catch { /* bad regex → skip */ }
  }
  return null;
}

// tokens: array of token paths. aliasesOf(token): array of the token paths it references (immediate).
// Returns { violations: [{token, tier, ref, refTier, reason}], classified: {tierName: count} }.
export function checkTiers(tokens, aliasesOf, tiers) {
  const byName = new Map((tiers || []).map((t) => [t.name, t]));
  const violations = [];
  const classified = {};
  for (const tok of tokens || []) {
    const tier = classifyTier(tok, tiers);
    if (!tier) continue;
    classified[tier] = (classified[tier] || 0) + 1;
    const rule = byName.get(tier);
    if (!rule || !Array.isArray(rule.mayReference)) continue;   // this tier declares no reference rule
    for (const ref of (aliasesOf(tok) || [])) {
      const refTier = classifyTier(ref, tiers);
      if (refTier && !rule.mayReference.includes(refTier)) {
        violations.push({
          token: tok, tier, ref, refTier,
          reason: `a ${tier} token references a ${refTier} token; ${tier} may reference [${rule.mayReference.join(', ')}]`,
        });
      }
    }
  }
  return { violations, classified };
}
