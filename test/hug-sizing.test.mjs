// hug-sizing.test.mjs — Gate [10]/[3] `sizing: 'hug'` skips the exact-height contract↔snapshot
// comparison for a content-hugging component (its captured `h` is a measurement that drifts with
// content and has no fixed code height to enforce), while a `fixed` (default) component still fails
// on any height mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const GATE = 'structure-check.mjs';

function fixture(contract, snapComponents) {
  return {
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 'snap.json' } },
    'theme.css': ':root{}\n',
    'snap.json': { components: snapComponents },
    'structure-contract.mjs': `export const CONTRACT = ${JSON.stringify(contract)};\n`,
  };
}

test('[feature hug] a sizing:hug component does NOT fail when its captured height differs', () => {
  const { out } = runGate(GATE, fixture(
    { badge: { h: 19, sizing: 'hug', strokeOnDefault: false } },
    { badge: { h: 99, strokeOnDefault: false } },   // re-measured taller — must be ignored
  ));
  assert.doesNotMatch(out, /badge\.h/, out);   // no h divergence reported for the hug component
});

test('[regression hug] a fixed (default) component STILL fails on a height mismatch', () => {
  const { code, out } = runGate(GATE, fixture(
    { box: { h: 40, strokeOnDefault: false } },   // no sizing → fixed
    { box: { h: 99, strokeOnDefault: false } },
  ));
  assert.equal(code, 1, out);
  assert.match(out, /box\.h/, out);
});

test('[feature hug] non-height fields are still compared on a hug component', () => {
  const { code, out } = runGate(GATE, fixture(
    { badge: { h: 19, sizing: 'hug', strokeOnDefault: false } },
    { badge: { h: 19, strokeOnDefault: true } },   // stroke drifted — must still be caught
  ));
  assert.equal(code, 1, out);
  assert.match(out, /badge\.strokeOnDefault/, out);
});
