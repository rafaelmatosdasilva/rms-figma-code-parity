import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModes, loadCollections, allModes, buildResolver } from '../mode-resolver.mjs';

// ── loadModes / loadCollections / allModes ───────────────────────────────────
test('loadModes falls back to light/dark when nothing configured', () => {
  assert.deepEqual(loadModes({}).map(m => m.snapshotKey), ['light', 'dark']);
});

test('loadCollections is empty unless declared, and normalises kind', () => {
  assert.deepEqual(loadCollections({}), []);
  const cfg = { figma: { collections: [
    { name: 'Breakpoint', modes: [{ name: 'Phone', snapshotKey: 'phone', cssSelector: 'root' }] },
    { name: 'Empty' }, // dropped: no modes
  ] } };
  const cols = loadCollections(cfg);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].kind, 'scalar'); // default
});

test('allModes unions color axis + collections, deduped by snapshotKey', () => {
  const cfg = { figma: {
    modes: [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
            { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' }],
    collections: [{ name: 'Breakpoint', kind: 'scalar', modes: [
      { name: 'Phone', snapshotKey: 'phone', cssSelector: 'root' },
      { name: 'Tablet', snapshotKey: 'tablet', cssSelector: 'media:(min-width: 768px)' },
    ] }],
  } };
  assert.deepEqual(allModes(cfg).map(m => m.snapshotKey), ['light', 'dark', 'phone', 'tablet']);
});

// ── resolve (hex) stays byte-identical to the 2-mode behaviour ────────────────
const COLOR_CSS = `
:root { --brand: #ff0000; --surface: var(--brand); }
@media (prefers-color-scheme: dark) { :root { --brand: #00ff00; } }
`;
const LD = [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
            { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' }];

test('resolve() returns lowercased hex and follows var() + media override', () => {
  const { resolve } = buildResolver(COLOR_CSS, LD);
  assert.equal(resolve('--brand', 'light'), '#ff0000');
  assert.equal(resolve('--brand', 'dark'), '#00ff00');
  assert.equal(resolve('--surface', 'light'), '#ff0000'); // alias
  assert.equal(resolve('--surface', 'dark'), '#00ff00');  // alias inherits dark override
  assert.equal(resolve('--missing', 'light'), null);
});

// ── resolveRaw returns scalars/strings, and generic media: selector works ─────
const SIZE_CSS = `
:root { --gap-m: 8px; --pad: var(--gap-m); --font: Inter; }
@media (min-width: 768px) { :root { --gap-m: 12px; } }
@media (min-width:1200px) { :root { --gap-m: 16px; } }
`;
const BP = [
  { name: 'Phone', snapshotKey: 'phone', cssSelector: 'root' },
  { name: 'Tablet', snapshotKey: 'tablet', cssSelector: 'media:(min-width: 768px)' },
  { name: 'Desktop', snapshotKey: 'desktop', cssSelector: 'media:(min-width: 1200px)' },
];

test('resolveRaw resolves scalars per breakpoint mode (mobile-first cascade)', () => {
  const { resolveRaw } = buildResolver(SIZE_CSS, BP);
  assert.equal(resolveRaw('--gap-m', 'phone'), '8px');    // base :root
  assert.equal(resolveRaw('--gap-m', 'tablet'), '12px');  // media override (spaced condition)
  assert.equal(resolveRaw('--gap-m', 'desktop'), '16px'); // media override (unspaced condition)
  assert.equal(resolveRaw('--pad', 'tablet'), '12px');    // alias inherits the override
});

test('resolveRaw returns string literals, resolve() returns null for non-hex', () => {
  const { resolve, resolveRaw } = buildResolver(SIZE_CSS, BP);
  assert.equal(resolveRaw('--font', 'phone'), 'Inter');
  assert.equal(resolve('--gap-m', 'phone'), null); // scalar is not a hex
});
