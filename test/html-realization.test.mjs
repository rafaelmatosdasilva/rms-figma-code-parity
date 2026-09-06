// html-realization.test.mjs — Gate [12] HTML-realization mode (frameworkComponents:false).
// Each Figma property must map to a code artifact (a CSS class/#id/element) or be an interaction
// state (Gate [11]); a mapped artifact absent from the source fails; unmapped is advisory (or a
// fail under htmlRealizationStrict).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const GATE = 'component-prop-check.mjs';

function fixture({ realizations = {}, strict = false, css = '' }) {
  return {
    'ds-config.json': {
      frameworkComponents: false,
      htmlRealization: true,
      htmlRealizationStrict: strict,
      htmlRealizations: realizations,
      paths: { snapshotVars: 'vars.json', pluginCSS: ['ui.html'] },
    },
    'vars.json': { _updated: '2026-01-01' },
    'figma-component-props.snapshot.json': {
      Button: { properties: {
        'show-icon#1:1':      { type: 'BOOLEAN' },
        'label-content#1:2':  { type: 'TEXT' },
        'state#1:3':          { type: 'VARIANT', variantOptions: ['default', 'hover'] },
      } },
    },
    'ui.html': css,
  };
}

test('[feature realization] a mapped-and-present artifact is REALIZED; a state prop is VIA STATE', () => {
  const { code, out } = runGate(GATE, fixture({
    css: '.button-icon { color: red } .button-label { color: blue }',
    realizations: { Button: { 'show-icon': '.button-icon', 'label-content': '.button-label' } },
  }));
  assert.equal(code, 0, out);
  assert.match(out, /REALIZED\s+2/);
  assert.match(out, /VIA STATE\s+1/);   // `state` → Gate [11], not a prop
});

test('[regression realization] a mapped artifact MISSING from the source fails', () => {
  const { code, out } = runGate(GATE, fixture({
    css: '.button-icon { color: red }',   // .button-label is absent
    realizations: { Button: { 'show-icon': '.button-icon', 'label-content': '.button-label' } },
  }));
  assert.equal(code, 1, out);
  assert.match(out, /UNREALIZED\s+1/);
  assert.match(out, /label-content/);
});

test('[feature realization] an unmapped property is advisory (pass) but FAILS under strict', () => {
  const lenient = runGate(GATE, fixture({ css: '.button-icon{}', realizations: { Button: { 'show-icon': '.button-icon' } } }));
  assert.equal(lenient.code, 0, lenient.out);
  assert.match(lenient.out, /UNMAPPED\s+1/);   // label-content unmapped, advisory

  const strict = runGate(GATE, fixture({ strict: true, css: '.button-icon{}', realizations: { Button: { 'show-icon': '.button-icon' } } }));
  assert.equal(strict.code, 1, strict.out);
});
