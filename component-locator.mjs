// component-locator.mjs - the ONE answer to "which elements are DS component X".
//
// Eight places used to answer this on their own, in five different ways: some read
// ds-config.json → componentSelectors, some the contract's COMPONENT_CSS_SELECTORS, some only
// the naming convention, and one did not lowercase the first letter at all. The same component
// could resolve to `.checkBox` in one gate and `.checkbox` in another. Every gate now asks here.
//
// Resolution order (first answer wins):
//   1. ds-config.json → componentSelectors[name]                 (explicit project config)
//   2. structure-contract.mjs → COMPONENT_CSS_SELECTORS[name].main (the contract's selector map)
//   3. a name that already is a selector (".x", "#x", "[x]")      (used as-is)
//   4. the naming convention: ComponentName → .componentName
//
// Pure: no I/O unless you call loadLocator(), which imports structure-contract.mjs once.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const lcFirst = (name) => String(name).charAt(0).toLowerCase() + String(name).slice(1);

// The first class or id token of a selector (".segmented-control button" → ".segmented-control").
export function leadingToken(selector) {
  return String(selector ?? '').match(/[.#][\w-]+/)?.[0] ?? null;
}

// createLocator(cfg, { contractSelectors }) → { selectorFor, classFor, sourceOf, names }
export function createLocator(cfg = {}, { contractSelectors = {} } = {}) {
  const configured = cfg?.componentSelectors ?? {};
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

  function resolveOne(name) {
    if (has(configured, name) && configured[name]) return { selector: String(configured[name]), source: 'componentSelectors' };
    const main = has(contractSelectors, name) ? contractSelectors[name]?.main : null;
    if (main) return { selector: String(main), source: 'contract' };
    if (/^[.#[]/.test(String(name))) return { selector: String(name), source: 'selector' };
    return { selector: '.' + lcFirst(name), source: 'convention' };
  }

  return {
    // The full selector for the component (may be compound, e.g. ".segmented-control button").
    selectorFor: (name) => resolveOne(name).selector,
    // Its leading class or id (".segmented-control"), for "is this component on the element" checks.
    classFor: (name) => leadingToken(resolveOne(name).selector) ?? resolveOne(name).selector,
    // Which rule answered: componentSelectors | contract | selector | convention.
    sourceOf: (name) => resolveOne(name).source,
    // Every component this locator was told about explicitly.
    names: () => [...new Set([...Object.keys(configured), ...Object.keys(contractSelectors)])],
  };
}

// Load COMPONENT_CSS_SELECTORS from the project's structure-contract.mjs (optional) and build
// the locator. Never throws: a missing or broken contract just means steps 1, 3 and 4 answer.
export async function loadLocator(ROOT, cfg = {}) {
  let contractSelectors = {};
  const p = resolve(ROOT, cfg?.paths?.structureContract ?? 'structure-contract.mjs');
  if (existsSync(p)) {
    try { contractSelectors = (await import(pathToFileURL(p).href)).COMPONENT_CSS_SELECTORS ?? {}; } catch { /* optional */ }
  }
  return createLocator(cfg, { contractSelectors });
}
