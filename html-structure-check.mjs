// html-structure-check.mjs - Gate [15]: HTML structure snapshot
// Run from project root: node ../rms-figma-code-parity/html-structure-check.mjs
//                    or: node ../rms-figma-code-parity/html-structure-check.mjs --accept
//
// Parses each plugin's ui.src.html (static part only - strips <script> blocks),
// extracts a structural fingerprint (all element IDs, DS component classes on
// interactive elements, all <use href="#icon-X"> with nearest-ancestor context),
// and diffs against a stored snapshot.
//
// First run with a missing snapshot writes the baseline (✅ pass).
// --accept: accept the current structure as the new baseline (overwrites snapshot).
//
// Stored next to the theme CSS (e.g. src/html-structure.snapshot.json).

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join }                                     from 'path';
import { fingerprint as fingerprintWith, markupClassSet } from './markup-source.mjs';

const ROOT   = process.cwd();
const ACCEPT = process.argv.includes('--accept');

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

// Derive snapshot path next to theme CSS
const themeCSS   = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat()[0];
const snapPath   = themeCSS.replace(/[^/\\]+$/, 'html-structure.snapshot.json');
const absSnap    = join(ROOT, snapPath);

const pluginCSS = cfg.paths?.pluginCSS ?? [];
const plugins   = cfg.paths?.plugins   ?? [];

// ── Load existing snapshot ────────────────────────────────────────────────────
let stored = {};
if (existsSync(absSnap)) {
  try { stored = JSON.parse(readFileSync(absSnap, 'utf8')); } catch {}
}

// ── DS component class set ────────────────────────────────────────────────────
// Only interactive elements with a recognised DS class are fingerprinted. Which classes count is
// design-system specific: ds-config.json → htmlStructureClasses sets them. Without the key, the
// classes the saved snapshot already fingerprints are used, so a project keeps its result with no
// config edit. The engine ships no default list (it must not assume any DS's class names).
const { classes: DS_CLASSES, from: CLASSES_FROM } = markupClassSet(cfg, stored);
if (CLASSES_FROM === 'snapshot') console.log(`ℹ️  [15] DS component classes taken from the saved snapshot (${DS_CLASSES.size}). Set htmlStructureClasses in ds-config.json to choose them.`);
else if (!DS_CLASSES.size) console.log('ℹ️  [15] htmlStructureClasses not set in ds-config.json - DS component classes are not part of the fingerprint (ids and icon references still are).');

// The fingerprint itself lives in markup-source.mjs (shared with the code capture).
const fingerprint = (html) => fingerprintWith(html, DS_CLASSES);

// ── Compute current fingerprints ──────────────────────────────────────────────
const current = {};
for (let i = 0; i < plugins.length; i++) {
  const plugin  = plugins[i];
  const srcPath = pluginCSS[i];
  if (!srcPath || !existsSync(join(ROOT, srcPath))) continue;
  const html = readFileSync(join(ROOT, srcPath), 'utf8');
  current[plugin] = fingerprint(html);
}

// ── Accept mode: overwrite snapshot ──────────────────────────────────────────
if (ACCEPT) {
  const snap = { _updated: new Date().toISOString().slice(0, 10), ...current };
  writeFileSync(absSnap, JSON.stringify(snap, null, 2) + '\n');
  console.log(`✅ [15] html-structure.snapshot.json accepted - baseline updated`);
  process.exit(0);
}

// ── First run (no snapshot): write and pass ───────────────────────────────────
if (!existsSync(absSnap) || !Object.keys(stored).length) {
  const snap = { _updated: new Date().toISOString().slice(0, 10), ...current };
  writeFileSync(absSnap, JSON.stringify(snap, null, 2) + '\n');
  console.log(`✅ [15] No snapshot found - baseline written (${plugins.length} plugin(s))`);
  process.exit(0);
}

// ── Diff ──────────────────────────────────────────────────────────────────────
let pass = true;

function diffArrays(label, prev, curr) {
  const prevSet = new Set(prev.map(v => JSON.stringify(v)));
  const currSet = new Set(curr.map(v => JSON.stringify(v)));
  const added   = curr.filter(v => !prevSet.has(JSON.stringify(v)));
  const removed = prev.filter(v => !currSet.has(JSON.stringify(v)));
  return { added, removed };
}

for (const plugin of plugins) {
  const prev = stored[plugin];
  const curr = current[plugin];
  if (!curr) continue;
  if (!prev) {
    console.log(`✅ [15] ${plugin}: new plugin - no snapshot yet`);
    continue;
  }

  const idDiff   = diffArrays('ids',           prev.ids,           curr.ids);
  const compDiff = diffArrays('components',    prev.components,    curr.components);
  const iconDiff = diffArrays('icons',         prev.icons,         curr.icons);
  const btnDiff  = diffArrays('buttonContent', prev.buttonContent ?? [], curr.buttonContent ?? []);

  const hasDiff = idDiff.added.length || idDiff.removed.length ||
                  compDiff.added.length || compDiff.removed.length ||
                  iconDiff.added.length || iconDiff.removed.length ||
                  btnDiff.added.length  || btnDiff.removed.length;

  if (!hasDiff) {
    console.log(`✅ [15] ${plugin}: structure unchanged`);
    continue;
  }

  pass = false;
  console.log(`❌ [15] ${plugin}: structure changed`);

  if (idDiff.added.length)   console.log(`       + ids:           ${idDiff.added.join(', ')}`);
  if (idDiff.removed.length) console.log(`       - ids:           ${idDiff.removed.join(', ')}`);
  if (compDiff.added.length)   console.log(`       + components:   ${compDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (compDiff.removed.length) console.log(`       - components:   ${compDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
  if (iconDiff.added.length)   console.log(`       + icons:        ${iconDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (iconDiff.removed.length) console.log(`       - icons:        ${iconDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
  if (btnDiff.added.length)    console.log(`       + btnContent:   ${btnDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (btnDiff.removed.length)  console.log(`       - btnContent:   ${btnDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
}

if (!pass) {
  console.log(`\n  To accept: node ../rms-figma-code-parity/html-structure-check.mjs --accept`);
}

process.exit(pass ? 0 : 1);
