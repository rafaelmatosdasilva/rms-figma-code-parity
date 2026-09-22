// brand-check.mjs - multi-brand token coverage (I6).
//
// Opt-in and project-declared (never imposed): runs only when ds-config.json declares which snapshot
// modes are brands — "brands": ["brandA","brandB", …] (keys in figma-vars.snapshot.json → color). For a
// multi-brand DS (like INNOVA), every brand should define the SAME set of semantic tokens; a token that
// exists in some brands but is MISSING in others is a coverage hole (an agent building for the missing
// brand has no token to use). Advisory - it surfaces the holes; it never fails. Pure + testable.

// Decide which snapshot keys are BRANDS, plan-agnostically and without imposing. Priority:
//   1. cfg.brands declared (you always win),
//   2. a captured collections manifest (snapshot.collections) with a collection MARKED as brand
//      (role:'brand' or a brand-ish name) that has >=2 modes — the Enterprise/extended-collections
//      enhancement, read as DATA the capture recorded (never a plan-gated API call here),
//   3. otherwise none, plus a SUGGESTION of candidate mode sets so the run can nudge "declare these".
// The capture records `collections: [{ name, modes:[key…], role?, remote?, extends? }]` when it can see
// it (any plan records what it can); absent → this simply falls back to declared/none. Never guesses a
// brand from bare modes (modes may be theme/density/locale), which is why classification stays declared.
export function resolveBrands(cfg, snapshot) {
  const declared = Array.isArray(cfg?.brands) ? cfg.brands.filter((b) => typeof b === 'string') : [];
  if (declared.length >= 2) return { brands: declared, source: 'declared', suggest: [] };

  const cols = Array.isArray(snapshot?.collections) ? snapshot.collections : [];
  const branded = cols.find((c) => c && Array.isArray(c.modes) && c.modes.length >= 2
    && (c.role === 'brand' || /brand/i.test(String(c.name || ''))));
  if (branded) return { brands: branded.modes.filter((m) => typeof m === 'string'), source: `collection:${branded.name}`, suggest: [] };

  const suggest = cols.filter((c) => c && Array.isArray(c.modes) && c.modes.length >= 2)
    .map((c) => ({ name: c.name || '(unnamed collection)', modes: c.modes }));
  return { brands: null, source: 'none', suggest };
}

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
