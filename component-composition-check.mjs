// component-composition-check.mjs - Gate: Component composition parity
// Run from project root: node scripts/component-composition-check.mjs
//
// A DS component contains other DS components (a Card holds a Badge, a Button an Icon).
// This verifies that the set of sub-components Figma says a component instantiates
// matches the set the CODE actually uses. Reads composition straight from a committed
// snapshot (no token, any plan) and detects sub-components in code by their base
// selector or by being used/imported by name - so it never depends on Code Connect.
//
// Reads at project root:
//   ds-config.json                        - componentSelectors, componentFiles,
//                                           componentSrcDirs, knownUnimplementedComponents,
//                                           knownCompositionExceptions
//   component-composition.snapshot.json   - { "Comp": ["Sub1", "Sub2"], ... } (committed)
//
// Exit 0 = every sub-component Figma nests is used by the code (or is exempt).
// Exit 1 = a Figma-nested sub-component is missing from the code.
// Exit 2 = the composition snapshot is missing (gate did NOT run; capture via the plugin).

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { loadLocator } from './component-locator.mjs';
import { componentSourceFiles, textReader, resolveComponentFile, usedComponents as usedIn } from './component-source.mjs';
import { readFreshSnapshot } from './code-capture.mjs';
import { inProgressNames } from './in-progress.mjs';   // I52: work in progress is not drift

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const SNAP_PATH = 'component-composition.snapshot.json';
if (!existsSync(join(ROOT, SNAP_PATH))) {
  console.log(`\n⚠️  ${SNAP_PATH} not found at project root.`);
  console.log('   It lists, per component, the DS components it contains, and should be committed.');
  console.log('   Run /rms-figma-code-parity once - it captures this via the Figma plugin (no token,');
  console.log('   any plan) - then commit it.');
  console.log('   (exit 2 - treated as "not run", never a pass)\n');
  process.exit(2);
}
const SNAP = JSON.parse(readFileSync(join(ROOT, SNAP_PATH), 'utf8'));

const KNOWN_UNIMPLEMENTED = await inProgressNames(ROOT, cfg);
const KNOWN_EXCEPTIONS    = new Set(cfg.knownCompositionExceptions ?? []);   // "Parent/Child"
const COMPONENT_SELECTORS = cfg.componentSelectors ?? {};

const norm    = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const LOCATOR = await loadLocator(ROOT, cfg);   // the one shared component finder
const selNorm = (name) => norm(LOCATOR.classFor(name));

// ── Universe of DS component names ────────────────────────────────────────────
const universe = new Set(Object.keys(SNAP).filter(n => !n.startsWith('_')));
for (const list of Object.values(SNAP)) if (Array.isArray(list)) for (const n of list) universe.add(n);
for (const n of Object.keys(COMPONENT_SELECTORS)) universe.add(n);
const uni = [...universe].map(n => ({ name: n, nameNorm: norm(n), selNorm: selNorm(n) }));

// ── Read the code (component-source.mjs, shared with the code capture) ────────
const files = componentSourceFiles(ROOT, cfg);
const read = textReader();
const resolveFile = (name) => resolveComponentFile(name, { ROOT, cfg, files, read, classFor: LOCATOR.classFor }).file;
// Which DS components does a file use? Its base selector, or its name as a JSX tag / import.
const usedComponents = (file) => usedIn(read(file), uni);
// Nesting seen in the rendered page (code capture), so markup built by JavaScript counts too.
// Only a snapshot that still matches the code is used.
const CAPTURE = await readFreshSnapshot(ROOT, cfg).catch(() => null);
const renderedChildren = (name) => new Set(Object.entries(CAPTURE?.nesting?.[name]?.contains ?? {}).filter(([, c]) => c.renderedIn?.length).map(([n]) => n));

// ── HTML mode (frameworkComponents:false, opt-in) ─────────────────────────────
// A plain-HTML/CSS DS consumer has all its components as classes in the plugin markup + theme
// CSS, not as prop-components in per-file modules - so resolveFile finds nothing and the gate
// would just SKIP. Instead, verify each sub-component Figma nests is realized as a class in the
// plugin source. Only parents actually built here are checked (an unbuilt DS component's
// composition is moot); icons (Gate [15]/[16]) and raw layers are excluded. Opt in with
// ds-config.json → htmlRealization: true (shared with Gate [12]); htmlCompositionStrict makes a
// missing sub-component a hard fail (default: advisory - a DS component the plugins don't use is
// not a bug). Default off → this block is skipped and the normal framework check runs below.
if (cfg.frameworkComponents === false && cfg.htmlRealization) {
  const asList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const srcNorm = norm([...asList(cfg.paths?.pluginCSS), ...asList(cfg.paths?.themeCSS)]
    .map(p => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } }).join('\n'));
  const isIconOrLayer = (n) => /^icon[-/ ]/i.test(n) || n.startsWith('.');
  const inSource = (name) => { const sn = selNorm(name); return sn.length >= 4 && srcNorm.includes(sn); };
  const OK = [], MISSING = [], SKIP = [];
  for (const [name, list] of Object.entries(SNAP)) {
    if (name.startsWith('_') || !Array.isArray(list)) continue;
    if (KNOWN_UNIMPLEMENTED.has(name)) continue;
    if (!inSource(name)) { SKIP.push(name); continue; }   // parent not built in these plugins - composition moot
    for (const child of list) {
      if (child === name || isIconOrLayer(child) || KNOWN_UNIMPLEMENTED.has(child)) continue;
      if (KNOWN_EXCEPTIONS.has(`${name}/${child}`)) { OK.push(`${name} → ${child} (exempt)`); continue; }
      if (inSource(child)) OK.push(`${name} → ${child}`);
      else MISSING.push(`${name}: Figma nests "${child}" but its class is not in the plugin source`);
    }
  }
  console.log('\nGate [13] - sub-component composition  (HTML mode - each nested DS component realized as a class)\n');
  console.log(`  ✅ OK       ${OK.length}`);
  console.log(`  ⏭ SKIP     ${SKIP.length}   (parent component not built in these plugins)`);
  console.log(`  ❌ MISSING  ${MISSING.length}   (Figma nests a sub-component the plugin source doesn't use${cfg.htmlCompositionStrict ? '' : ' - advisory'})`);
  for (const m of MISSING) console.log(`     ${cfg.htmlCompositionStrict ? '❌' : '⚠️ '} ${m}`);
  const fail = cfg.htmlCompositionStrict ? MISSING.length : 0;
  console.log(fail ? `\n❌ Composition: ${fail} nested sub-component(s) missing\n` : `\n✅ Composition: every built component uses the sub-components Figma nests\n`);
  process.exit(fail ? 1 : 0);
}

// ── Compare ───────────────────────────────────────────────────────────────────
const MISSING = [], EXTRA = [], NOFILE = [], OK = [];
for (const [name, list] of Object.entries(SNAP)) {
  if (name.startsWith('_') || !Array.isArray(list)) continue;
  if (KNOWN_UNIMPLEMENTED.has(name)) continue;
  const nested = list.filter(n => n !== name && !KNOWN_UNIMPLEMENTED.has(n));
  if (!nested.length) continue;

  const file = resolveFile(name);
  const rendered = renderedChildren(name);
  if (!file && !rendered.size) { NOFILE.push(`${name}: Figma nests [${nested.join(', ')}] but no code component file found - set ds-config.json → componentFiles["${name}"]`); continue; }
  const used = file ? usedComponents(file) : new Set();
  for (const r of rendered) used.add(r);
  const rel = file ? relative(ROOT, file) : 'rendered page';

  for (const child of nested) {
    if (KNOWN_EXCEPTIONS.has(`${name}/${child}`)) { OK.push(`${name} → ${child} (exempt)`); continue; }
    if (used.has(child)) OK.push(`${name} → ${child}`);
    else MISSING.push(`${name}: Figma nests "${child}" but the code component doesn't use it  (${rel})`);
  }
  // code uses a DS component Figma doesn't nest here - advisory (could be intentional)
  for (const u of used) if (u !== name && !nested.includes(u) && universe.has(u))
    EXTRA.push(`${name}: code uses "${u}" but Figma doesn't nest it here  (${rel})`);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ OK        ${OK.length}`);
console.log(`❌ MISSING   ${MISSING.length}   (Figma nests a sub-component the code doesn't use)`);
console.log(`❌ NO FILE   ${NOFILE.length}   (component with nested children, no code file found)`);
if (EXTRA.length) console.log(`ℹ️ EXTRA     ${EXTRA.length}   (code uses a component Figma doesn't nest - advisory)`);

const fail = MISSING.length + NOFILE.length;
if (MISSING.length) { console.log('\n─── Missing sub-component in code ──'); for (const l of MISSING) console.log(`  ❌ ${l}`); }
if (NOFILE.length)  { console.log('\n─── No code file found ──'); for (const l of NOFILE) console.log(`  ❌ ${l}`); }
if (EXTRA.length)   { console.log('\n─── Extra sub-components in code (advisory) ──'); for (const l of EXTRA.slice(0, 20)) console.log(`  ℹ️ ${l}`); }

if (fail) { console.log(''); process.exit(1); }
console.log('\nEvery component uses the sub-components Figma nests. ✓\n');
process.exit(0);
