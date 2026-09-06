// html-composition.test.mjs — Gate [13] HTML mode (frameworkComponents:false).
// Each sub-component Figma nests must be realized as a class in the plugin source. Only parents
// actually built here are checked; icons are excluded (Gate [15]/[16]); a missing sub-component
// is advisory by default and a fail under htmlCompositionStrict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const GATE = 'component-composition-check.mjs';

function fixture({ nested, css, strict = false, html = '<div class="card"></div>' }) {
  return {
    'ds-config.json': {
      frameworkComponents: false, htmlRealization: true, htmlCompositionStrict: strict,
      paths: { pluginCSS: ['ui.html'], themeCSS: 'theme.css' },
    },
    'component-composition.snapshot.json': { _updated: '2026-01-01', card: nested },
    'ui.html': html,
    'theme.css': css,
  };
}

test('[feature composition] a nested sub-component present as a class is OK', () => {
  const { code, out } = runGate(GATE, fixture({ nested: ['badge'], css: '.card{} .badge{}' }));
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+1/);
  assert.match(out, /MISSING\s+0/);
});

test('[feature composition] icons are excluded (Gate 15/16), not flagged', () => {
  const { code, out } = runGate(GATE, fixture({ nested: ['Icon-plus'], css: '.card{}' }));
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+0/);
  assert.match(out, /MISSING\s+0/);
});

test('[regression composition] a nested sub-component with no class FAILS under strict', () => {
  const { code, out } = runGate(GATE, fixture({ nested: ['badge'], css: '.card{}', strict: true }));  // no .badge
  assert.equal(code, 1, out);
  assert.match(out, /MISSING\s+1/);
  assert.match(out, /badge/);
});

test('[feature composition] a parent not built in the source is skipped, not failed', () => {
  // Parent `card` appears nowhere (empty markup, unrelated CSS) → its composition is moot.
  const { code, out } = runGate(GATE, fixture({ nested: ['badge'], html: '<div></div>', css: '.badge{}', strict: true }));
  assert.equal(code, 0, out);
  assert.match(out, /SKIP\s+1/);
});
