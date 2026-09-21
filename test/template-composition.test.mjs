// test/template-composition.test.mjs - regression tests for the template-composition gate.
//
// The gate (template-composition-check.mjs) verifies that each registered TEMPLATE frame's code
// composes the DS components Figma composes - one level above the sub-component gate. It is:
//   - opt-in  (no ds-config.json → templates[] ⇒ no-op PASS)
//   - inert   (templates configured but no snapshot yet ⇒ PASS, never a false fail)
//   - advisory for MISSING unless templateCompositionStrict; NO FILE always fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, crashed } from './helpers.mjs';

const GATE = 'template-composition-check.mjs';

// A template snapshot: { templates: { <name>: { name, nodeId, components } } }
const snap = (templates) => ({
  _updated: new Date().toISOString(),
  templates,
});

// Template code that uses Filters (via .filters selector) and SidePanel (via <SidePanel> tag).
const consultUsesBoth =
  `<template>\n  <div class="filters"></div>\n  <SidePanel />\n</template>\n` +
  `<script>import SidePanel from './SidePanel.vue'; export default { name: 'Consult' }</script>\n`;
// Template code that uses ONLY Filters - SidePanel is missing.
const consultUsesOne =
  `<template>\n  <div class="filters"></div>\n</template>\n` +
  `<script>export default { name: 'Consult' }</script>\n`;

test('[template-composition] no templates[] configured → no-op PASS', () => {
  const { code, out } = runGate(GATE, { 'ds-config.json': { paths: {} } });
  assert.equal(code, 0, out);
  assert.match(out, /no templates\[\] configured/);
});

test('[template-composition] templates configured but no snapshot → inert PASS', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Consult', nodeId: '1:2' }] },
  });
  assert.equal(code, 0, out);
  assert.match(out, /not found/);
});

test('[template-composition] every composed component used → PASS', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Consult', nodeId: '1:2' }] },
    'figma-templates.snapshot.json': snap({ Consult: { name: 'Consult', nodeId: '1:2', components: ['Filters', 'SidePanel'] } }),
    'src/Consult.vue': consultUsesBoth,
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, out);
  assert.match(out, /USES\s+2/);
});

test('[template-composition] a composed component missing from code → advisory PASS by default', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Consult', nodeId: '1:2' }] },
    'figma-templates.snapshot.json': snap({ Consult: { name: 'Consult', nodeId: '1:2', components: ['Filters', 'SidePanel'] } }),
    'src/Consult.vue': consultUsesOne,
  });
  assert.equal(code, 0, `advisory MISSING must not fail by default:\n${out}`);
  assert.match(out, /MISSING\s+1/);
  assert.match(out, /SidePanel/);
});

test('[template-composition] a composed component missing → FAIL under templateCompositionStrict', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Consult', nodeId: '1:2' }], templateCompositionStrict: true },
    'figma-templates.snapshot.json': snap({ Consult: { name: 'Consult', nodeId: '1:2', components: ['Filters', 'SidePanel'] } }),
    'src/Consult.vue': consultUsesOne,
  });
  assert.equal(code, 1, `strict MISSING must fail:\n${out}`);
  assert.match(out, /SidePanel/);
});

test('[template-composition] template with composed components but no code file → FAIL (NO FILE)', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Ghost', nodeId: '9:9' }] },
    'figma-templates.snapshot.json': snap({ Ghost: { name: 'Ghost', nodeId: '9:9', components: ['Filters'] } }),
    // no src/Ghost.* file exists
  });
  assert.equal(code, 1, `NO FILE must always fail:\n${out}`);
  assert.match(out, /NO FILE/);
});

test('[template-composition] does not crash on a bare/edge config', () => {
  const { out } = runGate(GATE, {
    'ds-config.json': { templates: [{ name: 'Consult', nodeId: '1:2' }] },
    'figma-templates.snapshot.json': snap({ Consult: { name: 'Consult', nodeId: '1:2', components: [] } }),
    'src/Consult.vue': consultUsesBoth,
  });
  assert.ok(!crashed(out), out);
});
