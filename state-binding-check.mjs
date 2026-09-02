// state-binding-check.mjs - Gate [16]: state selector coverage.
// For every selector declared in CONTRACT.propertyMap, verify a matching CSS rule exists.
// This catches missing hover/selected/disabled/etc. rules - Gate [3] only verifies
// State=Default structure, so state-variant selectors are invisible to it.
//
// Requires at project root:
//   ds-config.json          - themeCSS + pluginCSS paths
//   structure-contract.mjs  - CONTRACT (propertyMap per component)
//
// Exit 0 = all propertyMap selectors found in CSS.  Exit 1 = missing selectors.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const PLUGIN_CSS  = cfg.paths?.pluginCSS ?? [];

let CONTRACT = {};
try {
  const mod = await import(join(ROOT, 'structure-contract.mjs'));
  CONTRACT = mod.CONTRACT ?? {};
} catch {
  console.log('⏭ structure-contract.mjs not found - skipped');
  process.exit(0);
}

if (!Object.keys(CONTRACT).length) {
  console.log('⏭ CONTRACT is empty - skipped');
  process.exit(0);
}

// ── Read and parse CSS ────────────────────────────────────────────────────────
// Plugin CSS paths include .html files (embedded <style> blocks) - read as plain text;
// the flat-rule regex below extracts CSS blocks from the HTML naturally.
const allCSS = [...THEME_PATHS, ...PLUGIN_CSS]
  .filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Build a set of all selectors present in the CSS.
// Uses the same flat-rule regex as buildBlockIndex in structure-check.mjs.
const cssSelectors = new Set();
for (const m of allCSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const raw = m[1].trim().replace(/\s+/g, ' ');
  for (const part of raw.split(',')) {
    const sel = part.trim();
    if (sel && !sel.startsWith('@')) cssSelectors.add(sel);
  }
}

function isCovered(sel) {
  if (!sel || typeof sel !== 'string') return true;
  if (sel.startsWith('@')) return true; // container queries, media - can't easily match
  const norm = sel.replace(/\s+/g, ' ').trim();
  if (cssSelectors.has(norm)) return true;
  for (const cssEl of cssSelectors) {
    // Multi-selector rule: ".a, .b { }" - check comma-split parts
    if (cssEl.split(',').map(s => s.trim()).includes(norm)) return true;
    // Compound/child selector: propertyMap selector is a PREFIX of a CSS rule's selector.
    // e.g. ".depth-option.done" is covered by ".depth-option.done .depth-circle"
    if (cssEl.startsWith(norm + ' ') || cssEl.startsWith(norm + ':') || cssEl.startsWith(norm + '.')) return true;
  }
  return false;
}

// ── Walk propertyMap entries ──────────────────────────────────────────────────
const missing = [];
const covered = [];

for (const [compName, def] of Object.entries(CONTRACT)) {
  if (!def.propertyMap) continue;
  for (const [propKey, propVal] of Object.entries(def.propertyMap)) {
    if (propVal === null) continue; // TEXT / INSTANCE_SWAP - skip

    if (typeof propVal === 'string') {
      const key = `${compName}.${propKey}`;
      if (isCovered(propVal)) covered.push(key);
      else missing.push({ key, selector: propVal });
    } else if (typeof propVal === 'object') {
      for (const [stateName, stateSel] of Object.entries(propVal)) {
        if (!stateSel) continue;
        const key = `${compName}.${propKey}.${stateName}`;
        if (isCovered(stateSel)) covered.push(key);
        else missing.push({ key, selector: stateSel });
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const nCovered = covered.length;
const nMissing = missing.length;

console.log(`\n✅ COVERED  ${nCovered}  propertyMap selectors present in CSS`);
console.log(`❌ MISSING  ${nMissing}  propertyMap selectors not found in CSS`);

if (nMissing > 0) {
  console.log('\n─── Missing CSS selectors (every Figma state variant needs a CSS rule) ──');
  for (const m of missing) {
    console.log(`  🚨 ${m.key}  →  ${m.selector}`);
  }
  console.log('');
  process.exit(1);
}

console.log('\nAll propertyMap selectors covered in CSS. ✓\n');
process.exit(0);
