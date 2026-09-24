// css-values.mjs: two spellings of the same value compare equal, and the gates that use it stop
// reporting spelling differences as design differences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorHex, sameColor, lengthPx, timeMs, sameValue, sameEasing } from '../css-values.mjs';
import { runGate, EMPTY_PARITY_MAP } from './helpers.mjs';

test('colours: every CSS spelling reads as the same hex', () => {
  assert.equal(colorHex('#FFF'), '#ffffff');
  assert.equal(colorHex('#ffffff80'), '#ffffff80');
  assert.equal(colorHex('rgb(255 0 0 / 50%)'), '#ff000080');
  assert.equal(colorHex('rgba(0, 0, 0, 0.5)'), '#00000080');
  assert.equal(colorHex('hsl(120, 100%, 25%)'), '#008000');
  assert.equal(colorHex('oklch(62.8% 0.2577 29.23)'), '#ff0000');
  assert.equal(colorHex('color(srgb 1 0 0 / 0.5)'), '#ff000080');
  assert.equal(colorHex('color(display-p3 1 0 0)'), null);   // not converted: the caller reports it
  assert.equal(sameColor('#0055ff', 'rgb(0, 85, 255)'), true);
  assert.equal(sameColor('#0055ff', '#0055fe'), true);          // within rounding
  assert.equal(sameColor('#0055ff', '#0055f0'), false);
});

test('lengths and times: rem, calc(), pt, unitless Figma floats; ms and s', () => {
  assert.equal(lengthPx('0.5rem'), 8);
  assert.equal(lengthPx('calc(1rem + 4px)'), 20);
  assert.equal(lengthPx('12pt'), 16);
  assert.equal(lengthPx('8'), null);
  assert.equal(lengthPx('8', { unitless: true }), 8);
  assert.equal(timeMs('0.2s'), 200);
  assert.equal(sameValue('0.5rem', '8px', 'length'), true);
  assert.equal(sameValue('8', '8px', 'length'), true);
  assert.equal(sameValue('1.5', '1.5px', 'any'), null);          // a unitless line height is not 1.5px
  assert.equal(sameValue('200ms', '0.2s', 'time'), true);
  assert.equal(sameEasing('ease-in-out', 'cubic-bezier(.42, 0, .58, 1)'), true);
  assert.equal(sameEasing('ease', 'linear'), false);
});

const paths = { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' };
test('Gate 3: short hex and rgb() tokens match the Figma hex; a real difference still fails', () => {
  const ok = runGate('parity-check.mjs', {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #FFF; --ink: rgb(17 17 17); }\n@media (prefers-color-scheme: dark) { :root { --brand: #000; --ink: hsl(0 0% 93.3%); } }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff', 'ink/color': '#111111' }, dark: { 'brand/color': '#000000', 'ink/color': '#eeeeee' } } },
  });
  assert.equal(ok.code, 0, ok.out);
  const bad = runGate('parity-check.mjs', {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: rgb(250 250 250); }\n@media (prefers-color-scheme: dark) { :root { --brand: #000; } }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } },
  });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /Figma: #ffffff\s+CSS: #fafafa/);
});

test('Gate 3: a sizing token written in rem matches the Figma px value', () => {
  const r = runGate('parity-check.mjs', {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --padding-s: 0.5rem; --radius-m: 8px; }',
    'figma-vars.snapshot.json': { color: { light: {} }, sizing: { 'padding/s': '8px', 'radius/m': '8' } },
  });
  assert.doesNotMatch(r.out, /\[sizing\/-\]/, r.out);
});

test('Motion: 0.2s matches 200ms, and a keyword easing matches its curve', () => {
  const r = runGate('motion-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' }, figma: { motion: {} } },
    'theme.css': ':root { --duration-fast: 0.2s; --easing-standard: ease-in-out; }',
    'figma-vars.snapshot.json': { motion: { 'duration/fast': '200ms', 'easing/standard': 'cubic-bezier(0.42, 0, 0.58, 1)' } },
  });
  assert.match(r.out, /MATCH\s+2/, r.out);
  assert.equal(r.code, 0, r.out);
});
