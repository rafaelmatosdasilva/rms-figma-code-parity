#!/usr/bin/env node
// container-containment-check.mjs — CSS-correctness gate: size containment must not
// collapse the element it is placed on.
//
// Why this exists. `container-type: inline-size` (and `container-type: size`) turns the
// element into a query container — and a side effect that is easy to forget is that it
// *also applies size containment on the inline axis*: the element's own inline size is no
// longer allowed to depend on its contents. On an element whose width is content-driven
// (a shrink-to-fit / hugging box — `display:inline-*`, or a flex item with no definite
// basis), that means the box collapses to the width it would have with *no* content, the
// text inside reflows to nothing, and any `@container` rule that shrinks a label
// (`max-width:0`) then latches permanently. The control renders with the icons but no
// labels, and every token-level and structural gate stays green because nothing about the
// tokens is wrong — the defect is pure layout.
//
// The failure that motivated this: a DS segmented control whose per-button label lived
// inside `.segmented-control button { display:inline-flex; container-type:inline-size }`.
// The button hugged its content, so containment zeroed its content-driven width and the
// "Colors" / "Export" labels vanished. Moving the containment to the `.full-width`
// variant — where each segment has a definite `flex:1 1 0; width:0` basis — fixed it.
//
// The rule (generic, no per-project contract needed): a selector that sets
// `container-type` to a value containing `size` or `inline-size` MUST also carry a
// definite inline size, UNLESS its display is block-level (block/flex/grid fill their
// container's width, so containment is safe). "Definite inline size" = any of:
//   • width / inline-size  (not auto | min-content | max-content | fit-content)
//   • flex-basis           (not auto | content)
//   • flex shorthand whose basis component is a length / percentage / 0
//   • an explicit block-level display (block | flex | grid | table … — fills the parent)
//
// Exemptions: cfg.knownContainerTypeExceptions = ["<selector>", …] (rare — prefer fixing).
import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

let cfg;
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const themePaths = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const pluginCSS  = cfg.paths?.pluginCSS ?? [];
const exempt     = new Set(cfg.knownContainerTypeExceptions ?? []);

/** Every rule in a stylesheet-ish source as {selector, body, file}. Nested @-rules
 *  (media/container/supports) are transparent — the innermost `sel { … }` still matches. */
function rules(css, file) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    out.push({ selector: sel, body: m[2], file });
  }
  return out;
}

const norm = (s) => s.trim().replace(/\s+/g, ' ');
const declVal = (body, prop) => {
  // last wins, like the cascade within a single rule
  const re = new RegExp(`(?<![\\w-])${prop}\\s*:\\s*([^;}]+)`, 'gi');
  let v = null; for (const m of body.matchAll(re)) v = m[1].trim();
  return v;
};

// Collect every rule, per file, so a flag can name where the containment lives.
const allRules = [];
for (const p of [...themePaths, ...pluginCSS]) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  allRules.push(...rules(src, p));
}

// Index all declarations that apply to a given (exact, normalised) selector, so we can
// answer "does this selector get a definite width *anywhere*?" across split rules.
const bySelector = new Map();
for (const r of allRules) {
  const key = norm(r.selector);
  (bySelector.get(key) ?? bySelector.set(key, []).get(key)).push(r);
}

const INDEFINITE_WIDTH = /^(auto|min-content|max-content|fit-content|inherit|initial|unset)$/i;
const BLOCK_DISPLAY    = /^(block|flex|grid|table|list-item|flow-root|table-cell)$/i;

/** Does `selector` get a definite inline size anywhere in the merged CSS? */
function hasDefiniteInlineSize(selector) {
  for (const r of bySelector.get(selector) ?? []) {
    const w = declVal(r.body, 'width') ?? declVal(r.body, 'inline-size');
    if (w && !INDEFINITE_WIDTH.test(w)) return true;

    const basis = declVal(r.body, 'flex-basis');
    if (basis && !/^(auto|content)$/i.test(basis)) return true;

    // flex shorthand: definite when a basis component is a length/percentage/0.
    const flex = declVal(r.body, 'flex');
    if (flex) {
      const parts = flex.split(/\s+/);
      if (parts.some(p => /^0$/.test(p) || /^[\d.]+(px|rem|em|%|vw|vh|ch|pt)$/i.test(p))) return true;
      // `flex: 1`  → grow 1, basis 0%  → definite;  `flex: none|auto|initial` → not.
      if (/^\d+$/.test(flex.trim())) return true;
    }

    // A block-level display fills its container's inline size → containment is safe.
    const disp = declVal(r.body, 'display');
    if (disp && BLOCK_DISPLAY.test(disp.trim())) return true;
  }
  return false;
}

/** Is `selector` shrink-to-fit (content-driven width)? Strong static signal = inline-level
 *  display. A selector with no display at all defaults to inline for unknown elements, but
 *  for our purposes we only flag when we can SEE an inline-level display — conservative,
 *  no false positives on block elements that merely lack an explicit width. */
function isShrinkToFit(selector) {
  for (const r of bySelector.get(selector) ?? []) {
    const disp = declVal(r.body, 'display');
    if (disp && /^(inline|inline-block|inline-flex|inline-grid|inline-table)$/i.test(disp.trim())) return true;
  }
  return false;
}

let pass = true, checked = 0, skipped = 0;
for (const r of allRules) {
  const ct = declVal(r.body, 'container-type');
  if (!ct) continue;
  if (!/\b(inline-size|size)\b/i.test(ct)) continue;   // `normal` establishes no size containment
  const sel = norm(r.selector);
  if (exempt.has(sel) || exempt.has(r.selector.trim())) { skipped++; continue; }
  checked++;

  if (isShrinkToFit(sel) && !hasDefiniteInlineSize(sel)) {
    pass = false;
    console.log(`❌ [css] ${r.file} — "${sel}" sets container-type:${ct.trim()} but hugs its content`);
    console.log(`         inline-size containment removes the element's content-driven width, so it`);
    console.log(`         collapses and any @container label-shrink latches — the labels disappear.`);
    console.log(`         Give it a definite inline size (width / flex-basis / flex:1 1 0), make it`);
    console.log(`         block-level, or move container-type to a variant that has one.`);
  }
}

if (pass) {
  console.log(`✅ [css] ${checked} container-type declaration(s) safe (definite width or block-level); ${skipped} exempt`);
}
process.exit(pass ? 0 : 1);
