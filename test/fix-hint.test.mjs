// fix-hint.mjs - contract-aware fix citations (feature #1). Pure; no fs beyond loadTokensDict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenVar, resolveTokenValue, tokenSource } from '../fix-hint.mjs';

test('tokenVar applies the naming convention, tolerates junk', () => {
  assert.equal(tokenVar('radii/button'), '--radii-button');
  assert.equal(tokenVar('buttonPrimary/background/color'), '--buttonPrimary-background-color');
  assert.equal(tokenVar(''), null);
  assert.equal(tokenVar(null), null);
});

test('resolveTokenValue walks a DTCG dict to the $value leaf', () => {
  const dict = {
    radii: { button: { $type: 'dimension', $value: '8px' } },
    type: { heading: { $value: { fontSize: '24px', fontWeight: '700' } } },
  };
  assert.equal(resolveTokenValue(dict, 'radii/button'), '8px');
  assert.equal(resolveTokenValue(dict, 'radii.button'), '8px');            // dot form too
  assert.equal(resolveTokenValue(dict, 'type/heading'), '{"fontSize":"24px","fontWeight":"700"}');
  assert.equal(resolveTokenValue(dict, 'radii/missing'), null);            // no such leaf
  assert.equal(resolveTokenValue(dict, 'radii'), null);                    // a group, not a leaf
  assert.equal(resolveTokenValue(null, 'radii/button'), null);
});

test('tokenSource cites the verified value + file when the dict has it', () => {
  const dict = { radii: { button: { $value: '8px' } } };
  const withVal = tokenSource('radii/button', { dict, contractsDir: 'contracts' });
  assert.ok(withVal.includes("token 'radii/button'"));
  assert.ok(withVal.includes('var(--radii-button)'));
  assert.ok(withVal.includes('= 8px'));
  assert.ok(withVal.includes('contracts/tokens.json'));
});

test('tokenSource degrades to a pointer when the value cannot be resolved', () => {
  const degraded = tokenSource('spacing/lg', { dict: null, contractsDir: 'out/contracts' });
  assert.ok(degraded.includes("token 'spacing/lg'"));
  assert.ok(degraded.includes('var(--spacing-lg)'));
  assert.ok(degraded.includes('see out/contracts/tokens.json'));
  assert.ok(!degraded.includes('='));                                       // no invented value
  assert.equal(tokenSource('', { dict: null }), '');                        // nothing to cite
});
