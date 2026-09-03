// test/tier1-a.test.mjs - regression tests for three "tier 1-A" gate fixes.
//
// Each gate reads ds-config.json + snapshots + CSS from its cwd, prints check lines, and
// exits 0 (pass) / 1 (fail) / 2 (not run). Fixtures are built from a { relpath: content }
// map and run through the shared harness (runGate -> {code,out,dir}); every fixture is
// modelled on the gate's own inputs and early-exit conditions (read the gate, do not guess).
//
// Bugs locked here (each fix gets a [bugfix ...] proving post-fix behaviour, plus
// [regression ...] valid-passes / invalid-fails locks):
//
//   1) exemption-check.mjs
//      (a) a MISSING / unreadable figma-vars snapshot now SKIPS cleanly (exit 0) instead of
//          crashing before it can report.
//      (b) bound-tokens.json / component-state-tokens.json authored as a JSON ARRAY are read
//          correctly (old code ran Object.keys over the array -> numeric indices -> a runtime
//          only COVERED/EXPLICIT entry looked STALE).
//      (c) colours compare by canonical hex, so a Figma "#ffffff" vs a CSS "#fff" is not a
//          false BROKEN.
//
//   2) icon-check.mjs
//      (a) a single-axis "<svg width=\"16\">" whose height comes from CSS is no longer flagged
//          "16xNaN" - only the axis actually present in the markup is policed.
//      (b) the dead-icon usage probe no longer counts id "icon-star" as used when only
//          "icon-star-filled" appears (whole-id match, not a prefix match).
//
//   3) effect-check.mjs
//      a hex8 shadow colour and a decimal rgba() that denote the same 8-bit alpha compare
//      equal, so "#00000026" vs "rgba(0,0,0,0.15)" is not a false mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, EMPTY_PARITY_MAP, crashed } from './helpers.mjs';

// ==============================================================================
// 1) exemption-check.mjs
// ==============================================================================
// Inputs: ds-config.json (else exit 1), parity-map.mjs (absent -> exit 0 "nothing to
// check"), the vars snapshot at paths.snapshotVars (absent/unreadable -> exit 0 "skipped"),
// the theme CSS, and the optional runtime-walk files bound-tokens.json /
// component-state-tokens.json. Token universe = every token in each mode's snap.color map
// (+ snap.sizing). A colour EXPLICIT is BROKEN on a real value mismatch; an entry absent
// from both the snapshot and the runtime walk is STALE. Either -> exit 1.

const EX_GATE = 'exemption-check.mjs';
// A vars snapshot: color tokens per legacy mode key (light/dark) + a sizing map.
const varsSnap = (light = {}, dark = {}, sizing = {}) => ({ color: { light, dark }, sizing });

test('[bugfix exemption] a MISSING vars snapshot skips cleanly (exit 0, no crash)', () => {
  // parity-map is present (so we are past the "nothing to check" exit) but the snapshot file
  // named by paths.snapshotVars does not exist. Pre-fix this threw before any report; the fix
  // catches the read and prints a skip line.
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    // NO vars.json on disk.
  });
  assert.ok(!crashed(out), `gate crashed instead of skipping:\n${out}`);
  assert.equal(code, 0, out);
  assert.match(out, /exemption check skipped/, out);
});

test('[bugfix exemption] an array-form bound-tokens.json does not make a runtime-only COVERED entry look STALE', () => {
  // widget/foo is NOT in the snapshot; it is only in the runtime walk, authored as a JSON
  // array. Pre-fix Object.keys([...]) yielded "0","1",... so the token was never found in the
  // runtime set -> false STALE -> exit 1. Post-fix the array is read as the key list.
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': "export const COVERED = new Set(['widget/foo']);",
    'vars.json': varsSnap({}, {}, {}),          // token absent from the snapshot
    'theme.css': ':root {}',
    'bound-tokens.json': ['widget/foo'],        // ARRAY shape - the regression trigger
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, out);
  assert.match(out, /STALE\s+0\b/, out);          // no phantom exemption reported
  assert.match(out, /VALID\s+1\b/, out);          // the covered entry was accepted
  assert.doesNotMatch(out, /widget\/foo/, out);   // never listed as a phantom
});

test('[bugfix exemption] an EXPLICIT token whose Figma value is #ffffff and CSS resolves to #fff is NOT BROKEN (exit 0)', () => {
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': "export const EXPLICIT = { 'brand/white': '--brand-white' };",
    'vars.json': varsSnap({ 'brand/white': '#ffffff' }, { 'brand/white': '#ffffff' }, {}),
    'theme.css': ':root { --brand-white: #fff; }',   // shorthand of the same colour
  });
  assert.equal(code, 0, out);
  assert.match(out, /BROKEN\s+0\b/, out);
  assert.doesNotMatch(out, /Broken mappings/, out);   // no findings section
  assert.doesNotMatch(out, /brand\/white/, out);      // the entry was accepted, never listed
});

test('[regression exemption] a genuinely STALE exemption still fails (exit 1)', () => {
  // ghost/token is in neither the snapshot nor any runtime walk -> a real phantom exemption.
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': "export const COVERED = new Set(['ghost/token']);",
    'vars.json': varsSnap({}, {}, {}),
    'theme.css': ':root {}',
  });
  assert.equal(code, 1, out);
  assert.match(out, /STALE\s+1\b/, out);
  assert.match(out, /ghost\/token/, out);
});

test('[regression exemption] a genuinely BROKEN EXPLICIT (real value mismatch) still fails (exit 1)', () => {
  // Figma says blue, the CSS var resolves to red - not a shorthand/whitespace artefact.
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': "export const EXPLICIT = { 'brand/blue': '--brand-blue' };",
    'vars.json': varsSnap({ 'brand/blue': '#0000ff' }, {}, {}),
    'theme.css': ':root { --brand-blue: #ff0000; }',
  });
  assert.equal(code, 1, out);
  assert.match(out, /value mismatch/, out);
  assert.match(out, /brand\/blue/, out);
});

test('[regression exemption] a fully valid, exact-match exemption set passes (exit 0)', () => {
  const { code, out } = runGate(EX_GATE, {
    'ds-config.json': { paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' } },
    'parity-map.mjs': "export const EXPLICIT = { 'brand/blue': '--brand-blue' };",
    'vars.json': varsSnap({ 'brand/blue': '#0000ff' }, { 'brand/blue': '#0000ff' }, {}),
    'theme.css': ':root { --brand-blue: #0000ff; }',
  });
  assert.equal(code, 0, out);
  assert.match(out, /All exemption entries are valid/, out);
});

// ==============================================================================
// 2) icon-check.mjs
// ==============================================================================
// Inputs: ds-config.json (paths.pluginCSS = HTML files scanned for <symbol>) and
// structure-contract.mjs (ICON_SYMBOLS). Render-size policing runs when
// iconCheck.allowedSizes is set, over DS entries (desc starts "DS ICON"). A DS desc of the
// form "DS ICON - <Name> node <id>" lets the sprite id derive its DS name, so the entry does
// not trip the DS-name checks. The dead-icon probe treats a documented symbol as alive only
// if its whole id appears in the corpus outside its own <symbol> definition.

const IC_GATE = 'icon-check.mjs';
// A hidden <symbol> definition. viewBox is arbitrary here (no icon snapshot -> not compared).
const symbolDef = (id) =>
  `<svg style="display:none"><symbol id="${id}" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></symbol></svg>`;
// A DS entry desc whose name derives to the sprite id (icon-foo), so only the size rule is
// under test.
const FOO_DS = "export const ICON_SYMBOLS = { 'icon-foo': 'DS ICON - Icon/Foo node 1:23' };";

test('[bugfix icon-check] a single-axis <svg width="16"> (height from CSS) is NOT an off-grid size failure', () => {
  const { code, out } = runGate(IC_GATE, {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] }, iconCheck: { allowedSizes: [16, 24] } },
    'structure-contract.mjs': FOO_DS,
    'ui.html': symbolDef('icon-foo') + `\n<button><svg width="16"><use href="#icon-foo"/></svg></button>\n`,
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /OFF-GRID SIZE/, out);
  assert.doesNotMatch(out, /NaN/, out);            // pre-fix reported the size as "16xNaN"
});

test('[bugfix icon-check] a documented icon-star referenced ONLY as #icon-star-filled is reported dead', () => {
  const { code, out } = runGate(IC_GATE, {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] } },
    'structure-contract.mjs': "export const ICON_SYMBOLS = { 'icon-star': 'PLUGIN-SPECIFIC - a star glyph' };",
    // The only reference is to a DIFFERENT id that has icon-star as a prefix.
    'ui.html': symbolDef('icon-star') + `\n<button><svg><use href="#icon-star-filled"/></svg></button>\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /DEAD ICON\s+1\b/, out);
  assert.match(out, /"#icon-star"\s+is defined but no/, out);
});

test('[regression icon-check] a real off-grid 20x20 DS icon is flagged (exit 1)', () => {
  const { code, out } = runGate(IC_GATE, {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] }, iconCheck: { allowedSizes: [16, 24] } },
    'structure-contract.mjs': FOO_DS,
    'ui.html': symbolDef('icon-foo') + `\n<button><svg width="20" height="20"><use href="#icon-foo"/></svg></button>\n`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /OFF-GRID SIZE/, out);
  assert.match(out, /20px/, out);
  assert.match(out, /#icon-foo/, out);
});

test('[regression icon-check] a normally-used, on-grid documented DS icon passes (exit 0)', () => {
  const { code, out } = runGate(IC_GATE, {
    'ds-config.json': { paths: { pluginCSS: ['ui.html'] }, iconCheck: { allowedSizes: [16, 24] } },
    'structure-contract.mjs': FOO_DS,
    'ui.html': symbolDef('icon-foo') + `\n<button><svg width="16" height="16"><use href="#icon-foo"/></svg></button>\n`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /No undocumented or misconfigured SVG symbols/, out);
});

// ==============================================================================
// 3) effect-check.mjs
// ==============================================================================
// Opt-in: a no-op unless BOTH snap.effects (styleName -> box-shadow) and ds-config
// figma.effects are present. Each style maps to a CSS var (explicit map, or the default
// name -> --name); the var's resolved box-shadow is compared to the snapshot one after a
// canonicalisation that rewrites hex to rgba() and quantises alpha to 8 bits. Exit 1 on a
// mismatch.

const EF_GATE = 'effect-check.mjs';
const efConfig = () => ({
  paths: { snapshotVars: 'vars.json', themeCSS: 'theme.css' },
  figma: { effects: { explicit: { 'elevation/1': '--shadow-1' } } },
});

test('[bugfix effect] a Figma #00000026 shadow and a CSS rgba(0,0,0,0.15) var do NOT mismatch (exit 0)', () => {
  // 0x26 == 38, and 0.15*255 rounds to 38 too: the same 8-bit alpha, different notation.
  const { code, out } = runGate(EF_GATE, {
    'ds-config.json': efConfig(),
    'vars.json': { effects: { 'elevation/1': '0px 2px 8px 0px #00000026' } },
    'theme.css': ':root { --shadow-1: 0px 2px 8px 0px rgba(0,0,0,0.15); }',
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, out);
  assert.match(out, /MATCH\s+1\b/, out);
  assert.match(out, /All declared effect styles match/, out);
});

test('[regression effect] a genuinely different shadow colour DOES mismatch (exit 1)', () => {
  const { code, out } = runGate(EF_GATE, {
    'ds-config.json': efConfig(),
    'vars.json': { effects: { 'elevation/1': '0px 2px 8px 0px #ff0000' } },   // red, not black
    'theme.css': ':root { --shadow-1: 0px 2px 8px 0px rgba(0,0,0,0.15); }',
  });
  assert.equal(code, 1, out);
  assert.match(out, /MISMATCH\s+1\b/, out);
  assert.match(out, /elevation\/1/, out);
});

test('[regression effect] an exactly-matching shadow passes (exit 0)', () => {
  const { code, out } = runGate(EF_GATE, {
    'ds-config.json': efConfig(),
    'vars.json': { effects: { 'elevation/1': '0px 2px 8px 0px rgba(0,0,0,0.15)' } },
    'theme.css': ':root { --shadow-1: 0px 2px 8px 0px rgba(0,0,0,0.15); }',
  });
  assert.equal(code, 0, out);
  assert.match(out, /MATCH\s+1\b/, out);
  assert.match(out, /All declared effect styles match/, out);
});
