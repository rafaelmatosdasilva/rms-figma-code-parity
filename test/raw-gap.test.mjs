import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawGapMatches } from '../raw-gap.mjs';

test('flush (gap 0) accepts 0 and 0px, rejects a stray gap', () => {
  assert.equal(rawGapMatches('0', 0), true);
  assert.equal(rawGapMatches('0px', 0), true);
  assert.equal(rawGapMatches('4px', 0), false);        // the switch-content bug: DS flush, code gap/xs
  assert.equal(rawGapMatches('var(--gap-xs)', 0), false);
});

test('a raw px gap must match exactly, unit included', () => {
  assert.equal(rawGapMatches('4px', 4), true);
  assert.equal(rawGapMatches('8px', 4), false);
  assert.equal(rawGapMatches('4', 4), false);          // px unit required for a non-zero gap
});

test('a missing gap never matches', () => {
  assert.equal(rawGapMatches(null, 0), false);
  assert.equal(rawGapMatches(undefined, 4), false);
});
