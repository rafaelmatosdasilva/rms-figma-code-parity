// test/tier1-b.test.mjs - regression tests for four Tier 1-B gate fixes.
//
// Each gate reads ds-config.json + snapshots + CSS from its cwd, prints a report and
// exits 0/1/2. The shared harness (runGate -> {code,out,dir}) builds a throwaway fixture
// from a { relpath: content } map and runs the gate against it. Every fixture below is
// modelled by reading the gate for its exact inputs.
//
// Fixes covered (one [bugfix ...] proving the post-fix behaviour + [regression ...] locks
// of a valid-passes and an invalid-fails case each):
//
//   1) subcomponent-isolation-check.mjs - broadElementTag() now treats a bare combinator
//      with NO surrounding spaces (".card>svg") as a broad element override, exactly like
//      the whitespace descendant form (".card svg").
//   2) icon-slot-check.mjs - the <use href> scanners match href as ANY attribute and accept
//      xlink:href, so `<use class="x" href="#i">` and `<use xlink:href="#i">` still resolve
//      to the icon symbol instead of "element not found".
//   3) component-selector-check.mjs - KNOWN_COMPONENTS is matched case/space/hyphen
//      insensitively, so a component whose only known name is a CONTRACT figmaName
//      ("Radio Button") polices a hyphenated state var (--radio-button-bg-selected).
//   4) coverage-check.mjs - a rendered assertion whose colorScheme is a mode NAME or a
//      different case ("Dark") is mapped into the snapshot mode-key space, so a pair that
//      together covers both modes is not reported as a false "mode-blind" gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 1) subcomponent-isolation-check.mjs - combinator with no surrounding spaces
// ─────────────────────────────────────────────────────────────────────────────
// The gate scans theme/plugin CSS for a bare element tag (svg/span/div/...) scoped
// under a class and setting a visual property (color/background/fill/stroke/border):
// each such rule is a sub-component override trap unless documented in ALLOWED_BROAD_RULES.
const ISO_GATE = 'subcomponent-isolation-check.mjs';
const ISO_CFG  = { paths: { themeCSS: 'theme.css' } };

test('[bugfix subcomponent] .card>svg (child combinator, no spaces) is flagged as a broad override', () => {
  const { code, out } = runGate(ISO_GATE, {
    'ds-config.json': ISO_CFG,
    // No structure-contract.mjs => ALLOWED_BROAD_RULES empty => the rule is undocumented.
    'theme.css': `.card>svg { color: red; }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNDOCUMENTED/, out);
  assert.match(out, /\.card>svg/, out);
});

test('[regression subcomponent] .card svg (whitespace descendant) is still flagged', () => {
  const { code, out } = runGate(ISO_GATE, {
    'ds-config.json': ISO_CFG,
    'theme.css': `.card svg { color: red; }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNDOCUMENTED/, out);
  assert.match(out, /\.card svg/, out);
});

test('[regression subcomponent] a scoped class rule (.card .icon) is not a broad element override and passes', () => {
  const { code, out } = runGate(ISO_GATE, {
    'ds-config.json': ISO_CFG,
    // .icon is a class, not a bare element tag => not a broad override.
    'theme.css': `.card .icon { color: red; }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /No new undocumented broad element selectors/, out);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) icon-slot-check.mjs - href as any attribute + xlink:href
// ─────────────────────────────────────────────────────────────────────────────
// For each ICON_USAGES entry {plugin, selector, icon}, the gate maps the plugin NAME
// (paths.plugins[i]) to its source HTML (paths.pluginCSS[i]), finds the element by
// selector, and reads the <use href> in the following window.
const ICON_SLOT_GATE = 'icon-slot-check.mjs';
const SLOT_CFG       = { paths: { plugins: ['main'], pluginCSS: ['ui.html'] } };

test('[bugfix icon-slot] a <use> with a preceding attribute and a <use xlink:href> both resolve to the icon', () => {
  const { code, out } = runGate(ICON_SLOT_GATE, {
    'ds-config.json': SLOT_CFG,
    'structure-contract.mjs':
      "export const ICON_USAGES = [" +
      "{ plugin: 'main', selector: '.slotAttr',  icon: 'icon-foo' }," +
      "{ plugin: 'main', selector: '.slotXlink', icon: 'icon-foo' }];",
    // href is NOT the first attribute in the first slot; the second uses xlink:href.
    // Spans (not buttons) keep the exhaustiveness scan from adding unrelated failures.
    'ui.html':
      `<span class="slotAttr"><svg><use class="x" href="#icon-foo"/></svg></span>\n` +
      `<span class="slotXlink"><svg><use xlink:href="#icon-foo"/></svg></span>\n`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /\.slotAttr: "icon-foo"/, out);   // preceding-attribute form recognized
  assert.match(out, /\.slotXlink: "icon-foo"/, out);  // xlink:href form recognized
  assert.doesNotMatch(out, /element not found/, out);
  assert.doesNotMatch(out, /undeclared/, out);
});

test('[regression icon-slot] a plain <use href="#icon-foo"> still resolves to the icon', () => {
  const { code, out } = runGate(ICON_SLOT_GATE, {
    'ds-config.json': SLOT_CFG,
    'structure-contract.mjs': "export const ICON_USAGES = [{ plugin: 'main', selector: '.slot', icon: 'icon-foo' }];",
    'ui.html': `<span class="slot"><svg><use href="#icon-foo"/></svg></span>\n`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /\.slot: "icon-foo"/, out);
});

test('[regression icon-slot] a wrong icon in the slot fails', () => {
  const { code, out } = runGate(ICON_SLOT_GATE, {
    'ds-config.json': SLOT_CFG,
    'structure-contract.mjs': "export const ICON_USAGES = [{ plugin: 'main', selector: '.slot', icon: 'icon-right' }];",
    'ui.html': `<span class="slot"><svg><use href="#icon-wrong"/></svg></span>\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /icon is "icon-wrong", expected "icon-right"/, out);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) component-selector-check.mjs - normalized KNOWN_COMPONENTS match
// ─────────────────────────────────────────────────────────────────────────────
// The gate flags a state var (suffix hover/selected/disabled/focus/checked) used on a
// selector with no matching state indicator, but only when the var prefix is a known DS
// component. A component known ONLY through its CONTRACT figmaName "Radio Button" is now
// matched by the normalized (case/space/hyphen insensitive) lookup against the hyphenated
// var prefix "radio-button"; without normalization the exact-string lookup misses and the
// var would be skipped, so removing the fix flips the [bugfix] case from fail to pass.
const SELECTOR_GATE = 'component-selector-check.mjs';
const SEL_CFG       = { paths: { themeCSS: 'theme.css' } };
const RADIO_CONTRACT = "export const CONTRACT = { radioBtn: { figmaName: 'Radio Button' } };";

test('[bugfix selector] a figmaName-only component ("Radio Button") polices its hyphenated state var', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SEL_CFG,
    'structure-contract.mjs': RADIO_CONTRACT,
    // Non-state selector (.radio-button has no "selected" indicator) => mis-scoped state var.
    'theme.css': `.radio-button { color: var(--radio-button-bg-selected); }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /--radio-button-bg-selected/, out);
  assert.match(out, /🚨/, out);
});

test('[regression selector] a semantic var (--text-disabled, not a component) is still skipped and passes', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SEL_CFG,
    'structure-contract.mjs': RADIO_CONTRACT,
    // "text" is not a known component => the state var is not policed => no mismatch.
    'theme.css': `.field-label { color: var(--text-disabled); }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /All state vars appear inside matching state selectors/, out);
});

test('[regression selector] a correctly-scoped state var (.radio-button.selected) passes', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SEL_CFG,
    'structure-contract.mjs': RADIO_CONTRACT,
    'theme.css': `.radio-button.selected { color: var(--radio-button-bg-selected); }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /All state vars appear inside matching state selectors/, out);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) coverage-check.mjs - colorScheme name/case mapped to the snapshot mode key
// ─────────────────────────────────────────────────────────────────────────────
// The gate builds a coverage matrix from the structure snapshot + the contract's declared
// checks, then cross-references RENDERED_ASSERTIONS against the figma-vars snapshot's color
// modes to find mode-blind assertions (an assertion group that pins some modes, not all).
// renderedModeStrict:true turns a real mode-blind group into a hard exit 1, so both cases
// below are checkable by exit code. One DS component with a CONTRACT entry gives it a
// non-zero coverage score, so there is no "gap" and the ONLY thing that can fail the gate
// is a mode-blind assertion.
const COVERAGE_GATE = 'coverage-check.mjs';
const COV_CFG  = { paths: { snapshotStructure: 'snap.json', snapshotVars: 'vars.json' }, renderedModeStrict: true };
const COV_SNAP = { components: { widget: {} } };
const COV_VARS = { color: { light: {}, dark: {} } };   // two color modes => SNAP_MODES = light/dark

test('[bugfix coverage] a colorScheme given as a mode NAME/case ("Dark") maps to the snapshot key, so the light+Dark pair is not mode-blind', () => {
  const { code, out } = runGate(COVERAGE_GATE, {
    'ds-config.json': COV_CFG,
    'snap.json': COV_SNAP,
    'vars.json': COV_VARS,
    // Same assertion key (plugin/selector/prop), one pinned to "light", its sibling to "Dark".
    // "Dark" maps to snapshot key "dark", so together they cover both modes.
    'structure-contract.mjs':
      "export const CONTRACT = { widget: {} };\n" +
      "export const RENDERED_ASSERTIONS = [" +
      "{ plugin: 'p', selector: '.widget', prop: 'color', expected: '#111', colorScheme: 'light' }," +
      "{ plugin: 'p', selector: '.widget', prop: 'color', expected: '#eee', colorScheme: 'Dark' }];",
  });
  assert.equal(code, 0, out);
  assert.match(out, /MODE COVERAGE/, out);       // every mode-pinned assertion covers all modes
  assert.doesNotMatch(out, /MODE-BLIND/, out);
});

test('[regression coverage] an assertion covering only one of two modes IS reported mode-blind (fails under renderedModeStrict)', () => {
  const { code, out } = runGate(COVERAGE_GATE, {
    'ds-config.json': COV_CFG,
    'snap.json': COV_SNAP,
    'vars.json': COV_VARS,
    // Only "light" is pinned; "dark" is left unguarded => a genuine mode-blind gap.
    'structure-contract.mjs':
      "export const CONTRACT = { widget: {} };\n" +
      "export const RENDERED_ASSERTIONS = [" +
      "{ plugin: 'p', selector: '.widget', prop: 'color', expected: '#111', colorScheme: 'light' }];",
  });
  assert.equal(code, 1, out);
  assert.match(out, /MODE-BLIND/, out);
  assert.match(out, /missing: dark/, out);
});
