// brand-check.mjs - multi-brand token coverage (I6). Opt-in, project-declared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandCoverage, resolveBrands } from '../brand-check.mjs';

test('flags a token defined in some brands but missing in others', () => {
  const r = brandCoverage({ light: ['bg', 'fg', 'accent'], bold: ['bg', 'fg'] });
  assert.deepEqual(r.missing, { accent: ['bold'] });
  assert.equal(r.tokenUniverse, 3);
  assert.deepEqual(r.brands, ['light', 'bold']);
});

test('a token in every brand is not a hole', () => {
  assert.deepEqual(brandCoverage({ a: ['x'], b: ['x'] }).missing, {});
});

test('accepts Sets as well as arrays', () => {
  const r = brandCoverage({ a: new Set(['x', 'y']), b: new Set(['x']) });
  assert.deepEqual(r.missing, { y: ['b'] });
});

test('resolveBrands: declared config wins', () => {
  const r = resolveBrands({ brands: ['brandA', 'brandB'] }, { collections: [{ name: 'Brand', role: 'brand', modes: ['x', 'y'] }] });
  assert.deepEqual(r.brands, ['brandA', 'brandB']);
  assert.equal(r.source, 'declared');
});

test('resolveBrands: derives from a captured collections manifest marked as brand', () => {
  const snap = { collections: [
    { name: 'Theme', modes: ['light', 'dark'] },
    { name: 'Brand', role: 'brand', modes: ['acme', 'globex'] },
  ] };
  const r = resolveBrands({}, snap);
  assert.deepEqual(r.brands, ['acme', 'globex']);
  assert.equal(r.source, 'collection:Brand');
});

test('resolveBrands: no declaration → suggests candidate multi-mode collections, never assumes', () => {
  const snap = { collections: [
    { name: 'Theme', modes: ['light', 'dark'] },
    { name: 'Density', modes: ['comfy', 'compact'] },
  ] };
  const r = resolveBrands({}, snap);
  assert.equal(r.brands, null);            // modes may be theme/density → never auto-classified
  assert.equal(r.suggest.length, 2);
  const noManifest = resolveBrands({}, {});
  assert.equal(noManifest.brands, null);
  assert.deepEqual(noManifest.suggest, []);
});
