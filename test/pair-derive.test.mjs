// pair-derive.mjs - derive text/bg contrast pairs from token names (I14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveContrastPairs } from '../pair-derive.mjs';

test('pairs text with the background sharing its qualifier (state or variant)', () => {
  const pairs = deriveContrastPairs([
    'badge/label/negative/color', 'badge/background/negative/color',
    'badge/label/positive/color', 'badge/background/positive/color',
    'buttonList/text/hover/color', 'buttonList/background/hover/color',
  ]);
  const by = (t) => pairs.find((p) => p.text === t);
  assert.equal(by('badge/label/negative/color').bg, 'badge/background/negative/color');
  assert.equal(by('badge/label/positive/color').bg, 'badge/background/positive/color');
  assert.equal(by('buttonList/text/hover/color').bg, 'buttonList/background/hover/color');
});

test('falls back to the default / only background when the qualifier has no match', () => {
  const pairs = deriveContrastPairs([
    'buttonSecondary/text/color', 'buttonSecondary/background/default/color',
    'buttonPrimary/iconText/color', 'buttonPrimary/background/color',
  ]);
  assert.equal(pairs.find((p) => p.text === 'buttonSecondary/text/color').bg, 'buttonSecondary/background/default/color');
  assert.equal(pairs.find((p) => p.text === 'buttonPrimary/iconText/color').bg, 'buttonPrimary/background/color');
});

test('icon/stroke roles are non-text (large = 3:1); text/label are normal (4.5)', () => {
  const pairs = deriveContrastPairs([
    'badge/icon/neutral/color', 'badge/label/neutral/color', 'badge/background/neutral/color',
  ]);
  assert.equal(pairs.find((p) => p.text === 'badge/icon/neutral/color').large, true);
  assert.equal(pairs.find((p) => p.text === 'badge/label/neutral/color').large, false);
});

test('skips components with no background, non-color tokens, and dedupes', () => {
  const pairs = deriveContrastPairs([
    'tooltip/text/color',                 // no tooltip background -> skipped (never invent the surface)
    'panel/padding/lr',                   // not a /color token -> ignored
    'card/text/color', 'card/background/color',
    'card/text/color', 'card/background/color',   // duplicate input -> one pair
  ]);
  assert.ok(!pairs.some((p) => p.text === 'tooltip/text/color'));
  assert.equal(pairs.filter((p) => p.text === 'card/text/color').length, 1);
  assert.deepEqual(deriveContrastPairs([]), []);
});
