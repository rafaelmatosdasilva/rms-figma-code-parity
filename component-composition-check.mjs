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

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname, basename, relative } from 'path';

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

const KNOWN_UNIMPLEMENTED = new Set(cfg.knownUnimplementedComponents ?? []);
const KNOWN_EXCEPTIONS    = new Set(cfg.knownCompositionExceptions ?? []);   // "Parent/Child"
const COMPONENT_FILES     = cfg.componentFiles ?? {};
const COMPONENT_SELECTORS = cfg.componentSelectors ?? {};

const norm    = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const selNorm = (name) => norm(COMPONENT_SELECTORS[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1)));

// ── Universe of DS component names ────────────────────────────────────────────
const universe = new Set(Object.keys(SNAP).filter(n => !n.startsWith('_')));
for (const list of Object.values(SNAP)) if (Array.isArray(list)) for (const n of list) universe.add(n);
for (const n of Object.keys(COMPONENT_SELECTORS)) universe.add(n);
const uni = [...universe].map(n => ({ name: n, nameNorm: norm(n), selNorm: selNorm(n) }));

// ── Discover source files ─────────────────────────────────────────────────────
const SRC_DIRS = (cfg.componentSrcDirs ?? ['src', 'components', 'app', 'lib', 'packages']).map(d => join(ROOT, d));
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs']);
const CODE_EXT = new Set(['.vue', '.tsx', '.jsx', '.ts', '.js', '.svelte']);
function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (CODE_EXT.has(extname(e.name)) && !/\.(test|spec|stories)\./.test(e.name)) out.push(p);
  }
}
const files = [];
for (const d of SRC_DIRS) if (existsSync(d)) walk(d, files);
if (!files.length) walk(ROOT, files);
const _txt = new Map();
const read = (f) => { if (!_txt.has(f)) { try { _txt.set(f, readFileSync(f, 'utf8')); } catch { _txt.set(f, ''); } } return _txt.get(f); };

// ── Resolve a component to its code file (explicit map, base selector, name, basename) ──
function declaredNames(text) {
  const out = [];
  for (const m of text.matchAll(/\bname\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/g)) out.push(m[1]);
  for (const m of text.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) out.push(m[1]);
  return out;
}
function resolveFile(name) {
  if (COMPONENT_FILES[name]) { const p = join(ROOT, COMPONENT_FILES[name]); return existsSync(p) ? p : null; }
  const nn = norm(name), sn = selNorm(name);
  const bySel = [], byName = [], byBase = [];
  for (const f of files) {
    const t = read(f), tn = norm(t);
    if (sn.length >= 4 && tn.includes(sn)) bySel.push(f);
    if (declaredNames(t).some(d => norm(d) === nn)) byName.push(f);
    if (norm(basename(f, extname(f))) === nn) byBase.push(f);
  }
  const pick = bySel.length ? bySel : byName.length ? byName : byBase;
  return pick.length === 1 ? pick[0] : null;
}

// Which DS components does a file use? A sub-component is "used" when its base selector,
// or its name as a JSX tag / import, appears in the file.
function usedComponents(file) {
  const t = read(file), tn = norm(t);
  const used = new Set();
  for (const u of uni) {
    if (u.selNorm.length >= 4 && tn.includes(u.selNorm)) { used.add(u.name); continue; }
    if (new RegExp(`<${u.name}\\b|\\b${u.name}\\b\\s*(?:from|,|})`).test(t)) used.add(u.name);   // JSX tag / import
  }
  return used;
}

// ── Compare ───────────────────────────────────────────────────────────────────
const MISSING = [], EXTRA = [], NOFILE = [], OK = [];
for (const [name, list] of Object.entries(SNAP)) {
  if (name.startsWith('_') || !Array.isArray(list)) continue;
  if (KNOWN_UNIMPLEMENTED.has(name)) continue;
  const nested = list.filter(n => n !== name && !KNOWN_UNIMPLEMENTED.has(n));
  if (!nested.length) continue;

  const file = resolveFile(name);
  if (!file) { NOFILE.push(`${name}: Figma nests [${nested.join(', ')}] but no code component file found - set ds-config.json → componentFiles["${name}"]`); continue; }
  const used = usedComponents(file);
  const rel = relative(ROOT, file);

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
