// coverage-check.mjs — Gate [18]: coverage meta-gate.
// Every other gate answers "does the code match the DS *where we look*?" This one answers
// the meta-question: "what are we NOT looking at?" It cross-references the DS components in
// the structure snapshot against the checks the contract actually declares, and reports the
// blind spots — a DS component with no contract, no rendered assertion, no base-var binding,
// or an uncaptured state. It's how a newly-added DS component or state stops being invisible.
//
// Advisory by default: it reports a coverage matrix and never blocks. A component with ZERO
// coverage (present in the DS snapshot but modelled by nothing, and not in
// knownUnimplementedComponents) is a hard gap → fails only under ds-config coverageStrict:true.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const SNAP_STRUCT = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';
let components = {};
try { components = JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8')).components ?? {}; }
catch { console.log('⏭  [18] coverage skipped — structure snapshot not found'); process.exit(0); }

let CONTRACT = {}, SELECTORS = {}, RENDERED = [], BASE_VARS = [], CROSS = [], FRAME_MAP = [], PROP_ASSERT = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  CONTRACT   = m.CONTRACT ?? {};
  SELECTORS  = m.COMPONENT_CSS_SELECTORS ?? {};
  RENDERED   = m.RENDERED_ASSERTIONS ?? [];
  BASE_VARS  = m.CSS_BASE_RULE_VARS ?? [];
  CROSS      = m.CROSS_PLUGIN_CONSISTENCY ?? [];
  FRAME_MAP  = m.FRAME_GEOMETRY_MAP ?? [];
  PROP_ASSERT = m.CSS_PROPERTY_ASSERTIONS ?? [];
} catch { /* optional */ }

const UNIMPL = new Set(cfg.knownUnimplementedComponents ?? []);

// A component's CSS class = its main selector's leading class, else `.<name>`.
function classOf(comp) {
  const sel = SELECTORS[comp]?.main;
  return sel?.match(/\.[a-zA-Z][\w-]*/)?.[0] ?? `.${comp}`;
}
// Does any entry's selector reference this component's class?
const refsClass = (entries, keyer, cls) => entries.some(e => (keyer(e) ?? '').includes(cls));

const rows = [];
for (const [comp, snap] of Object.entries(components)) {
  const cls = classOf(comp);
  const dims = {
    contract:  !!CONTRACT[comp],
    selector:  !!SELECTORS[comp],
    rendered:  refsClass(RENDERED, e => e.selector, cls) || refsClass(FRAME_MAP, e => e.selector, cls) || CROSS.some(e => (e.selector ?? '').includes(cls)),
    baseVars:  refsClass(BASE_VARS, e => e.selector, cls) || refsClass(PROP_ASSERT, e => e.selector, cls),
    // multi-variant capture present → sibling states are visible to the audit
    variants:  !!snap.variantStroke || !!snap.variantHeight,
    crossPlugin: CROSS.some(e => (e.selector ?? '').includes(cls)),
  };
  const score = ['contract', 'selector', 'rendered', 'baseVars', 'variants'].filter(k => dims[k]).length;
  rows.push({ comp, cls, dims, score, unimpl: UNIMPL.has(comp) });
}

// ── Report ────────────────────────────────────────────────────────────────────
const yn = b => (b ? '✓' : '·');
const gaps = rows.filter(r => !r.unimpl && r.score === 0);            // modelled by nothing
const noRendered = rows.filter(r => !r.unimpl && r.dims.contract && !r.dims.rendered); // static-only
const noVariants = rows.filter(r => !r.unimpl && r.dims.contract && !r.dims.variants); // single-variant blind

console.log('\n─── Gate [18] — audit coverage matrix (what is / isn\'t checked) ───');
console.log('   component            contract selector rendered base-var variants');
for (const r of rows.sort((a, b) => a.score - b.score)) {
  const d = r.dims;
  console.log(`   ${r.comp.padEnd(20)}   ${yn(d.contract)}       ${yn(d.selector)}       ${yn(d.rendered)}       ${yn(d.baseVars)}       ${yn(d.variants)}${r.unimpl ? '   (unimplemented)' : ''}`);
}
const covered = rows.filter(r => !r.unimpl && r.score > 0).length;
const total = rows.filter(r => !r.unimpl).length;
console.log(`\n✅ MODELLED   ${covered}/${total} DS components have at least one check`);
console.log(`ℹ️  NO RENDERED ${noRendered.length}  (geometry/color only checked statically — no browser assertion)`);
console.log(`ℹ️  SINGLE-VARIANT ${noVariants.length}  (no per-variant capture — sibling states invisible to the audit)`);
if (noRendered.length) console.log(`     → ${noRendered.map(r => r.comp).join(', ')}`);
if (noVariants.length) console.log(`     → ${noVariants.map(r => r.comp).join(', ')}`);

if (gaps.length) {
  const strict = cfg.coverageStrict === true;
  console.log(`\n${strict ? '❌' : '⚠️ '} UNCHECKED (${gaps.length}) — DS component modelled by NOTHING (no contract, selector, or assertion):`);
  for (const r of gaps) console.log(`  ${strict ? '❌' : '⚠️ '} ${r.comp}`);
  console.log('   Add a CONTRACT entry (+ selector/assertions), or list it in ds-config knownUnimplementedComponents.');
  console.log('');
  process.exit(strict ? 1 : 0);
}
console.log('\nEvery DS component is modelled by at least one check. ✓\n');
process.exit(0);
