// component-locator.mjs — the one answer to "which elements are component X", shared by every gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { createLocator, loadLocator, leadingToken } from '../component-locator.mjs';

test('resolution order: componentSelectors, then the contract selector map, then a selector-like name, then the convention', () => {
  const L = createLocator(
    { componentSelectors: { Tooltip: '#tooltip', segmentedControl: '.segmented button' } },
    { contractSelectors: { segmentedControl: { main: '.never-used' }, checkBox: { main: '.checkbox' } } },
  );
  assert.equal(L.selectorFor('Tooltip'), '#tooltip');
  assert.equal(L.sourceOf('Tooltip'), 'componentSelectors');
  assert.equal(L.selectorFor('segmentedControl'), '.segmented button');           // config beats the contract
  assert.equal(L.classFor('segmentedControl'), '.segmented');                     // leading token of a compound selector
  assert.equal(L.selectorFor('checkBox'), '.checkbox');                           // the contract, not ".checkBox"
  assert.equal(L.sourceOf('checkBox'), 'contract');
  assert.equal(L.selectorFor('.appWindow'), '.appWindow');                        // already a selector, never "..appWindow"
  assert.equal(L.selectorFor('ButtonSecondary'), '.buttonSecondary');             // the convention
  assert.equal(L.sourceOf('ButtonSecondary'), 'convention');
});

test('leadingToken picks the first class or id', () => {
  assert.equal(leadingToken('.a-b c .d'), '.a-b');
  assert.equal(leadingToken('#x > .y'), '#x');
  assert.equal(leadingToken('button'), null);
});

test('loadLocator reads COMPONENT_CSS_SELECTORS from the project contract, and survives a missing one', async () => {
  const dir = makeFixture({ 'ds-config.json': {} });
  assert.equal((await loadLocator(dir, {})).selectorFor('card'), '.card');
  writeFileSync(join(dir, 'structure-contract.mjs'), "export const COMPONENT_CSS_SELECTORS = { card: { main: '.card-box' } };\n");
  assert.equal((await loadLocator(dir, {})).selectorFor('card'), '.card-box');
});
