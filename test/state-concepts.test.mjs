// I40: which interaction concept a state is, from ds-config states or, by default, the names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptOf } from '../state-concepts.mjs';
import { stateContrastFindings } from '../contrast-check.mjs';

test('concepts: declared props and values first, names otherwise; a false boolean is never the state', () => {
  assert.equal(conceptOf('State=Hover'), 'hover');
  assert.equal(conceptOf('State=Pressed'), 'active');
  assert.equal(conceptOf('State=Inactive'), 'disabled');
  assert.equal(conceptOf('isDisabled=True'), 'disabled');
  assert.equal(conceptOf('isDisabled=False'), null);
  const cfg = { states: { disabled: { prop: 'Status', value: 'Off' }, active: { prop: 'State', value: 'Down' } } };
  assert.equal(conceptOf('Status=Off', cfg), 'disabled');
  assert.equal(conceptOf('State=Down', cfg), 'active');
  assert.equal(conceptOf('State=Disabled', cfg), null);        // disabled is declared: its name alone is not enough
  assert.equal(conceptOf('State=Hover', cfg), 'hover');         // hover is not declared: read by name
});

test('state contrast skips the declared disabled state, however it is named', () => {
  const code = { components: { chip: { instance: { hasText: true }, props: { fontSize: { value: '12px' } },
    colors: { light: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)' } },
    states: { 'Status=Off': { produced: 'class .off', changed: { color: { value: 'rgb(240, 240, 240)' } } } } } } };
  assert.equal(stateContrastFindings(code).findings.length, 1);
  assert.equal(stateContrastFindings(code, { states: { disabled: { prop: 'Status', value: 'Off' } } }).findings.length, 0);
});
