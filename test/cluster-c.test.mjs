// test/cluster-c.test.mjs - regression tests for three Cluster C gate fixes.
//
// Each gate is run through the shared harness (runGate → {code,out,dir}); fixtures are
// modelled by reading each gate for its exact inputs and how it loads its contract.
//
//   1) icon-check.mjs        - ICON_SYMBOLS (structure-contract.mjs): an OBJECT entry that
//                              omits `desc` used to crash the report loop (`r.desc.startsWith`);
//                              desc now defaults to '' (documented.push({ desc: desc ?? '' })).
//   2) icon-slot-check.mjs   - ICON_USAGES / COMPONENT_USAGES (structure-contract.mjs): the
//      component-slot-check.mjs  class-selector lookup no longer treats `-` as a word boundary,
//                              so `.badge` no longer binds to `class="badge-count"`.
//   3) form-control-check.mjs - FORM_CONTROL_BINDINGS (structure-contract.mjs): the shorthand
//                              map had `background→background`, double-counting a single
//                              `background:` declaration; the name list is now de-duplicated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, crashed } from './helpers.mjs';

// ── Fixture builders ──────────────────────────────────────────────────────────

// A <symbol> definition + a <use> reference so the symbol is not reported as dead.
const iconHtml = (id) =>
  `<svg style="display:none"><symbol id="${id}" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></symbol></svg>\n` +
  `<button><svg><use href="#${id}"/></svg></button>\n`;

// icon-slot / component-slot map a plugin NAME (paths.plugins[i]) to its source (paths.pluginCSS[i]).
const SLOT_CONFIG = { paths: { plugins: ['main'], pluginCSS: ['ui.html'] } };

// form-control reads paths.pluginCSS as combined HTML+CSS source. A throwaway first rule
// (`.dummy {}`) keeps the greedy rule-splitter from folding the leading markup into the
// selector of the rule we care about, so `#q` stays a clean subject selector.
const FC_CONFIG   = { paths: { pluginCSS: ['ui.html'] } };
const FC_CONTRACT =
  "export const FORM_CONTROL_BINDINGS = [{ component: 'input', dsClass: 'inputWrap', " +
  "elements: ['input','textarea','select'], props: { 'background': ['--input-background'] } }];";
const fcHtml = (decl) =>
  `<input id="q" type="text">\n<style>\n  .dummy { color: red; }\n  #q { ${decl} }\n</style>\n`;

// ── 1) icon-check.mjs - object ICON_SYMBOLS entry without `desc` ───────────────

test('[bugfix icon-check] an object ICON_SYMBOLS entry that omits `desc` runs to a normal pass/fail (no crash)', () => {
  const { code, out } = runGate('icon-check.mjs', {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] } },
    // Object form with NO `desc` - pre-fix this made documented[].desc undefined and the
    // report loop threw `TypeError: Cannot read properties of undefined (reading 'startsWith')`.
    'structure-contract.mjs': "export const ICON_SYMBOLS = { 'icon-foo': {} };",
    'ui.html': iconHtml('icon-foo'),
  });
  assert.ok(!crashed(out), `gate crashed:\n${out}`);
  assert.ok(code === 0 || code === 1, `expected a normal pass/fail exit, got ${code}\n${out}`);
  assert.match(out, /#icon-foo/, out);   // reached the report loop where the crash used to be
});

test('[regression icon-check] a valid ICON_SYMBOLS contract passes', () => {
  const { code, out } = runGate('icon-check.mjs', {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] } },
    'structure-contract.mjs': "export const ICON_SYMBOLS = { 'icon-foo': 'PLUGIN-SPECIFIC - a custom glyph' };",
    'ui.html': iconHtml('icon-foo'),
  });
  assert.equal(code, 0, out);
});

test('[regression icon-check] a genuinely-missing (undocumented) symbol fails', () => {
  const { code, out } = runGate('icon-check.mjs', {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] } },
    'structure-contract.mjs': 'export const ICON_SYMBOLS = {};',   // no entry for icon-bar
    'ui.html': iconHtml('icon-bar'),
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNDOCUMENTED/, out);
});

// ── 2) icon-slot-check.mjs - hyphen is not a word boundary ─────────────────────

test('[bugfix icon-slot] `.badge` skips a preceding `class="badge-count"` and binds the real `.badge`', () => {
  const { code, out } = runGate('icon-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const ICON_USAGES = [{ plugin: 'main', selector: '.badge', icon: 'icon-right' }];",
    // badge-count (with the WRONG icon) appears BEFORE the real .badge (the RIGHT icon).
    'ui.html':
      `<span class="badge-count"><svg><use href="#icon-wrong"/></svg></span>\n` +
      `<span class="badge"><svg><use href="#icon-right"/></svg></span>\n`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /\.badge: "icon-right"/, out);   // the correct element was checked
  assert.doesNotMatch(out, /icon-wrong/, out);        // badge-count was never bound
});

test('[regression icon-slot] a correct icon slot passes', () => {
  const { code } = runGate('icon-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const ICON_USAGES = [{ plugin: 'main', selector: '.badge', icon: 'icon-right' }];",
    'ui.html': `<span class="badge"><svg><use href="#icon-right"/></svg></span>\n`,
  });
  assert.equal(code, 0);
});

test('[regression icon-slot] a wrong icon in the slot fails', () => {
  const { code, out } = runGate('icon-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const ICON_USAGES = [{ plugin: 'main', selector: '.badge', icon: 'icon-right' }];",
    'ui.html': `<span class="badge"><svg><use href="#icon-wrong"/></svg></span>\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /icon is "icon-wrong", expected "icon-right"/, out);
});

// ── 2b) component-slot-check.mjs - same hyphen-boundary fix ────────────────────

test('[bugfix component-slot] `.badge` skips a preceding `class="badge-count"` and reads the real `.badge` class', () => {
  const { code, out } = runGate('component-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const COMPONENT_USAGES = [{ plugin: 'main', selector: '.badge', expectedClass: 'realClass' }];",
    // badge-count (with the WRONG class) appears BEFORE the real .badge (the RIGHT class).
    'ui.html':
      `<div class="badge-count wrongClass">x</div>\n` +
      `<div class="badge realClass">y</div>\n`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /\.badge: "realClass"/, out);   // the correct element was checked
  assert.doesNotMatch(out, /wrongClass/, out);       // badge-count was never bound
});

test('[regression component-slot] a correct component slot passes', () => {
  const { code } = runGate('component-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const COMPONENT_USAGES = [{ plugin: 'main', selector: '.badge', expectedClass: 'realClass' }];",
    'ui.html': `<div class="badge realClass">y</div>\n`,
  });
  assert.equal(code, 0);
});

test('[regression component-slot] a missing expected class fails', () => {
  const { code, out } = runGate('component-slot-check.mjs', {
    'ds-config.json': SLOT_CONFIG,
    'structure-contract.mjs': "export const COMPONENT_USAGES = [{ plugin: 'main', selector: '.badge', expectedClass: 'realClass' }];",
    'ui.html': `<div class="badge otherClass">y</div>\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /expected class "realClass"/, out);
});

// ── 3) form-control-check.mjs - `background` no longer double-counted ──────────

test('[bugfix form-control] a single `background:` declaration is reported once, not duplicated', () => {
  const { code, out } = runGate('form-control-check.mjs', {
    'ds-config.json': FC_CONFIG,
    'structure-contract.mjs': FC_CONTRACT,
    // One mis-tokened background. Pre-fix the shorthand map (background→background) counted
    // it twice, emitting two identical ❌ lines; the de-dup makes it exactly one.
    'ui.html': fcHtml('background: var(--divider);'),
  });
  assert.equal(code, 1, out);
  const hits = out.match(/background uses/g) ?? [];
  assert.equal(hits.length, 1, `expected the background failure reported once, got ${hits.length}\n${out}`);
});

test('[bugfix form-control] a valid form control passes and its background is counted once (not twice)', () => {
  const { code, out } = runGate('form-control-check.mjs', {
    'ds-config.json': FC_CONFIG,
    'structure-contract.mjs': FC_CONTRACT,
    'ui.html': fcHtml('background: var(--input-background);'),
  });
  assert.equal(code, 0, out);
  assert.match(out, /1 form-control declaration/, out);   // single declaration, single count
});

test('[regression form-control] a mis-tokened form control fails', () => {
  const { code, out } = runGate('form-control-check.mjs', {
    'ds-config.json': FC_CONFIG,
    'structure-contract.mjs': FC_CONTRACT,
    'ui.html': fcHtml('background: var(--divider-line);'),   // real token, wrong component
  });
  assert.equal(code, 1, out);
  assert.match(out, /not a "input" token/, out);
});
