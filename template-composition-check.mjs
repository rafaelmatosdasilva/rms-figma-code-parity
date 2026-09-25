// template-composition-check.mjs - Gate: Template / page composition parity (Figma -> code).
// Run from project root: node scripts/template-composition-check.mjs
//
// The component/sub-component gates verify a single component against Figma. They stop at the
// component boundary: nothing checks whether a whole TEMPLATE or PAGE assembles the components
// Figma says it should. A designer re-composes a template frame in Figma (adds a Filters bar,
// swaps a SidePanel for a DetailFullPage) and no component-level gate notices - the template code
// silently drifts from the design. This gate closes that gap, one level ABOVE the component:
// for each registered template frame it takes the ordered set of DS components the frame composes
// and requires the template's code file to use each of them.
//
// Direction: Figma -> code (a template composes X; the code for that template must use X).
// It reuses the exact same "is this DS component used in this file?" detection as the
// sub-component gate (base selector, JSX tag, or import), so it never depends on Code Connect.
//
// Scope is OPT-IN and generic, exactly like screens[]/docs.surfaces:
//   ds-config.json -> "templates": [ { "name": "Consult", "nodeId": "12:345", "file"?: "..." }, ... ]
// With no templates[] configured the gate is a no-op PASS (a DS without templates is unaffected,
// byte-identical). Inert (exit 0) until figma-templates.snapshot.json exists, so it never
// false-positives before the first capture.
//
// Reads at project root:
//   ds-config.json                      - templates[], templateSrcDirs, componentSelectors,
//                                         componentFiles, componentSrcDirs,
//                                         knownUnimplementedComponents, knownTemplateExceptions,
//                                         templateCompositionStrict
//   figma-templates.snapshot.json       - { templates: { "<name>": { name, nodeId, components: [...] } } }
//                                         (captured in Phase 1 by refreshTemplateComposition in audit.mjs)
//
// Exit 0 = every composed component is used by its template code (or advisory-only / inert).
// Exit 1 = a composed component is missing from the template code AND templateCompositionStrict.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname, basename, relative } from 'path';
import { inProgressNames } from './in-progress.mjs';   // I52: work in progress is not drift

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

// ── Opt-in: no templates configured → no-op PASS (DS without templates unaffected) ──
const TEMPLATES_CFG = (cfg.templates ?? []).filter(t => t && t.name);
if (!TEMPLATES_CFG.length) {
  console.log('✅ [template-composition] no templates[] configured — skipped');
  process.exit(0);
}

// ── Inert until the snapshot is captured (mirrors screen-element-check) ──────────
const SNAP_PATH = 'figma-templates.snapshot.json';
if (!existsSync(join(ROOT, SNAP_PATH))) {
  console.log(`⚠️  [template-composition] ${SNAP_PATH} not found — run /rms-figma-code-parity to capture it`);
  console.log('   (it records, per template frame, the DS components it composes; captured via REST /nodes,');
  console.log('    any plan). Inert until then — never a false failure.');
  process.exit(0);
}
let SNAP = {};
try { SNAP = JSON.parse(readFileSync(join(ROOT, SNAP_PATH), 'utf8')).templates ?? {}; } catch {
  console.log(`⚠️  [template-composition] ${SNAP_PATH} unreadable — skipped`);
  process.exit(0);
}

const STRICT              = cfg.templateCompositionStrict === true;
const KNOWN_UNIMPLEMENTED = await inProgressNames(ROOT, cfg);
const KNOWN_EXCEPTIONS    = new Set(cfg.knownTemplateExceptions ?? []);   // "Template/Component"
const COMPONENT_FILES     = cfg.componentFiles ?? {};
const COMPONENT_SELECTORS = cfg.componentSelectors ?? {};
const TEMPLATE_FILES      = Object.fromEntries(TEMPLATES_CFG.filter(t => t.file).map(t => [t.name, t.file]));

const norm    = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const esc     = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const selNorm = (name) => norm(COMPONENT_SELECTORS[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1)));

// ── Universe of DS component names (to detect usage in template code) ────────────
const universe = new Set(Object.keys(COMPONENT_SELECTORS));
for (const t of Object.values(SNAP)) for (const c of (t.components ?? [])) universe.add(c);
const uni = [...universe].map(n => ({ name: n, nameNorm: norm(n), selNorm: selNorm(n) }));

// ── Discover source files ─────────────────────────────────────────────────────
const SRC_DIRS = (cfg.templateSrcDirs ?? cfg.componentSrcDirs ?? ['src', 'components', 'app', 'lib', 'packages'])
  .map(d => join(ROOT, d));
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs', '.parity-out']);
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

// ── Resolve a template to its code file (explicit map, base selector, name, basename) ──
function declaredNames(text) {
  const out = [];
  for (const m of text.matchAll(/\bname\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/g)) out.push(m[1]);
  for (const m of text.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) out.push(m[1]);
  return out;
}
function resolveFile(name) {
  const explicit = TEMPLATE_FILES[name] ?? COMPONENT_FILES[name];
  if (explicit) { const p = join(ROOT, explicit); return existsSync(p) ? p : null; }
  const nn = norm(name), sn = selNorm(name);
  const bySel = [], byName = [], byBase = [];
  for (const f of files) {
    const t = read(f), tn = norm(t);
    if (sn.length >= 4 && tn.includes(sn)) bySel.push(f);
    if (declaredNames(t).some(d => norm(d) === nn)) byName.push(f);
    if (norm(basename(f, extname(f))) === nn) byBase.push(f);
  }
  const pick = byBase.length === 1 ? byBase : byName.length === 1 ? byName : bySel;
  return pick.length === 1 ? pick[0] : null;
}

// Which DS components does a file use? Same detection as the sub-component gate:
// a component is "used" when its base selector, its JSX tag, or its import name appears.
function usedComponents(file) {
  const t = read(file), tn = norm(t);
  const used = new Set();
  for (const u of uni) {
    if (u.selNorm.length >= 4 && tn.includes(u.selNorm)) { used.add(u.name); continue; }
    if (new RegExp(`<${esc(u.name)}\\b|\\b${esc(u.name)}\\b\\s*(?:from|,|})`).test(t)) used.add(u.name);
  }
  return used;
}

// ── Compare ───────────────────────────────────────────────────────────────────
const MISSING = [], NOFILE = [], ORDER = [], OK = [];
let templatesChecked = 0;
for (const [name, entry] of Object.entries(SNAP)) {
  if (name.startsWith('_')) continue;
  if (KNOWN_UNIMPLEMENTED.has(name)) continue;
  const composed = (entry.components ?? []).filter(c => c !== name && !KNOWN_UNIMPLEMENTED.has(c));
  if (!composed.length) continue;
  templatesChecked++;

  const file = resolveFile(name);
  if (!file) {
    NOFILE.push(`${name}: Figma composes [${composed.join(', ')}] but no template code file found — set ds-config.json → templates[].file for "${name}"`);
    continue;
  }
  const used = usedComponents(file);
  const rel = relative(ROOT, file);

  const usedInOrder = [];
  for (const comp of composed) {
    if (KNOWN_EXCEPTIONS.has(`${name}/${comp}`)) { OK.push(`${name} → ${comp} (exempt)`); continue; }
    if (used.has(comp)) { OK.push(`${name} → ${comp}`); usedInOrder.push(comp); }
    else MISSING.push(`${name}: Figma composes "${comp}" but the template code doesn't use it  (${rel})`);
  }

  // Order advisory (never fails): the components the code DOES use, in first-appearance order
  // in the file, vs the order Figma composes them. A different order can be a real layout drift
  // or a harmless import order, so it is surfaced, not enforced.
  if (usedInOrder.length >= 2) {
    const t = read(file);
    // Compute code order by first index of each component's selector/name token.
    const firstIdx = (comp) => {
      const sel = COMPONENT_SELECTORS[comp] ?? ('.' + comp.charAt(0).toLowerCase() + comp.slice(1));
      const idxSel = sel.length >= 3 ? t.toLowerCase().indexOf(sel.toLowerCase()) : -1;
      const idxTag = t.indexOf(comp);
      const cand = [idxSel, idxTag].filter(i => i >= 0);
      return cand.length ? Math.min(...cand) : Number.MAX_SAFE_INTEGER;
    };
    const byCode = [...usedInOrder].sort((a, b) => firstIdx(a) - firstIdx(b));
    if (byCode.join('>') !== usedInOrder.join('>')) {
      ORDER.push(`${name}: Figma order [${usedInOrder.join(' → ')}] vs code order [${byCode.join(' → ')}]  (${rel})`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ USES      ${OK.length}   (template code uses the component Figma composes)`);
console.log(`${STRICT ? '❌' : '⚠️ '} MISSING   ${MISSING.length}   (Figma composes a component the template code doesn't use${STRICT ? '' : ' — advisory'})`);
console.log(`❌ NO FILE   ${NOFILE.length}   (template with composed components, no code file found)`);
if (ORDER.length) console.log(`ℹ️ ORDER     ${ORDER.length}   (composition order differs — advisory)`);

if (MISSING.length) { console.log('\n─── Composed component missing in template code ──'); for (const l of MISSING) console.log(`  ${STRICT ? '❌' : '⚠️ '} ${l}`); }
if (NOFILE.length)  { console.log('\n─── No template code file found ──'); for (const l of NOFILE) console.log(`  ❌ ${l}`); }
if (ORDER.length)   { console.log('\n─── Composition order differs (advisory) ──'); for (const l of ORDER.slice(0, 20)) console.log(`  ℹ️ ${l}`); }

// NO FILE is always a hard fail (a configured template with no resolvable code is a real setup
// gap). MISSING is a hard fail only under templateCompositionStrict; advisory otherwise, so a
// brand-new gate never breaks a build the day it is added.
const fail = NOFILE.length + (STRICT ? MISSING.length : 0);
if (fail) { console.log(`\n❌ Template composition: ${fail} issue(s) across ${templatesChecked} template(s)\n`); process.exit(1); }
console.log(`\n✅ Every template uses the components Figma composes${MISSING.length ? ` (${MISSING.length} advisory)` : ''}. ✓\n`);
process.exit(0);
