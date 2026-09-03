// Regression tests for naming-check.mjs (Gate: no invented CSS variables) and its A4 fix:
// color tokens are now read across ALL configured modes, not just hardcoded light/dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, EMPTY_PARITY_MAP } from './helpers.mjs';

const GATE = 'naming-check.mjs';
const paths = { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' };

test('[bugfix A4] a color token in a NON-light/dark mode traces back (not "invented")', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths, figma: { modes: [
      { name: 'Day',   snapshotKey: 'day',   cssSelector: 'root' },
      { name: 'Night', snapshotKey: 'night', cssSelector: 'dark-media' },
    ] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }',
    'figma-vars.snapshot.json': { color: { day: { 'brand/color': '#ffffff' }, night: { 'brand/color': '#000000' } } },
  });
  // Old code read only snap.color.light/dark, so with day/night modes --brand looked invented → exit 1.
  assert.equal(code, 0, out);
});

test('[regression] the default light/dark axis still traces color vars back', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #ffffff; }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } },
  });
  assert.equal(code, 0, out);
});

test('[regression] a genuinely invented CSS var is still flagged', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { paths },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --totally-invented: #ff0000; }',
    'figma-vars.snapshot.json': { color: { light: { 'brand/color': '#ffffff' }, dark: {} } },
  });
  assert.equal(code, 1, out);
  assert.match(out, /totally-invented/);
});
