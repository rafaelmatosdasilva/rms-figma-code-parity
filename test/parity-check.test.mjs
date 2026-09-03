// Regression tests for parity-check.mjs (Gate: token values) and its A2 fix: the data:
// mode selector now matches whether the CSS writes [data-theme=…] or [theme=…].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, EMPTY_PARITY_MAP } from './helpers.mjs';

const GATE = 'parity-check.mjs';
const paths = { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' };

test('[regression] a color token whose CSS var matches Figma passes', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }\n@media (prefers-color-scheme: dark) { :root { --brand: #000000; } }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } },
  });
  assert.equal(code, 0, out);
});

test('[regression] a color token whose CSS var diverges from Figma fails', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #123456; }\n@media (prefers-color-scheme: dark) { :root { --brand: #000000; } }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } },
  });
  assert.equal(code, 1, out);
});

test('[bugfix A2] a data-attribute mode override written [data-theme] is found', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color', modes: [
      { name: 'Light',    snapshotKey: 'light',    cssSelector: 'root' },
      { name: 'Contrast', snapshotKey: 'contrast', cssSelector: 'data:theme=contrast' },
    ] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }\n[data-theme="contrast"] :root { --brand: #000000; }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, contrast: { 'brand/color': '#000000' } } },
  });
  // Old code built [theme=…] only, missed [data-theme=…], read base #ffffff for contrast → mismatch → exit 1.
  assert.equal(code, 0, out);
});

test('[bugfix base-root] a dark @media block above the base :root does not poison base parity', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    // dark @media FIRST, base :root SECOND - old code read the base from the @media block.
    'theme.css': '@media (prefers-color-scheme: dark) { :root { --brand: #000000; } }\n:root { --brand: #ffffff; }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } },
  });
  assert.equal(code, 0, out);
});
