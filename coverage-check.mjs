// coverage-check.mjs - Gate [18]: coverage meta-gate.
// Every other gate answers "does the code match the DS *where we look*?" This one answers
// the meta-question: "what are we NOT looking at?" It cross-references the DS components in
// the structure snapshot against the checks the contract actually declares, and reports the
// blind spots - a DS component with no contract, no rendered assertion, no base-var binding,
// or an uncaptured state. It's how a newly-added DS component or state stops being invisible.
//
// Advisory by default: it reports a coverage matrix and never blocks. A component with ZERO
// coverage (present in the DS snapshot but modelled by nothing, and not in
// knownUnimplementedComponents) is a hard gap → fails only under ds-config coverageStrict:true.

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadModes } from './mode-resolver.mjs';
import { createLocator } from './component-locator.mjs';
import { existsSync } from 'fs';
import { readFreshSnapshot, nestingLabel } from './code-capture.mjs';
import { pathToFileURL } from 'url';
import { inProgressNames, inProgressList, sideLabel } from './in-progress.mjs';   // I52: work in progress is not drift

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const SNAP_STRUCT = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';
let components = {};
try { components = JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8')).components ?? {}; }
catch { console.log('⏭  [18] coverage skipped - structure snapshot not found'); process.exit(0); }

let CONTRACT = {}, SELECTORS = {}, RENDERED = [], BASE_VARS = [], CROSS = [], FRAME_MAP = [], PROP_ASSERT = [];
try {
  const m = await import(pathToFileURL(join(ROOT, 'structure-contract.mjs')).href);
  CONTRACT   = m.CONTRACT ?? {};
  SELECTORS  = m.COMPONENT_CSS_SELECTORS ?? {};
  RENDERED   = m.RENDERED_ASSERTIONS ?? [];
  BASE_VARS  = m.CSS_BASE_RULE_VARS ?? [];
  CROSS      = m.CROSS_PLUGIN_CONSISTENCY ?? [];
  FRAME_MAP  = m.FRAME_GEOMETRY_MAP ?? [];
  PROP_ASSERT = m.CSS_PROPERTY_ASSERTIONS ?? [];
} catch { /* optional */ }

const UNIMPL = await inProgressNames(ROOT, cfg);

// A component's CSS class, from the one shared component finder (component-locator.mjs).
const LOCATOR = createLocator(cfg, { contractSelectors: SELECTORS });
const classOf = (comp) => LOCATOR.classFor(comp);
// Does any entry's selector reference this component's class?
const refsClass = (entries, keyer, cls) => entries.some(e => (keyer(e) ?? '').includes(cls));

// A component "paints a background" when its DS fill sits on the frame ('direct') or a
// Background child ('before'); such a background can be wrong or MISSING in code without any
// token gate noticing (transparent is not a wrong token, it is a missing paint). The only guard
// is a rendered backgroundColor assertion — so a filled component with none is an unverified fill.
// 'direct' = the element itself is a filled surface (container / overlay / sticky header) — a
// missing or transparent paint here lets whatever sits behind bleed through, and no token gate
// sees it. ('before' fills sit on a ::before / Background child, so backgroundColor on the element
// is legitimately transparent and the fill's VALUE is already covered by Gate [3] — not this class.)
const paintsBackground = (snap) => snap.fillStructure === 'direct';
const hasBgAssertion = (cls) => RENDERED.some(e =>
  (e.selector ?? '').includes(cls) && /^background(Color)?$/i.test(e.prop ?? ''));

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
    // a filled/slotted container whose background is verified in the browser (both modes covered by the mode gate)
    fillPainted: paintsBackground(snap),
    fillChecked: !paintsBackground(snap) || hasBgAssertion(cls),
  };
  const score = ['contract', 'selector', 'rendered', 'baseVars', 'variants'].filter(k => dims[k]).length;
  rows.push({ comp, cls, dims, score, unimpl: UNIMPL.has(comp) });
}
// Filled/slotted containers whose background nothing render-verifies — the class that shipped the
// panel/header "content bleeds through the transparent slot" bugs. Bounded to components that
// actually paint a background, so it is exhaustive without being a noisy every-node pixel diff.
const FILL_EXEMPT = new Set(cfg.knownUnverifiedFills ?? []);
const unverifiedFills = rows.filter(r => !r.unimpl && r.dims.fillPainted && !r.dims.fillChecked && !FILL_EXEMPT.has(r.comp));

// ── Report ────────────────────────────────────────────────────────────────────
const yn = b => (b ? '✓' : '·');
const gaps = rows.filter(r => !r.unimpl && r.score === 0);            // modelled by nothing
const noRendered = rows.filter(r => !r.unimpl && r.dims.contract && !r.dims.rendered); // static-only
const noVariants = rows.filter(r => !r.unimpl && r.dims.contract && !r.dims.variants); // single-variant blind

console.log('\n─── Gate [18] - audit coverage matrix (what is / isn\'t checked) ───');
console.log('   component            contract selector rendered base-var variants');
for (const r of rows.sort((a, b) => a.score - b.score)) {
  const d = r.dims;
  console.log(`   ${r.comp.padEnd(20)}   ${yn(d.contract)}       ${yn(d.selector)}       ${yn(d.rendered)}       ${yn(d.baseVars)}       ${yn(d.variants)}${r.unimpl ? '   (unimplemented)' : ''}`);
}
// ── Mode coverage of rendered assertions ──────────────────────────────────────
// A RENDERED_ASSERTIONS entry pins ONE colorScheme, so it guards one mode only. When
// the token behind it resolves differently per mode (an alias can point at a different
// primitive in each), the unasserted mode is unguarded and drifts silently - a real
// case: node/icon/hover was asserted in dark only, and its light value sat on a stale
// alias for a week. Generic: the mode list comes from the snapshot, never hardcoded.
let SNAP_MODES = [];
try {
  const snapVars = JSON.parse(readFileSync(join(ROOT, cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json'), 'utf8'));
  SNAP_MODES = Object.keys(snapVars.color ?? {});
} catch { /* no snapshot → skip this dimension */ }

const assertKey = a => [a.plugin ?? '', a.selector ?? '', a.prop ?? '',
  (a.forcePseudo ?? []).join('+'), a.forcePseudoOn ?? ''].join(' | ');
// An assertion's colorScheme may be a mode NAME or snapshotKey, in any case; map it to the
// snapshot's mode key space so labels that differ only by name/case aren't read as blind spots.
const _modeAlias = new Map();
for (const md of loadModes(cfg)) { _modeAlias.set(String(md.snapshotKey).toLowerCase(), md.snapshotKey); _modeAlias.set(String(md.name).toLowerCase(), md.snapshotKey); }
const _toModeKey = (cs) => _modeAlias.get(String(cs).toLowerCase()) ?? String(cs).toLowerCase();
const modesByAssert = new Map();
for (const a of RENDERED) {
  if (!a.colorScheme) continue; // mode-agnostic assertion - nothing to pair
  if (!modesByAssert.has(assertKey(a))) modesByAssert.set(assertKey(a), new Set());
  modesByAssert.get(assertKey(a)).add(_toModeKey(a.colorScheme));
}
const modeBlind = SNAP_MODES.length > 1
  ? [...modesByAssert.entries()]
      .map(([k, seen]) => ({ k, missing: SNAP_MODES.filter(m => !seen.has(m)) }))
      .filter(x => x.missing.length)
  : [];

const covered = rows.filter(r => !r.unimpl && r.score > 0).length;
const total = rows.filter(r => !r.unimpl).length;
console.log(`\n✅ MODELLED   ${covered}/${total} DS components have at least one check`);
console.log(`ℹ️  NO RENDERED ${noRendered.length}  (geometry/color only checked statically - no browser assertion)`);
console.log(`ℹ️  SINGLE-VARIANT ${noVariants.length}  (no per-variant capture - sibling states invisible to the audit)`);
if (noRendered.length) console.log(`     → ${noRendered.map(r => r.comp).join(', ')}`);
if (noVariants.length) console.log(`     → ${noVariants.map(r => r.comp).join(', ')}`);

// ── Code capture coverage ─────────────────────────────────────────────────────
// What the code capture (code.snapshot.json) could read this run, and how sure it is. Advisory.
{
  const cap = await readFreshSnapshot(ROOT, cfg).catch(() => null);
  if (!cap) {
    const saved = existsSync(join(ROOT, cfg.codeReading?.out ?? '.parity-out/code.snapshot.json'));
    console.log(`ℹ️  CODE CAPTURE ${saved ? 'out of date (the code changed since it ran)' : 'not run'}  - gates use their own readings only`);
  } else {
    const c = cap._coverage ?? {}, b = c.byConfidence ?? {}, cc = c.components ?? {}, ap = c.api;
    const parts = [
      `tokens ${c.tokens ?? 0} (${b.verified ?? 0} verified · ${b.uncertain ?? 0} uncertain)`,
      cc.known != null ? `components ${cc.captured}/${cc.known} measured` : null,
      cc.states?.listed ? `states ${cc.states.produced}/${cc.states.listed}` : null,
      ap && !ap.note ? `props ${ap.props.total} on ${ap.components} component(s) (${ap.props.uncertain} uncertain)` : null,
      c.icons ? `icons ${c.icons.symbols}` : null,
      c.nesting ? `nesting ${c.nesting.components} (${nestingLabel(c.nesting)})` : null,
    ].filter(Boolean);
    console.log(`ℹ️  CODE CAPTURE ${parts.join(' · ')}  - read by ${cap._sources?.browser ? 'browser + static CSS' : 'static CSS only'}`);
    if (cc.missing?.length) console.log(`     → not measured: ${cc.missing.join(', ')}`);
    const sgc = c.styleguide;
    if (sgc?.built) console.log(`ℹ️  CODE CAPTURE styleguide built from ${sgc.template} and measured first`);
    else if (sgc?.note) console.log(`⚠️  CODE CAPTURE ${sgc.note}`);
    const unsure = Object.entries(cap.tokens ?? {}).filter(([, tk]) => Object.values(tk.modes ?? {}).some((f) => f.confidence === 'uncertain')).map(([n]) => n);
    if (unsure.length) console.log(`     → couldn't read reliably (browser and CSS disagree): ${unsure.slice(0, 12).join(', ')}${unsure.length > 12 ? ` … +${unsure.length - 12}` : ''}`);
  }
}

const modeStrict = cfg.renderedModeStrict === true;
if (SNAP_MODES.length > 1) {
  if (modeBlind.length) {
    console.log(`\n${modeStrict ? '❌' : 'ℹ️ '} MODE-BLIND ${modeBlind.length}  (rendered assertion covers some modes, not all of ${SNAP_MODES.join('/')})`);
    for (const x of modeBlind) console.log(`     → ${x.k}   missing: ${x.missing.join(', ')}`);
    console.log('   If the token behind it resolves per mode, the missing mode is unguarded - add the sibling assertion.');
  } else {
    console.log(`✅ MODE COVERAGE  every mode-pinned rendered assertion covers all ${SNAP_MODES.length} modes (${SNAP_MODES.join('/')})`);
  }
}

const fillStrict = cfg.fillCoverageStrict === true;
if (unverifiedFills.length) {
  console.log(`\n${fillStrict ? '❌' : 'ℹ️ '} UNVERIFIED FILL ${unverifiedFills.length}  (paints a background, but no rendered backgroundColor assertion — a missing/transparent fill would ship unseen)`);
  for (const r of unverifiedFills) console.log(`     ${fillStrict ? '❌' : 'ℹ️ '} ${r.comp} (${r.cls})  fillStructure=${components[r.comp].fillStructure}`);
  console.log('   Add a RENDERED_ASSERTIONS { selector, prop:\'backgroundColor\', expected, colorScheme } (both modes), or list it in ds-config knownUnverifiedFills.');
} else {
  const filled = rows.filter(r => !r.unimpl && r.dims.fillPainted).length;
  if (filled) console.log(`✅ FILL COVERAGE  every background-painting component (${filled}) has a rendered backgroundColor assertion`);
}

// Work in progress is not drift (I52): components the project says are still being made, on one side
// only, are listed and never fail. One now on both sides is ready to compare.
{
  const wip = await inProgressList(ROOT, cfg);
  const open = wip.filter((x) => !x.ready), ready = wip.filter((x) => x.ready && x.why === 'not built yet');
  if (open.length) console.log(`ℹ️  IN PROGRESS ${open.length}  (not drift, never fails): ${open.map((x) => `${x.name} (${x.why}, ${sideLabel(x)})`).join(', ')}`);
  if (ready.length) console.log(`⚠️  READY TO COMPARE ${ready.length}  ${ready.map((x) => x.name).join(', ')} ${ready.length === 1 ? 'is' : 'are'} in Figma and in code now; take ${ready.length === 1 ? 'it' : 'them'} off knownUnimplementedComponents so ${ready.length === 1 ? 'it is' : 'they are'} compared`);
}

const anyFail = (cfg.coverageStrict === true && gaps.length)
  || (modeStrict && modeBlind.length)
  || (fillStrict && unverifiedFills.length);

if (gaps.length) {
  const strict = cfg.coverageStrict === true;
  console.log(`\n${strict ? '❌' : '⚠️ '} UNCHECKED (${gaps.length}) - DS component modelled by NOTHING (no contract, selector, or assertion):`);
  for (const r of gaps) console.log(`  ${strict ? '❌' : '⚠️ '} ${r.comp}`);
  console.log('   Add a CONTRACT entry (+ selector/assertions), or list it in ds-config knownUnimplementedComponents.');
}
if (modeStrict && modeBlind.length) {
  console.log('\n❌ Mode-blind rendered assertions above (ds-config renderedModeStrict:true).');
}
if (fillStrict && unverifiedFills.length) {
  console.log('\n❌ Unverified background fills above (ds-config fillCoverageStrict:true).');
}
console.log(anyFail ? '' : '\nEvery DS component is modelled by at least one check. ✓\n');
process.exit(anyFail ? 1 : 0);
