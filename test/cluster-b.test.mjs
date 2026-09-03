// test/cluster-b.test.mjs - regression tests for the "cluster B" gate fixes.
//
// Bugs covered (one [bugfix ...] proving post-fix behaviour + [regression ...] locks
// of a valid-passes and an invalid-fails case each):
//   1) pseudo-element-check.mjs    - content value is PARSED, so `content: none`/`''`
//      (space after colon) are non-visible (skipped), real content still flagged.
//   2) container-containment-check.mjs - flex definiteness reads the BASIS component only,
//      so `flex:0 0 auto` is UNSAFE while `flex:1` / `flex:0 0 100px` are safe.
//   3) component-selector-check.mjs - the state-var scan allows whitespace after `var(`.
//   4) structure-check.mjs         - phantom-border inspects EVERY border/outline decl;
//      themeCSS comment-stripping + array themeCSS no longer crash.
//
// Each gate reads ds-config.json + CSS (+ snapshot/contract) from its cwd; runGate builds a
// throwaway fixture from a { relpath: content } map and returns { code, out, dir }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, crashed } from './helpers.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 1) pseudo-element-check.mjs
// ─────────────────────────────────────────────────────────────────────────────
const PSEUDO_GATE = 'pseudo-element-check.mjs';
const PSEUDO_CFG = { paths: { themeCSS: 'theme.css' } };

test('[regression pseudo] an undocumented ::before{content:"x"} fails', () => {
  const { code, out } = runGate(PSEUDO_GATE, {
    'ds-config.json': PSEUDO_CFG,
    'theme.css': `.thing::before { content: "x"; }`,
    // No structure-contract.mjs → nothing is documented.
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNDOCUMENTED/);
  assert.match(out, /\.thing::before/);
});

test('[regression pseudo] a documented content-setting ::before passes', () => {
  const { code, out } = runGate(PSEUDO_GATE, {
    'ds-config.json': PSEUDO_CFG,
    'theme.css': `.tag::before { content: "\\2192"; }`,
    // ALLOWED map keyed by the normalised selector.
    'structure-contract.mjs': `export const PSEUDO_ELEMENTS = { '.tag::before': 'DS INDICATOR - chevron' };`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /DOCUMENTED/);
  assert.match(out, /No undocumented/);
});

test('[bugfix pseudo] content:none and content:\'\' (space after colon) are NOT flagged', () => {
  // Deliberately NO structure-contract.mjs: if either value were treated as visible it
  // would be undocumented → exit 1. Parsing the value makes both non-visible → exit 0.
  const { code, out } = runGate(PSEUDO_GATE, {
    'ds-config.json': PSEUDO_CFG,
    'theme.css': `
      .a::before { content: none; }
      .b::after  { content: ''; }
    `,
  });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /UNDOCUMENTED/);
  assert.match(out, /No undocumented/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) container-containment-check.mjs
// ─────────────────────────────────────────────────────────────────────────────
const CONTAIN_GATE = 'container-containment-check.mjs';
const CONTAIN_CFG = { paths: { themeCSS: 'theme.css' } };

test('[bugfix container] flex:0 0 auto + container-type on a hugging box is flagged', () => {
  const { code, out } = runGate(CONTAIN_GATE, {
    'ds-config.json': CONTAIN_CFG,
    // inline-flex ⇒ shrink-to-fit; basis is `auto` ⇒ NOT a definite inline size.
    'theme.css': `.seg { display: inline-flex; container-type: inline-size; flex: 0 0 auto; }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /"\.seg"/);
  assert.match(out, /hugs its content/);
});

test('[regression container] flex:0 0 100px (definite basis) is NOT flagged', () => {
  const { code, out } = runGate(CONTAIN_GATE, {
    'ds-config.json': CONTAIN_CFG,
    'theme.css': `.seg { display: inline-flex; container-type: inline-size; flex: 0 0 100px; }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /safe/);
  assert.doesNotMatch(out, /hugs its content/);
});

test('[regression container] a plain safe case (flex:1) passes', () => {
  const { code, out } = runGate(CONTAIN_GATE, {
    'ds-config.json': CONTAIN_CFG,
    // flex:1 ⇒ basis 0% (definite) ⇒ containment safe.
    'theme.css': `.full { display: inline-flex; container-type: inline-size; flex: 1; }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /safe/);
});

test('[regression container] inline-block with no definite width is flagged (invalid)', () => {
  const { code, out } = runGate(CONTAIN_GATE, {
    'ds-config.json': CONTAIN_CFG,
    'theme.css': `.chip { display: inline-block; container-type: inline-size; }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /"\.chip"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) component-selector-check.mjs
// ─────────────────────────────────────────────────────────────────────────────
const SELECTOR_GATE = 'component-selector-check.mjs';
const SELECTOR_CFG = { paths: { themeCSS: 'theme.css' } };
// `listItem` is a built-in KNOWN_COMPONENTS prefix, so no contract file is needed.

test('[bugfix selector] a state var written var( --listItem-bg-selected ) (space) is detected', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SELECTOR_CFG,
    // Non-state selector (.list-item has no "selected") ⇒ mis-scoped state var.
    'theme.css': `.list-item { color: var( --listItem-bg-selected ); }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /--listItem-bg-selected/);
  assert.match(out, /🚨/);
});

test('[regression selector] the same var without a space is still detected (invalid)', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SELECTOR_CFG,
    'theme.css': `.list-item { color: var(--listItem-bg-selected); }`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /--listItem-bg-selected/);
});

test('[regression selector] a correctly-scoped state selector passes (valid)', () => {
  const { code, out } = runGate(SELECTOR_GATE, {
    'ds-config.json': SELECTOR_CFG,
    'theme.css': `.list-item.selected { color: var(--listItem-bg-selected); }`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /All state vars appear inside matching state selectors/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) structure-check.mjs (Gate [3c] phantom borders + array-themeCSS resilience)
// ─────────────────────────────────────────────────────────────────────────────
const STRUCT_GATE = 'structure-check.mjs';
// A minimal contract: one non-structural component (skips the snapshot cross-check) whose
// only job is to give the phantom gate a base selector to scan.
const STRUCT_CONTRACT =
  `export const CONTRACT = { widget: {} };\n` +
  `export const COMPONENT_CSS_SELECTORS = { widget: { main: '.widget' } };\n`;

function structFixture({ themeCSS, snapComp, extra = {} }) {
  return {
    'ds-config.json': { paths: { themeCSS, snapshotStructure: 'snap.json' } },
    'snap.json': { components: { widget: snapComp } },
    'structure-contract.mjs': STRUCT_CONTRACT,
    ...extra,
  };
}

test('[bugfix structure] border-color:transparent + border-left:solid is flagged when Figma has no stroke', () => {
  const { code, out } = runGate(STRUCT_GATE, structFixture({
    themeCSS: 'theme.css',
    snapComp: { strokeOnAnyState: false },
    extra: { 'theme.css': `:root {}\n.widget { border-color: transparent; border-left: 3px solid red; }` },
  }));
  assert.equal(code, 1, out);
  assert.match(out, /Gate \[3c\]/);          // phantom-border section header
  assert.match(out, /border-left/);           // the visible side border, not the transparent one
  assert.doesNotMatch(out, /TypeError/, out);
});

test('[regression structure] a no-stroke component with only border-color:transparent passes (valid)', () => {
  const { code, out } = runGate(STRUCT_GATE, structFixture({
    themeCSS: 'theme.css',
    snapComp: { strokeOnAnyState: false },
    extra: { 'theme.css': `:root {}\n.widget { border-color: transparent; }` },
  }));
  assert.equal(code, 0, out);
  assert.match(out, /All structural checks pass/);
});

test('[regression structure] a no-stroke component with a real border is flagged (invalid)', () => {
  const { code, out } = runGate(STRUCT_GATE, structFixture({
    themeCSS: 'theme.css',
    snapComp: { strokeOnAnyState: false },
    extra: { 'theme.css': `:root {}\n.widget { border: 1px solid red; }` },
  }));
  assert.equal(code, 1, out);
  assert.match(out, /Gate \[3c\]/);
});

test('[bugfix structure] array themeCSS resolves without crashing; a strokeful component keeps its border', () => {
  const { code, out } = runGate(STRUCT_GATE, structFixture({
    themeCSS: ['theme.css', 'extra.css'],           // array form - used to crash
    snapComp: { strokeOnAnyState: true },            // Figma strokes it ⇒ CSS border allowed
    extra: {
      'theme.css': `:root {}\n.widget { border: 1px solid var(--widget-border); }`,
      'extra.css': `.extra { color: red; }`,
    },
  }));
  // The identical `.widget { border ... }` rule fails on a no-stroke component (test above);
  // here it passes, which proves the strokeful component is permitted its border.
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, out);
  assert.match(out, /All structural checks pass/);
  assert.match(out, /no phantom CSS borders/);
});
