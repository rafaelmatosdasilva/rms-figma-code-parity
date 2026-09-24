// structure-check.mjs reads CSS the way the browser applies it: padding side by side, logical
// properties, cascade layers, grouped selectors and nesting, and class names as whole tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const contract = `export const CONTRACT = { chip: { paddingVar: { tb: 'padding/s', lr: 'padding/m' }, gapVar: 'gap/s' } };
export const COMPONENT_CSS_SELECTORS = { chip: { main: '.chip' } };
export const FIGMA_LAYOUT_TO_CSS = { 'padding/s': '--padding-s', 'padding/m': '--padding-m', 'gap/s': '--gap-s' };`;
const files = (css, extra = {}) => ({
  'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 's.json', pluginCSS: ['app.css'] } },
  's.json': { components: { chip: { paddingVar: { tb: 'padding/s', lr: 'padding/m' }, gapVar: 'gap/s' } } },
  'app.css': '.x {}',
  'structure-contract.mjs': contract,
  'theme.css': ':root { --padding-s: 4px; --padding-m: 8px; --gap-s: 4px; }\n' + css,
  ...extra,
});
const bindings = (out) => out.match(/PASS\s+(\d+)\/(\d+) CSS property bindings/)?.slice(1).map(Number);

test('padding is checked side by side: a swapped shorthand fails', () => {
  const r = runGate('structure-check.mjs', files('.chip { padding: var(--padding-m) var(--padding-s); gap: var(--gap-s); }'));
  assert.match(r.out, /chip\/padding-tb: expected var\(--padding-s\) on top and bottom - got top var\(--padding-m\)/);
  assert.equal(r.code, 1);
});

test('logical padding, axis gaps and var() fallbacks count', () => {
  const r = runGate('structure-check.mjs', files('.chip { padding-block: var(--padding-s, 4px); padding-inline: var(--padding-m); column-gap: var(--gap-s); }'));
  assert.deepEqual(bindings(r.out), [3, 3], r.out);
});

test('the winning rule counts, not the longest: a later rule and an unlayered rule beat earlier ones', () => {
  const css = `@layer base { .chip { padding: var(--padding-m) var(--padding-m); gap: var(--gap-s); color: red; border: 0; } }
.chip { padding: var(--padding-s) var(--padding-m); }`;
  assert.deepEqual(bindings(runGate('structure-check.mjs', files(css)).out), [3, 3]);
});

test('grouped selectors and nesting are read', () => {
  const css = `.other, .chip { padding: var(--padding-s) var(--padding-m); }
.chip { & { gap: var(--gap-s); } }`;
  assert.deepEqual(bindings(runGate('structure-check.mjs', files(css)).out), [3, 3]);
});

test('script text in an HTML app file is never read as CSS', () => {
  const r = runGate('structure-check.mjs', files('.chip { padding: var(--padding-s) var(--padding-m); gap: var(--gap-s); }', {
    'app.css': null,
    'app.html': '<style>.y{}</style><script>const o = { ".chip": 1 }; if (x) { padding: 0 }</script>',
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 's.json', pluginCSS: ['app.html'] } },
  }));
  assert.deepEqual(bindings(r.out), [3, 3], r.out);
});
