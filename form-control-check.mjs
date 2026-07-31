#!/usr/bin/env node
// form-control-check.mjs — Gate [13c]: bespoke form controls must use their DS
// component's tokens.
//
// Why this exists. Slot parity already proves that every <button> carrying a DS class
// is declared, so a button can't quietly become the wrong component. Form controls had
// no equivalent, and that gap has a specific shape: a plugin hand-rolls an <input>
// instead of using the DS input class, styles it with a token that is real, correct and
// declared — just the wrong one for that element — and every token-level gate agrees.
// Token parity checks the token's VALUE. Naming round-trip checks it maps to a Figma
// token. Hygiene checks it isn't hardcoded. None of them ask whether it is the RIGHT
// token *here*, because nothing maps the element to a component.
//
// The failure that motivated this: a search field bordered with the divider-line token
// instead of the input token. The two resolve to the same primitive in one mode and one
// ramp step apart in the other — so it looked perfect in light mode and too dim in dark,
// and the whole audit stayed green.
//
// Contract (structure-contract.mjs), entirely project-defined:
//
//   export const FORM_CONTROL_BINDINGS = [{
//     component: 'input',                 // DS component key, used in messages only
//     dsClass:   'inputWrap',             // element carrying this = the base owns it, skip
//     elements:  ['input', 'textarea', 'select'],
//     props: {                            // CSS prop -> vars that are acceptable
//       'border-color': ['--input-border', '--input-border-hover', '--input-border-focus'],
//       'background':   ['--input-background'],
//     },
//     exempt: [{ selector: '#x', reason: '…' }],
//   }]
//
// Absent or empty, the gate skips — it never invents a binding.
import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

let cfg;
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

let BINDINGS = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (Array.isArray(m.FORM_CONTROL_BINDINGS)) BINDINGS = m.FORM_CONTROL_BINDINGS;
} catch { /* contract optional */ }

if (!BINDINGS.length) {
  console.log('⏭  [13c] FORM_CONTROL_BINDINGS not defined — skipping form-control check');
  process.exit(0);
}

const pluginCSS = cfg.paths?.pluginCSS ?? [];
if (!pluginCSS.length) {
  console.log('⏭  [13c] no paths.pluginCSS configured — skipping form-control check');
  process.exit(0);
}

// Longhands a shorthand can satisfy, so `border: <w> <s> var(--x)` counts as border-color.
const SHORTHAND_FOR = { 'border-color': 'border', 'background': 'background' };

const varsIn = (value) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]);

/**
 * True when `handle` is the SUBJECT of the selector — the element actually styled —
 * rather than an ancestor or sibling of it. `.a:checked + .b` styles `.b`, so a rule
 * mentioning the input is not necessarily a rule ON the input. Without this, every
 * `input:checked + .indicator` pattern (the standard custom radio/checkbox idiom)
 * reports as a mis-tokened input.
 */
function isSubject(selector, handle) {
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return selector.split(',').some(part => {
    const compounds = part.trim().split(/[\s>+~]+/).filter(Boolean);
    const last = compounds[compounds.length - 1] ?? '';
    return new RegExp(`${esc}(?![\\w-])`).test(last);
  });
}

/** Declarations of `prop` (or its shorthand) inside a rule body, in source order. */
function declarationsOf(body, prop) {
  const out = [];
  const names = [prop, SHORTHAND_FOR[prop]].filter(Boolean);
  for (const name of names) {
    // (?<![\w-]) stops `border-color` matching inside `border-top-color`, and
    // `background` matching inside `background-image`.
    const re = new RegExp(`(?<![\\w-])${name}\\s*:\\s*([^;}]+)`, 'g');
    for (const m of body.matchAll(re)) out.push({ name, value: m[1].trim() });
  }
  return out;
}

/** Every top-level rule in a stylesheet-ish source, as {selector, body}. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    out.push({ selector: sel, body: m[2] });
  }
  return out;
}

let pass = true, checked = 0, skipped = 0;

for (const rel of pluginCSS) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  const allRules = rules(src);

  for (const bind of BINDINGS) {
    const elements = bind.elements ?? [];
    const exempt   = bind.exempt ?? [];
    const dsClass  = bind.dsClass;

    // Find each form-control tag and note the id/classes it can be selected by.
    const tagRe = new RegExp(`<(${elements.join('|')})\\b([^>]*)>`, 'gi');
    for (const m of src.matchAll(tagRe)) {
      const attrs   = m[2];
      const id      = attrs.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
      const classes = (attrs.match(/\bclass\s*=\s*["']([^"']+)["']/)?.[1] ?? '').split(/\s+/).filter(Boolean);

      // A radio/checkbox/range is a DIFFERENT DS component (radioButton, toggle…), not
      // the text-input one, and is usually visually hidden with a styled sibling doing
      // the drawing. Binding it to input tokens would demand the wrong component's
      // colours. Configurable so a project can bind those types to their own component.
      const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/)?.[1] ?? 'text').toLowerCase();
      const excludeTypes = bind.excludeTypes
        ?? ['radio', 'checkbox', 'range', 'color', 'file', 'submit', 'button', 'reset', 'image', 'hidden'];
      if (excludeTypes.includes(type)) { skipped++; continue; }

      // Carrying the DS class means the base stylesheet owns its identity.
      if (dsClass && classes.includes(dsClass)) { skipped++; continue; }

      const handles = [...classes.map(c => '.' + c), ...(id ? ['#' + id] : [])];
      if (!handles.length) { skipped++; continue; }

      if (exempt.some(e => handles.includes(e.selector))) { skipped++; continue; }

      // Rules in THIS file that style the element itself (handle is the subject).
      const own = allRules.filter(r => handles.some(h => isSubject(r.selector, h)));

      for (const [prop, allowed] of Object.entries(bind.props ?? {})) {
        for (const rule of own) {
          for (const decl of declarationsOf(rule.body, prop)) {
            // `inherit`/`none`/`transparent`/`currentColor` are deliberate, not a token choice.
            if (/^(inherit|none|transparent|currentcolor|unset|initial)$/i.test(decl.value)) continue;
            const used = varsIn(decl.value);
            checked++;
            if (!used.length) {
              pass = false;
              console.log(`❌ [13c] ${relative(ROOT, abs)} ${rule.selector} — ${decl.name}: "${decl.value}" uses no token; expected one of ${allowed.join(', ')}`);
              continue;
            }
            if (!used.some(v => allowed.includes(v))) {
              pass = false;
              console.log(`❌ [13c] ${relative(ROOT, abs)} ${rule.selector} — ${decl.name} uses ${used.map(v => `var(${v})`).join(' + ')}, not a "${bind.component}" token`);
              console.log(`         expected one of: ${allowed.join(', ')}`);
              console.log(`         a valid token from another component still renders the wrong colour — often only in one mode`);
            }
          }
        }
      }
    }
  }
}

if (pass) {
  console.log(`✅ [13c] ${checked} form-control declaration(s) bound to their DS component's tokens  (${skipped} element(s) skipped — DS class or exempt)`);
}
process.exit(pass ? 0 : 1);
