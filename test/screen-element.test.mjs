// screen-element.test.mjs — the Markup gate (Screen element completeness, Figma screen → code).
// A DS reference-screen control must have a code counterpart OF ITS KIND. The label merely
// appearing in the file (an id, a comment, a JS identifier) is NOT a counterpart — that is the
// exact blind spot this gate closes. Advisory by default; a fail under screenElementStrict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const GATE = 'screen-element-check.mjs';

function fixture({ elements, code, strict = false, exempt = [], plugin = 'p', rowSeparators }) {
  const files = {
    'ds-config.json': { screenElementStrict: strict, knownScreenElementExemptions: exempt },
    [`apps/${plugin}/ui.html`]: code,
  };
  if (elements) {
    const screen = { name: 'Screen', plugin, elements };
    if (rowSeparators != null) screen.rowSeparators = rowSeparators;
    files['figma-screens.snapshot.json'] = { _updated: '2026-01-01', screens: { '1:1': screen } };
  }
  return files;
}

test('[feature screen-el] a button whose label sits inside a <button> is IN CODE', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonPrimary', label: 'Save as default' }],
    code: '<button class="buttonPrimary"><span>Save as default</span></button>',
  }));
  assert.equal(code, 0, out);
  assert.match(out, /IN CODE\s+1/);
  assert.match(out, /MISSING\s+0/);
});

test('[regression screen-el] label only in an id / comment / JS identifier is MISSING (the Preflight gap)', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonSecondary', label: 'Preflight' }],
    code: '<div id="preflight-section"></div><!-- Preflight report --><script>function requestPreflight(){ const x = 1 > 0; }</script>',
  }));
  assert.equal(code, 0, out);          // advisory by default — does not block
  assert.match(out, /MISSING\s+1/);
  assert.match(out, /Preflight/);
  assert.match(out, /ADVISORY/);
});

test('[feature screen-el] the same gap is a hard FAIL under screenElementStrict', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonSecondary', label: 'Preflight' }],
    code: '<div id="preflight-section"></div>',
    strict: true,
  }));
  assert.equal(code, 1, out);
  assert.match(out, /MISSING\s+1/);
});

test('[regression screen-el] visible text of the WRONG kind is not a counterpart', () => {
  // "Preflight" is visible text, but not inside a button — a bare label is not the control.
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonSecondary', label: 'Preflight' }],
    code: '<span>Preflight</span>', strict: true,
  }));
  assert.equal(code, 1, out);
  assert.match(out, /has no button counterpart/);
});

test('[feature screen-el] a dynamic label set as a quoted JS string counts as present', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonPrimary', label: 'Scan selection' }],
    code: `<button class="buttonPrimary" id="scan"></button><script>btn.textContent = count > 0 ? 'Scan selection' : 'Scan file';</script>`,
    strict: true,
  }));
  assert.equal(code, 0, out);
  assert.match(out, /IN CODE\s+1/);
});

test('[regression screen-el] radioButton is classified as radio, not button (name contains "button")', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'radioButton', label: 'PDF CMYK Vector' }],
    code: '<div>nothing here</div>', strict: true,
  }));
  assert.equal(code, 1, out);
  assert.match(out, /has no radio counterpart/);   // radio, not button
});

test('[feature screen-el] a radio label inside a .radioButton is IN CODE', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'radioButton', label: 'PDF CMYK Vector' }],
    code: '<label class="radioButton"><span class="radioButton-label">PDF CMYK Vector</span></label>',
  }));
  assert.equal(code, 0, out);
  assert.match(out, /IN CODE\s+1/);
  assert.match(out, /MISSING\s+0/);
});

test('[feature screen-el] a deliberate different realization is silenced by an exemption', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonSecondary', label: 'Preflight' }],
    code: '<div id="preflight-section"></div>',
    exempt: ['p/Preflight'], strict: true,
  }));
  assert.equal(code, 0, out);
  assert.match(out, /MISSING\s+0/);
});

test('[feature screen-el] a button built with the WRONG DS variant is a MISMATCH (secondary vs tertiary)', () => {
  // The label IS hosted by a <button>, so the family match passes — but the design says
  // buttonTertiary and the code built buttonSecondary. That divergence must surface.
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonTertiary', label: 'Save as default' }],
    code: '<button class="buttonSecondary"><span>Save as default</span></button>',
  }));
  assert.equal(code, 0, out);                       // advisory by default
  assert.match(out, /MISMATCH\s+1/);
  assert.match(out, /MISSING\s+0/);                 // it IS built — not missing, just wrong variant
  assert.match(out, /built as \.buttonSecondary/);
});

test('[feature screen-el] a wrong-variant MISMATCH is a hard FAIL under screenElementStrict', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonTertiary', label: 'Save as default' }],
    code: '<button class="buttonSecondary"><span>Save as default</span></button>',
    strict: true,
  }));
  assert.equal(code, 1, out);
  assert.match(out, /MISMATCH\s+1/);
});

test('[feature screen-el] the right variant is IN CODE with no MISMATCH', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonTertiary', label: 'Save as default' }],
    code: '<button class="buttonTertiary"><span>Save as default</span></button>',
  }));
  assert.equal(code, 0, out);
  assert.match(out, /IN CODE\s+1/);
  assert.match(out, /MISMATCH\s+0/);
});

test('[regression screen-el] a neighbouring button of another class is not mistaken for the control', () => {
  // "Export PDF" sits in its own buttonPrimary; a buttonSecondary sibling precedes it. The check
  // must read the ENCLOSING <button>, not the nearest class in a character window.
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'buttonPrimary', label: 'Export PDF' }],
    code: '<button class="buttonSecondary"><span>Save as default</span></button>'
        + '<button class="buttonPrimary"><span>Export PDF</span></button>',
    strict: true,
  }));
  assert.equal(code, 0, out);                       // no false MISMATCH
  assert.match(out, /IN CODE\s+1/);
  assert.match(out, /MISMATCH\s+0/);
});

test('[feature screen-el] fewer dividerLines than the design places between rows is a SEP GAP', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'switch', label: 'Crop marks' }],
    code: '<label class="switch"><span>Crop marks</span></label><div class="dividerLine"></div>',
    rowSeparators: 3,
  }));
  assert.equal(code, 0, out);                       // advisory by default
  assert.match(out, /SEP GAP\s+1/);
  assert.match(out, /design places 3 row-separator\(s\).*renders 1/);
});

test('[feature screen-el] a SEP GAP is a hard FAIL under screenElementStrict', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'switch', label: 'Crop marks' }],
    code: '<label class="switch"><span>Crop marks</span></label><div class="dividerLine"></div>',
    rowSeparators: 3, strict: true,
  }));
  assert.equal(code, 1, out);
  assert.match(out, /SEP GAP\s+1/);
});

test('[feature screen-el] enough separators (dividerLine or <hr>) closes the SEP GAP', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'switch', label: 'Crop marks' }],
    code: '<label class="switch"><span>Crop marks</span></label><div class="dividerLine"></div><hr>',
    rowSeparators: 2, strict: true,
  }));
  assert.equal(code, 0, out);
  assert.match(out, /SEP GAP\s+0/);
});

test('[feature screen-el] inert when no snapshot exists', () => {
  const { code, out } = runGate(GATE, fixture({ elements: null, code: '<div></div>' }));
  assert.equal(code, 0, out);
  assert.match(out, /skipped/i);
});

test('[feature screen-el] decorative components (dividerLine, badge) are not required', () => {
  const { code, out } = runGate(GATE, fixture({
    elements: [{ component: 'dividerLine', label: '' }, { component: 'badge', label: 'New' }],
    code: '<div></div>', strict: true,
  }));
  assert.equal(code, 0, out);
  assert.match(out, /MISSING\s+0/);
});
