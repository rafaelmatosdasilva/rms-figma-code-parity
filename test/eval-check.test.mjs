// eval-check.mjs - DS-conformance core for evals (I7). Applies the gate failure modes to a
// candidate an agent produced: raw literals that should be tokens, invented vars, DS-class usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalConformance } from '../eval-check.mjs';

const ctx = { cssVars: new Set(['--color-bg', '--radii-button']), dsClasses: new Set(['.buttonPrimary']) };

test('a candidate that uses DS vars and classes is clean', () => {
  const code = '<button class="buttonPrimary" style="background: var(--color-bg); border-radius: var(--radii-button)">Go</button>';
  const r = evalConformance(code, ctx);
  assert.equal(r.metrics.clean, true, JSON.stringify(r.violations));
  assert.equal(r.metrics.dsClassesUsed, 1);
});

test('a raw color literal is flagged as a violation', () => {
  const r = evalConformance('<div style="background:#0a84ff">x</div>', ctx);
  assert.equal(r.metrics.clean, false);
  assert.ok(r.violations.some((v) => v.type === 'raw-color' && v.value === '#0a84ff'));
});

test('a raw dimension is flagged, but 0px is benign', () => {
  const r = evalConformance('<div style="padding: 13px; margin: 0px">x</div>', ctx);
  assert.equal(r.metrics.rawDimensions, 1);
  assert.ok(r.violations.some((v) => v.type === 'raw-dimension' && v.value === '13px'));
});

test('a fallback literal inside var() is NOT counted (the code went through a token)', () => {
  const r = evalConformance('<div style="color: var(--color-bg, #ffffff)">x</div>', ctx);
  assert.equal(r.metrics.rawColors, 0, JSON.stringify(r.violations));
  assert.equal(r.metrics.clean, true);
});

test('an unknown var is flagged as invented (only when the DS var universe is known)', () => {
  const bad = evalConformance('<div style="color: var(--totally-made-up)">x</div>', ctx);
  assert.ok(bad.violations.some((v) => v.type === 'invented-var' && v.value === '--totally-made-up'));
  // with no known var universe, provenance is not judged
  const noCtx = evalConformance('<div style="color: var(--whatever)">x</div>', {});
  assert.equal(noCtx.metrics.inventedVars, 0);
});

test('empty output reports produced:false', () => {
  const r = evalConformance('   ', ctx);
  assert.equal(r.metrics.produced, false);
});
