// screen-element-check.mjs - the Markup gate (Screen element completeness, Figma screen -> code).
// Run from project root: node scripts/screen-element-check.mjs
//
// The structure/token gates compare elements that already exist on BOTH sides. They cannot see
// a whole control the DESIGN has that the CODE simply never built - a "Preflight" button added to
// a screen, a modal, an extra toggle. This gate closes that gap for REFERENCE SCREENS: for each
// registered screen it takes the DS element inventory (interactive controls + their visible
// label) and requires a code counterpart OF THE MATCHING KIND.
//
// Kind-awareness is the whole point. A label can appear in the code as an id, a comment, or a
// section header while the CONTROL is missing (e.g. "Preflight" lives in `#preflight-section`
// ids but there is no Preflight <button>). So a bare text match is not enough: a DS `buttonX`
// labelled "Preflight" is only satisfied by the label sitting inside a <button> (or an element
// carrying a button class) - not by the word appearing somewhere in the file.
//
// Input: figma-screens.snapshot.json (captured in Phase 1 by refreshScreenElements in audit.mjs):
//   { "screens": { "<nodeId>": { name, plugin, elements: [ { component, label }, ... ] } } }
// Inert (exit 0) until that snapshot exists, so it never false-positives before capture.
//
// Exit 0 = every interactive DS screen element has a code counterpart (or advisory-only).
// Exit 1 = a DS element has no code counterpart AND `screenElementStrict: true` is set.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const SNAP = 'figma-screens.snapshot.json';
if (!existsSync(join(ROOT, SNAP))) {
  console.log('⏭  screen elements: no figma-screens.snapshot.json - skipped (capture it to enable)');
  process.exit(0);
}
let screens = {};
try { screens = JSON.parse(readFileSync(join(ROOT, SNAP), 'utf8')).screens ?? {}; } catch { /* malformed */ }
const screenIds = Object.keys(screens);
if (!screenIds.length) {
  console.log('⏭  screen elements: figma-screens.snapshot.json has no screens - skipped');
  process.exit(0);
}

const STRICT = cfg.screenElementStrict === true;
// Silence a deliberate different realization, e.g. Preflight built as inline sections rather than
// a button+modal. Entries are "<plugin>/<label>" (case-insensitive), matched against the DS label.
const EXEMPT = new Set((cfg.knownScreenElementExemptions ?? []).map((s) => String(s).toLowerCase().trim()));

// ── Which DS components are interactive controls worth requiring a counterpart for ──
// Everything else (dividerLine, badge, swatch, card, panel, plain icon) is decorative/structural
// and is NOT asserted here - other gates cover their tokens/structure.
function family(component) {
  const c = String(component || '').toLowerCase();
  // Order matters: "radioButton"/"checkBox" contain "button"/"box" - the more specific control
  // families must win before the generic button test.
  if (c.includes('radio')) return 'radio';
  if (c.includes('switch') || c.includes('toggle')) return 'switch';
  if (c.includes('segment')) return 'segmented';
  if (c.includes('check')) return 'checkbox';
  if (c.includes('modal') || c.includes('dialog') || c.includes('overlay')) return 'modal';
  if (c.includes('button') || c.includes('stepper')) return 'button';
  if (c === 'input' || c.includes('field') || c.includes('textinput')) return 'input';
  return 'other';
}
const REQUIRED = new Set(['button', 'switch', 'radio', 'segmented', 'checkbox', 'input', 'modal']);

// A marker that, appearing just before the label in the code, proves an element of that KIND
// hosts the label. Generic across HTML/JSX/Vue - matches a tag or a class/role token.
const MARKER = {
  button: /<button\b|class=["'][^"']*\bbutton|role=["']button/i,
  switch: /class=["'][^"']*\bswitch|type=["']checkbox|role=["']switch/i,
  radio: /class=["'][^"']*\bradio|type=["']radio/i,
  // Segments render as buttons/tabs nested in the control, so accept either the segment/tab class
  // or the hosting <button> - the parent's `segmented` class can sit past the window for later
  // segments.
  segmented: /class=["'][^"']*\b(segment|tab)|<button\b/i,
  checkbox: /class=["'][^"']*\bcheck|type=["']checkbox/i,
  input: /<input\b|class=["'][^"']*\b(input|field|stepper)/i,
  modal: /class=["'][^"']*\b(modal|dialog|overlay)|role=["']dialog/i,
};
const WINDOW = 340; // chars before the label to scan for the kind marker

// The button family collapses every DS variant (Primary/Secondary/Tertiary/Quaternary) to one
// "button", so a label-only match can't see a control that CHANGED variant in the DS (e.g. "Save
// as default" going buttonSecondary → buttonTertiary). For button-family controls we therefore
// verify the EXACT DS component class sits on the element hosting the label.
const BUTTON_CLASS = /\bbutton(?:primary|secondary|tertiary|quaternary)\b/i;
function compClass(component) { return String(component || '').replace(/\s+/g, ''); } // "Button Tertiary" -> "ButtonTertiary"

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ── Resolve the code file(s) for a plugin/screen ──
// Default: everything under apps/<plugin>/ (html/js/vue/jsx/tsx). Override the directory per
// plugin via ds-config.json -> pluginDirs { "<plugin>": "path/from/root" }.
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs', 'test', '__tests__', '__mocks__', 'e2e']);
const EXT = new Set(['.html', '.htm', '.vue', '.jsx', '.tsx', '.js', '.ts', '.svelte']);
function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (EXT.has(extname(e.name)) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
}
// Visible-text matching must see MARKUP only. Inside a <script> the JS operators `<`/`>` and
// template-literal HTML (`<button>` in a string) would fake a text node and a kind marker, so a
// mere identifier (`requestPreflight`) would falsely satisfy a "Preflight" button. Strip scripts,
// styles and comments for the visible-text pass; quoted-string matching still uses the full text
// so a JS-set dynamic label (`'Scan selection'`) still counts.
function stripNonMarkup(code) {
  return code
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}
const _codeCache = new Map();
function codeForPlugin(plugin) {
  if (_codeCache.has(plugin)) return _codeCache.get(plugin);
  const rel = (cfg.pluginDirs && cfg.pluginDirs[plugin]) || `apps/${plugin}`;
  const files = [];
  walk(join(ROOT, rel), files);
  let text = '';
  for (const f of files) { try { text += '\n' + readFileSync(f, 'utf8'); } catch { /* skip */ } }
  const entry = { full: text, html: stripNonMarkup(text) };
  _codeCache.set(plugin, entry);
  return entry;
}

// A label reaches the DOM in one of two ways, and only these two count as a real counterpart -
// NOT the word turning up in an identifier, a class name, an id, or a comment (why a naive text
// match failed: "Preflight" lives only in `requestPreflight`/`#preflight-*`, never as a label):
//   1. a QUOTED STRING equal to the label - a dynamic label set in JS or an attribute value
//      (e.g. `'Scan selection'`), which by itself is strong evidence the control exists; or
//   2. VISIBLE TEXT between tags (`>Label<`) sitting inside an element of the matching KIND.
function isQuoted(code, idx, label) {
  const before = code[idx - 1];
  const after = code[idx + label.length];
  return (before === '"' || before === "'" || before === '`') && before === after;
}
function isVisibleText(code, idx) {
  // Between the previous '>' and this position with no intervening '<' => a text node. Inside a
  // tag or an HTML comment the nearest opener is '<', so both are naturally excluded.
  return code.lastIndexOf('>', idx) > code.lastIndexOf('<', idx);
}
function hasCounterpart(code, fam, label) {
  const marker = MARKER[fam];
  const rq = new RegExp(esc(label), 'g'); // case-sensitive: labels are user-facing, casing is real
  let m;
  // 1. A quoted string equal to the label, anywhere (incl. JS) - a dynamic/attribute label.
  while ((m = rq.exec(code.full))) { if (isQuoted(code.full, m.index, label)) return true; }
  // 2. Visible text of the matching kind, in markup only.
  if (marker) {
    const rv = new RegExp(esc(label), 'g');
    while ((m = rv.exec(code.html))) {
      if (!isVisibleText(code.html, m.index)) continue;
      const start = Math.max(0, m.index - WINDOW);
      if (marker.test(code.html.slice(start, m.index + label.length + 40))) return true;
    }
  }
  return false;
}

// The button-variant class on the button ENCLOSING this label as visible text (or null). Reads the
// nearest <button …> that still wraps the label (no </button> between it and the label) - NOT any
// button class in a window, which would wrongly grab a NEIGHBOURING button (e.g. "Export PDF" sitting
// right after a `.buttonSecondary` "Save as default").
function hostingButtonClass(code, label) {
  const rv = new RegExp(esc(label), 'g');
  let m;
  while ((m = rv.exec(code.html))) {
    if (!isVisibleText(code.html, m.index)) continue;
    const before = code.html.slice(0, m.index);
    const openIdx = before.lastIndexOf('<button');
    if (openIdx === -1) continue;
    if (before.lastIndexOf('</button>') > openIdx) continue; // nearest <button> already closed → label not inside it
    const gt = code.html.indexOf('>', openIdx);
    const tag = code.html.slice(openIdx, gt === -1 ? openIdx + 200 : gt + 1);
    const cls = tag.match(BUTTON_CLASS);
    if (cls) return cls[0];
  }
  return null;
}

// How many row separators (dividerLine / <hr>) the plugin markup renders - to compare against the
// design's rowSeparators count (a separator carries no label, so it can only be checked by count).
function codeSeparatorCount(code) {
  return (code.html.match(/class=["'][^"']*\bdividerLine\b/gi) || []).length
       + (code.html.match(/<hr\b/gi) || []).length;
}

// ── Compare each screen's DS inventory against its code ──
const OK = [];
const MISSING = [];
const MISMATCH = [];   // control present but built with the wrong DS component (e.g. secondary vs tertiary)
const SEPGAP = [];     // design separates rows with dividerLine; the code renders fewer
const SKIPPED = [];
let checked = 0;

for (const id of screenIds) {
  const screen = screens[id] || {};
  const plugin = screen.plugin;
  if (!plugin) { SKIPPED.push(`screen ${id} has no plugin - cannot resolve code`); continue; }
  const code = codeForPlugin(plugin);
  if (!code.full) { SKIPPED.push(`screen ${id} (${plugin}): no code files under apps/${plugin} - cannot check`); continue; }

  const seen = new Set(); // dedupe repeated labels within a screen
  for (const el of screen.elements || []) {
    const label = norm(el.label);
    const fam = family(el.component);
    if (!label || !REQUIRED.has(fam)) continue;
    const key = `${fam}:${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (EXEMPT.has(`${plugin}/${label}`.toLowerCase())) { SKIPPED.push(`${plugin}: "${label}" (${el.component}) - exempt`); continue; }
    checked++;
    if (hasCounterpart(code, fam, label)) {
      // Fix 1 - exact DS component (button family): the label is hosted, but on the DS component the
      // design specifies? A secondary→tertiary swap passes the family match yet is a real divergence.
      if (fam === 'button' && BUTTON_CLASS.test(compClass(el.component))) {
        const want = compClass(el.component).toLowerCase();   // e.g. buttontertiary
        const got = hostingButtonClass(code, label);          // e.g. buttonSecondary (null if quoted-only)
        if (got && got.toLowerCase() !== want) {
          MISMATCH.push(`${screen.name || id} - DS ${el.component} "${label}" is built as .${got} in the ${plugin} code`);
          continue;
        }
      }
      OK.push(`${plugin}: ${el.component} "${label}"`);
    } else {
      MISSING.push(`${screen.name || id} - DS ${el.component} "${label}" has no ${fam} counterpart in the ${plugin} code`);
    }
  }

  // Fix 2 - row separators (dividerLines between controls) carry no label, so the inventory above
  // can't see them. Compare the design's count against what the plugin markup renders.
  const designSeps = screen.rowSeparators || 0;
  if (designSeps > 0) {
    const codeSeps = codeSeparatorCount(code);
    if (codeSeps < designSeps) {
      SEPGAP.push(`${screen.name || id} - design places ${designSeps} row-separator(s) (dividerLine) between controls; the ${plugin} code renders ${codeSeps}`);
    }
  }
}

console.log(`\n✅ IN CODE   ${OK.length}`);
console.log(`❌ MISSING   ${MISSING.length}   (DS screen control with no code counterpart of its kind)`);
console.log(`❌ MISMATCH  ${MISMATCH.length}   (control built with the wrong DS component - e.g. secondary vs tertiary)`);
console.log(`❌ SEP GAP   ${SEPGAP.length}   (dividerLines the design places between controls but the code omits)`);
if (SKIPPED.length) console.log(`⏭  SKIPPED   ${SKIPPED.length}`);
if (MISSING.length) {
  console.log('\n─── DS screen elements missing from the code ──');
  for (const l of MISSING) console.log(`  ❌ ${l}`);
  console.log('\n  Build the control, or record a deliberate different realization in');
  console.log('  ds-config.json → knownScreenElementExemptions ("<plugin>/<label>").');
}
if (MISMATCH.length) {
  console.log('\n─── controls built with the wrong DS component ──');
  for (const l of MISMATCH) console.log(`  ❌ ${l}`);
  console.log('\n  Change the code to the DS component the design uses (the class the design specifies).');
}
if (SEPGAP.length) {
  console.log('\n─── row separators in the design missing from the code ──');
  for (const l of SEPGAP) console.log(`  ❌ ${l}`);
  console.log('\n  Render the DS dividerLine between the rows/cards the design separates.');
}
const anyFinding = MISSING.length + MISMATCH.length + SEPGAP.length;
if (!anyFinding && checked) {
  console.log('   Every interactive DS screen element has a code counterpart, the right component, and its separators. ✓');
}
// Advisory by default so a deferred design element doesn't block every push; the findings stay
// visible in the report. `screenElementStrict: true` promotes them to a hard fail.
if (anyFinding && !STRICT) console.log(`\n⚠️  ADVISORY: ${anyFinding} screen divergence(s) (missing / wrong-component / missing-separator) — set ds-config screenElementStrict:true to enforce.`);
if (SKIPPED.length) { console.log('\n─── skipped ──'); for (const l of SKIPPED.slice(0, 20)) console.log(`  ⏭  ${l}`); }

if (anyFinding && STRICT) process.exit(1);
process.exit(0);
