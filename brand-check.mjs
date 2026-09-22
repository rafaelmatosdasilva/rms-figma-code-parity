// brand-check.mjs - multi-brand token coverage (I6).
//
// Opt-in and project-declared (never imposed): runs only when ds-config.json declares which snapshot
// modes are brands — "brands": ["brandA","brandB", …] (keys in figma-vars.snapshot.json → color). For a
// multi-brand DS (like INNOVA), every brand should define the SAME set of semantic tokens; a token that
// exists in some brands but is MISSING in others is a coverage hole (an agent building for the missing
// brand has no token to use). Advisory - it surfaces the holes; it never fails. Pure + testable.

// colorByBrand: { brandKey: Set<tokenKey> | tokenKey[] }. Returns the shared universe + the tokens that
// are present in some brands but missing in others (a token absent from EVERY brand isn't a hole; a
// token in ALL brands is fine).
export function brandCoverage(colorByBrand) {
  const brands = Object.keys(colorByBrand || {});
  const setOf = (b) => (colorByBrand[b] instanceof Set ? colorByBrand[b] : new Set(colorByBrand[b] || []));
  const universe = new Set();
  for (const b of brands) for (const t of setOf(b)) universe.add(t);
  const missing = {};   // token -> [brands missing it]
  for (const t of universe) {
    const absent = brands.filter((b) => !setOf(b).has(t));
    if (absent.length && absent.length < brands.length) missing[t] = absent;   // in some, not all
  }
  return { brands, tokenUniverse: universe.size, missing };
}
