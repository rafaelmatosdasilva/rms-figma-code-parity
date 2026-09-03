// Regression tests for the mode-resolver fixes (A6 snapshotKey derivation, A3 NEUTRAL_MAPS
// keying, A2 data: selector). These import the module directly - fast and exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModes, buildResolver, allModes } from '../mode-resolver.mjs';

// ── A6: loadModes must derive snapshotKey (parity-check tolerates omitting it) ──
test('[bugfix A6] loadModes derives snapshotKey from name when omitted', () => {
  const modes = loadModes({ figma: { modes: [
    { name: 'Day', cssSelector: 'root' },
    { name: 'High Contrast', cssSelector: 'high-contrast-media' },
  ] } });
  assert.deepEqual(modes.map(m => m.snapshotKey), ['day', 'high-contrast']);
});

test('[bugfix A6] allModes does not collapse distinct modes when snapshotKey omitted', () => {
  const modes = allModes({ figma: { modes: [
    { name: 'Day', cssSelector: 'root' },
    { name: 'Night', cssSelector: 'dark-media' },
  ] } });
  assert.equal(modes.length, 2);   // old code: both snapshotKey undefined → deduped to 1 (silent no-op)
});

test('[regression] an explicit snapshotKey is preserved', () => {
  const modes = loadModes({ figma: { modes: [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' }] } });
  assert.equal(modes[0].snapshotKey, 'light');
});

test('[regression] the legacy 2-mode default still yields light/dark', () => {
  assert.deepEqual(loadModes({}).map(m => m.snapshotKey), ['light', 'dark']);
});

// ── A3: NEUTRAL_MAPS may be keyed by mode NAME (as parity-map.mjs writes it) or index ──
const TWO_MODES = [
  { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
  { name: 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
];

test('[bugfix A3] NEUTRAL_MAPS keyed by mode NAME resolves a neutral primitive per mode', () => {
  const css = ':root { --fg: var(--neutral-300); }';
  const r = buildResolver(css, TWO_MODES, { NEUTRAL_MAPS: { Light: { '300': '#abcdef' }, Dark: { '300': '#111111' } } });
  assert.equal(r.resolve('--fg', 'light'), '#abcdef');   // old code: NEUTRAL_MAPS['light'] undefined → null
  assert.equal(r.resolve('--fg', 'dark'),  '#111111');
});

test('[bugfix A3] NEUTRAL_MAPS as an array (by index) resolves - mode-resolver had no array support', () => {
  const css = ':root { --fg: var(--neutral-300); }';
  const r = buildResolver(css, TWO_MODES, { NEUTRAL_MAPS: [{ '300': '#aaaaaa' }, { '300': '#bbbbbb' }] });
  assert.equal(r.resolve('--fg', 'light'), '#aaaaaa');
  assert.equal(r.resolve('--fg', 'dark'),  '#bbbbbb');
});

// ── A2: a data: mode override must resolve for both [data-attr] and [attr] CSS forms ──
test('[bugfix A2] data: override resolves whether the CSS writes [data-theme] or [theme]', () => {
  const MODES = loadModes({ figma: { modes: [
    { name: 'Light',    snapshotKey: 'light',    cssSelector: 'root' },
    { name: 'Contrast', snapshotKey: 'contrast', cssSelector: 'data:theme=contrast' },
  ] } });
  for (const sel of ['[data-theme="contrast"]', '[theme="contrast"]']) {
    const css = `:root { --fg: #000000; } ${sel} :root { --fg: #ffffff; }`;
    const r = buildResolver(css, MODES, {});
    assert.equal(r.resolve('--fg', 'contrast'), '#ffffff', `should match ${sel}`);
  }
});

test('[regression] a plain root/dark-media resolver is unchanged', () => {
  const css = ':root { --fg: #000000; } @media (prefers-color-scheme: dark) { :root { --fg: #ffffff; } }';
  const r = buildResolver(css, TWO_MODES, {});
  assert.equal(r.resolve('--fg', 'light'), '#000000');
  assert.equal(r.resolve('--fg', 'dark'),  '#ffffff');
});

// ── Base :root must be the TOP-LEVEL one, not the first :root in file order ──
test('[bugfix base-root] a preceding @media block does not poison the base :root', () => {
  const css = '@media (prefers-color-scheme: dark) { :root { --fg: #000000; } } :root { --fg: #ffffff; }';
  const r = buildResolver(css, TWO_MODES, {});
  assert.equal(r.resolve('--fg', 'light'), '#ffffff');   // old: matched the @media :root first → #000000
  assert.equal(r.resolve('--fg', 'dark'),  '#000000');
});
