// test/reimplementation.test.mjs - regression tests for the local-reimplementation gate.
//
// The gate (reimplementation-check.mjs) flags an interactive element of a role the DS OWNS that is
// locally styled to look like the DS component but does NOT use the DS component class. It is
// opt-in (no reimplementationSurfaces → PASS), advisory by default (PASS), hard-fail under
// reimplementationStrict, and inert when the DS defines no component for the role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, crashed } from './helpers.mjs';

const GATE = 'reimplementation-check.mjs';

// A DS that owns a button component (ButtonPrimary → .buttonPrimary).
const DS = { componentSelectors: { ButtonPrimary: '.buttonPrimary' } };

// A surface with a hand-styled native button (local class carries visual CSS).
const handRolled =
  `<button class="save-btn">Save</button>\n` +
  `<style>.save-btn { background: #06c; border-radius: 6px; padding: 8px 12px; }</style>\n`;
// A surface that correctly uses the DS button class.
const usesDs =
  `<button class="buttonPrimary">Save</button>\n` +
  `<style>.buttonPrimary { background: var(--btn-bg); }</style>\n`;
// A bare native button with no local styling — a utility/reset, not a simulated component.
const bareButton = `<button class="icon-only" aria-label="Close"></button>\n`;

test('[reimplementation] no reimplementationSurfaces configured → no-op PASS', () => {
  const { code, out } = runGate(GATE, { 'ds-config.json': { ...DS } });
  assert.equal(code, 0, out);
  assert.match(out, /no reimplementationSurfaces configured/);
});

test('[reimplementation] a hand-styled <button> not using the DS class → advisory PASS', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'] },
    'ui.html': handRolled,
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 0, `advisory must not fail by default:\n${out}`);
  assert.match(out, /save-btn/);
});

test('[reimplementation] the same hand-styled button → FAIL under reimplementationStrict', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'], reimplementationStrict: true },
    'ui.html': handRolled,
  });
  assert.equal(code, 1, `strict must fail:\n${out}`);
  assert.match(out, /save-btn/);
});

test('[reimplementation] a button that uses the DS class → PASS (no finding)', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'], reimplementationStrict: true },
    'ui.html': usesDs,
  });
  assert.equal(code, 0, out);
  assert.match(out, /no local component reimplementation/);
});

test('[reimplementation] a bare unstyled button is not flagged', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'], reimplementationStrict: true },
    'ui.html': bareButton,
  });
  assert.equal(code, 0, `a bare button must not be flagged:\n${out}`);
});

test('[reimplementation] the DS defines no button component → PASS (nothing to reimplement)', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { reimplementationSurfaces: ['ui.html'], componentSelectors: { Card: '.card' } },
    'ui.html': handRolled,
  });
  assert.equal(code, 0, out);
  assert.match(out, /nothing to reimplement/);
});

test('[reimplementation] a known exemption silences the finding', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'], reimplementationStrict: true, knownReimplementations: ['ui.html#.save-btn'] },
    'ui.html': handRolled,
  });
  assert.equal(code, 0, `exempted finding must not fail:\n${out}`);
});

test('[reimplementation] an inline-styled look-alike button is flagged', () => {
  const { code, out } = runGate(GATE, {
    'ds-config.json': { ...DS, reimplementationSurfaces: ['ui.html'] },
    'ui.html': `<button style="background:#06c;border-radius:6px;padding:8px">Go</button>\n`,
  });
  assert.ok(!crashed(out), out);
  assert.match(out, /reimplementation/);
});
