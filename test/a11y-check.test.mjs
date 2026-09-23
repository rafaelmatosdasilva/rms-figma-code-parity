// I18 accessibility gate — pure-core unit tests. The CDP/browser path can't run headless in CI,
// so this pins the real logic: WCAG contrast math, AA thresholds, rgba compositing, colour parsing,
// and the contrast-finding classifier. Importing a11y-check.mjs launches nothing (main() is guarded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, over, effectiveBg, relLuminance, contrastRatio,
  isLargeText, aaThreshold, contrastFindings, INTERACTIVE_ROLES,
  styleguideTarget,
} from '../a11y-check.mjs';

const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ── styleguideTarget (I35): the generated-styleguide render target ──
test('[styleguide] returns the target when the file exists (default path)', () => {
  const t = styleguideTarget({}, '/proj', (p) => p === '/proj/apps/styleguide/index.html');
  assert.equal(t.label, 'apps/styleguide/index.html');
  assert.equal(t.styleguide, true);
  assert.ok(t.url.startsWith('file://'));
});
test('[styleguide] null when the file is absent', () => {
  assert.equal(styleguideTarget({}, '/proj', () => false), null);
});
test('[styleguide] honours a custom styleguide.out', () => {
  const t = styleguideTarget({ styleguide: { out: 'dist/sg.html' } }, '/proj', (p) => p === '/proj/dist/sg.html');
  assert.equal(t.label, 'dist/sg.html');
});
test('[styleguide] opt-out via a11y.styleguide:false', () => {
  assert.equal(styleguideTarget({ a11y: { styleguide: false } }, '/proj', () => true), null);
});

test('contrastRatio: black on white is 21, white on white is 1', () => {
  assert.ok(approx(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21));
  assert.ok(approx(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1));
});

test('parseColor handles rgb / rgba / transparent, rejects keywords', () => {
  assert.deepEqual(parseColor('rgb(0, 0, 0)'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(parseColor('red'), null);            // keyword / non-rgb → cannot compute
  assert.equal(parseColor('color(display-p3 1 0 0)'), null);
});

test('effectiveBg composites a translucent element bg over its opaque ancestor', () => {
  // nearest-first: element bg black@50% over an opaque white ancestor → mid grey
  const bg = effectiveBg(['rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']);
  assert.ok(approx(bg.r, 127.5, 0.5) && approx(bg.g, 127.5, 0.5) && approx(bg.b, 127.5, 0.5));
  // no layers → white canvas default
  assert.deepEqual(effectiveBg([]), { r: 255, g: 255, b: 255 });
});

test('isLargeText / aaThreshold follow WCAG (>=24px, or >=18.66px bold)', () => {
  assert.equal(isLargeText(24, '400'), true);
  assert.equal(isLargeText(18.66, '700'), true);
  assert.equal(isLargeText(18, '700'), false);
  assert.equal(isLargeText(23, '400'), false);
  assert.equal(isLargeText(19, 'bold'), true);
  assert.equal(aaThreshold(16, '400'), 4.5);
  assert.equal(aaThreshold(30, '400'), 3);
});

test('contrastFindings flags #777 on white as normal-text fail but passes it as large text', () => {
  const el = (fontSize, fontWeight) => ({ desc: 'span.label', text: 'Hi', color: 'rgb(119,119,119)', bgLayers: ['rgb(255,255,255)'], fontSize, fontWeight, bgImage: false });
  const normal = contrastFindings([el(16, '400')], 'Light');
  assert.equal(normal.length, 1);
  assert.equal(normal[0].threshold, 4.5);
  assert.ok(normal[0].ratio < 4.5);
  const large = contrastFindings([el(30, '400')], 'Light');
  assert.equal(large.length, 0, 'ratio ~4.48 clears the 3:1 large-text bar');
});

test('contrastFindings reports a gradient/image background as cannot-compute, not a fail', () => {
  const out = contrastFindings([{ desc: 'div.hero', text: 'X', color: 'rgb(0,0,0)', bgLayers: [], fontSize: 16, fontWeight: '400', bgImage: true }], 'Dark');
  assert.equal(out.length, 1);
  assert.equal(out[0].cannotCompute, 'background-image/gradient');
  assert.equal(out[0].ratio, undefined);
});

test('a good pair produces no finding', () => {
  const out = contrastFindings([{ desc: 'p', text: 'ok', color: 'rgb(0,0,0)', bgLayers: ['rgb(255,255,255)'], fontSize: 16, fontWeight: '400', bgImage: false }], 'Light');
  assert.equal(out.length, 0);
});

test('INTERACTIVE_ROLES covers the classic controls', () => {
  for (const r of ['button', 'link', 'textbox', 'checkbox', 'tab']) assert.ok(INTERACTIVE_ROLES.has(r));
  assert.equal(INTERACTIVE_ROLES.has('paragraph'), false);
});

test('relLuminance is monotonic (black < grey < white)', () => {
  assert.ok(relLuminance({ r: 0, g: 0, b: 0 }) < relLuminance({ r: 119, g: 119, b: 119 }));
  assert.ok(relLuminance({ r: 119, g: 119, b: 119 }) < relLuminance({ r: 255, g: 255, b: 255 }));
  assert.deepEqual(over({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255 }), { r: 0, g: 0, b: 0 });
});
