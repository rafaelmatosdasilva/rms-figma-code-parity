// Dedicated regression tests for three fixes that previously had only gate-level coverage:
//   A5 - structure-check strips /* */ comments from the theme CSS before base-rule var matching
//   A8 - parity-check resolveCSSAlias accepts a var(--x, fallback) hop
//   B3 - bound-check orphan report reads snapshot tokens across ALL modes (not hardcoded light)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

// ── A5 ────────────────────────────────────────────────────────────────────────
// A minimal non-structural contract (one empty component) so structure-check actually runs
// (it skips when CONTRACT is empty), with a base-rule-var assertion on that component.
const A5_CONTRACT =
  "export const CONTRACT = { badge: {} };\n" +
  "export const COMPONENT_CSS_SELECTORS = { badge: { main: '.badge' } };\n" +
  "export const CSS_BASE_RULE_VARS = [{ selector: '.badge', prop: 'background', expectedVar: '--badge-bg', key: 'badge/bg' }];\n";
const a5Files = (themeCss) => ({
  'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 'snap.json' } },
  'snap.json': { components: { badge: {} } },
  'structure-contract.mjs': A5_CONTRACT,
  'theme.css': themeCss,
});

test('[bugfix A5] a commented-out var() before the live one is not read as the base-rule var', () => {
  const { code, out } = runGate('structure-check.mjs',
    a5Files(':root {}\n.badge { /* background: var(--old-bg); */ background: var(--badge-bg); }\n'));
  assert.equal(code, 0, out);          // old code matched --old-bg inside the comment -> VAR_FAIL
  assert.doesNotMatch(out, /old-bg/, out);
});

test('[regression A5] a genuinely wrong base-rule var still fails', () => {
  const { code, out } = runGate('structure-check.mjs',
    a5Files(':root {}\n.badge { background: var(--wrong-bg); }\n'));
  assert.equal(code, 1, out);
  assert.match(out, /badge/, out);
});

// ── A8 ────────────────────────────────────────────────────────────────────────
const a8Base = {
  'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' }, figma: { colorCollection: 'Color', modes: [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' }] } },
  'parity-map.mjs': 'export const EXPLICIT={};export const SKIP_TOKENS=new Set();',
};
const a8Snap = (primitiveVar) => ({
  'theme.css': `:root { --brand: var(${primitiveVar}, #3b82f6); ${primitiveVar}: #3b82f6; }\n`,
  'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#3b82f6' } }, aliases: { light: { 'brand/color': ['primitives/Blue 500'], brand: ['primitives/Blue 500'] } } },
});

test('[bugfix A8] a var(--x, fallback) alias chain is not a false ALIAS FAIL', () => {
  const { code, out } = runGate('parity-check.mjs', { ...a8Base, ...a8Snap('--blue-500') }, ['--json']);
  assert.equal(code, 0, out);          // old code parsed "--blue-500, #3b82f6" -> chain mismatch -> ALIAS FAIL
  assert.doesNotMatch(out, /ALIAS FAIL {2}[1-9]/, out);
});

test('[regression A8] a fallback routed through the WRONG primitive still fails', () => {
  const { code, out } = runGate('parity-check.mjs', { ...a8Base, ...a8Snap('--blue-400') }, ['--json']);
  assert.equal(code, 1, out);          // value still #3b82f6, but via --blue-400 not Figma's Blue 500
  assert.match(out, /ALIAS FAIL/, out);
});

// ── B3 ────────────────────────────────────────────────────────────────────────
test('[bugfix B3] an orphan-but-used token in a NON-light base mode is detected', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' },
      figma: { modes: [{ name: 'Base', snapshotKey: 'base', cssSelector: 'root' }, { name: 'Contrast', snapshotKey: 'contrast', cssSelector: 'dark-media' }] },
      orphanUsedStrict: true },
    'bound-tokens.json': { _updated: '2020-01-01' },      // no bound tokens -> all covered -> orphan path runs
    'figma-vars.snapshot.json': { color: { base: { 'accent/color': '#ff0000' } } },
    'theme.css': ':root { --accent: #ff0000; }\n',        // its CSS var is declared -> orphan-but-used
  });
  assert.equal(code, 1, out);          // old code read snap.color.light (empty) -> missed it -> exit 0
  assert.match(out, /ORPHAN-BUT-USED/, out);
});

test('[regression B3] the default light/dark path still detects an orphan-but-used token', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' }, orphanUsedStrict: true },
    'bound-tokens.json': { _updated: '2020-01-01' },
    'figma-vars.snapshot.json': { color: { light: { 'accent/color': '#ff0000' } } },
    'theme.css': ':root { --accent: #ff0000; }\n',
  });
  assert.equal(code, 1, out);
  assert.match(out, /ORPHAN-BUT-USED/, out);
});
