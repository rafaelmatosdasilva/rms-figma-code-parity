// contrast-check.mjs - token-level WCAG contrast (I28), no browser. Pure math on token values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, tokenContrastFindings } from '../contrast-check.mjs';

test('hexToRgb parses 3/6/8-digit hex, rejects junk', () => {
  assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb('#0a84ff'), { r: 10, g: 132, b: 255 });
  assert.deepEqual(hexToRgb('#0a84ff80'), { r: 10, g: 132, b: 255 });   // alpha ignored
  assert.equal(hexToRgb('teal'), null);
  assert.equal(hexToRgb(null), null);
});

test('flags a pair below AA, passes a strong pair, and large text has a looser bar', () => {
  const values = { 'text/muted': '#777777', 'text/strong': '#000000', 'bg/surface': '#ffffff' };
  const resolve = (t) => values[t] ?? null;
  const { findings, checked } = tokenContrastFindings([
    { text: 'text/strong', bg: 'bg/surface' },                 // 21:1 → pass
    { text: 'text/muted', bg: 'bg/surface' },                  // ~4.48:1 → fail normal
    { text: 'text/muted', bg: 'bg/surface', large: true },     // ~4.48:1 → pass large (>=3)
  ], resolve);
  assert.equal(checked, 3);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].text, 'text/muted');
  assert.ok(findings[0].ratio < 4.5 && findings[0].threshold === 4.5);
});

test('unresolvable tokens are skipped, not failed', () => {
  const { findings, checked, skipped } = tokenContrastFindings(
    [{ text: 'nope', bg: 'alsoNope' }], () => null);
  assert.deepEqual(findings, []);
  assert.equal(checked, 0);
  assert.equal(skipped, 1);
});
