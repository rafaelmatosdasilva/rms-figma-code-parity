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
  // The base is read from :root (no light failure). In dark mode the LATER :root wins the cascade,
  // so a browser really shows #ffffff there: that is a real failure, and it is reported.
  assert.doesNotMatch(out, /\[color\/Light\]/, out);
  assert.match(out, /\[color\/Dark\] brand → --brand[\s\S]*Figma: #000000\s+CSS: #ffffff/, out);
  assert.equal(code, 1, out);
});

test('the theme is read like the browser: every :root block and @import count', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': '@import "brand.css";\n:root { --a: #111111; }\n:root { --b: #222222; }\n@media (prefers-color-scheme: dark) { :root { --a: #eeeeee; --b: #dddddd; --c: #cccccc; } }',
    'brand.css': ':root { --c: #333333; }',
    'figma-vars.snapshot.json': { color: { light: { 'a/color': '#111111', 'b/color': '#222222', 'c/color': '#333333' }, dark: { 'a/color': '#eeeeee', 'b/color': '#dddddd', 'c/color': '#cccccc' } } },
  });
  assert.equal(code, 0, out);
});

test('[bugfix media-mode] a generic media: color mode resolves its OWN override, not the base', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color', modes: [
      { name: 'Base', snapshotKey: 'base', cssSelector: 'root' },
      { name: 'Wide', snapshotKey: 'wide', cssSelector: 'media:(min-width: 768px)' },
    ] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }\n@media (min-width: 768px) { :root { --brand: #000000; } }',
    'figma-vars.snapshot.json': { color: { base: { 'brand/color': '#ffffff' }, wide: { 'brand/color': '#000000' } } },
  });
  // Old parser had no media: branch, fell through to new RegExp(selector), matched nothing, and
  // compared Wide against the BASE #ffffff → mismatch vs Figma #000000 → exit 1. The fix reads the
  // @media override (#000000) → match → exit 0.
  assert.equal(code, 0, out);
});

test('a token block under an ancestor of :root is still read, and listed as never applied by a browser', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { colorCollection: 'Color', modes: [
      { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
      { name: 'Contrast', snapshotKey: 'contrast', cssSelector: 'data:theme=contrast' },
    ] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }\n[data-theme="contrast"] :root { --brand: #000000; }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, contrast: { 'brand/color': '#000000' } } },
  });
  assert.equal(code, 0, out);
  assert.match(out, /NEVER APPLIED 1/);
  assert.match(out, /theme\.css:2\s+\[data-theme="contrast"\] :root\s+→ write :root\[data-theme="contrast"\]/);
});
