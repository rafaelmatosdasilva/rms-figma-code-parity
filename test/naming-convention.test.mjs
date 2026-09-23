// Tests for the shared Figma↔code naming convention (naming-convention.mjs).
// Covers: (a) the zero-config DEFAULT reproduces the historical inline behaviour that used to be
// duplicated across the gates, and (b) each per-DS declarable knob actually changes the mapping —
// including the `case: "kebab"` knob that resolves the selectedHover ⇄ selected-hover mismatch.
import { test } from 'node:test';
import assert from 'node:assert';
import { tokenToVar, varToToken, resolveNamingSpec, DEFAULT_NAMING } from '../naming-convention.mjs';

// ── Default (zero-config) reproduces the old inline convention exactly ─────────────
test('[naming] default: slash→hyphen, drops trailing /color and /default', () => {
  assert.equal(tokenToVar('node/border/selected/color', DEFAULT_NAMING), '--node-border-selected');
  assert.equal(tokenToVar('node/border/default', DEFAULT_NAMING), '--node-border');
  assert.equal(tokenToVar('gap/m', DEFAULT_NAMING), '--gap-m');
});

test('[naming] default: iconText segment is aliased to text', () => {
  assert.equal(tokenToVar('icon/iconText/primary/color', DEFAULT_NAMING), '--icon-text-primary');
});

test('[naming] default: camelCase segments are preserved (no split)', () => {
  assert.equal(tokenToVar('node/border/selectedHover/color', DEFAULT_NAMING), '--node-border-selectedHover');
});

test('[naming] raw form skips drops + aliases + case (effect/motion style names)', () => {
  assert.equal(tokenToVar('shadow/card/default', DEFAULT_NAMING, { raw: true }), '--shadow-card-default');
  assert.equal(tokenToVar('icon/iconText/x', DEFAULT_NAMING, { raw: true }), '--icon-iconText-x');
});

// ── resolveNamingSpec: reads ds-config → figma.namingConvention ────────────────────
test('[naming] resolveNamingSpec: empty config yields the historical defaults', () => {
  const s = resolveNamingSpec({});
  assert.deepEqual(s.dropSegments, ['color', 'default']);
  assert.deepEqual(s.aliases, { iconText: 'text' });
  assert.equal(s.separator, '-');
  assert.equal(s.case, 'preserve');
});

test('[naming] iconTextAlias:false removes the alias (CSS keeps "iconText")', () => {
  const s = resolveNamingSpec({ figma: { namingConvention: { iconTextAlias: false } } });
  assert.equal(tokenToVar('icon/iconText/primary/color', s), '--icon-iconText-primary');
});

test('[naming] custom separator is honoured on both directions', () => {
  const s = resolveNamingSpec({ figma: { namingConvention: { separator: '_' } } });
  assert.equal(tokenToVar('node/border/selected/color', s), '--node_border_selected');
  assert.equal(varToToken('--node_border_selected', s), 'node/border/selected');
});

test('[naming] dropSegments:[] keeps every segment', () => {
  const s = resolveNamingSpec({ figma: { namingConvention: { dropSegments: [] } } });
  assert.equal(tokenToVar('node/border/selected/color', s), '--node-border-selected-color');
});

// ── The gate-7 case: a DS that flattens combined states in code declares case:"kebab" ──
test('[naming] case:"kebab" maps a camelCase Figma segment to a hyphenated CSS var', () => {
  const s = resolveNamingSpec({ figma: { namingConvention: { case: 'kebab' } } });
  // Figma token node/border/selectedHover/color  ⇄  CSS var --node-border-selected-hover
  assert.equal(tokenToVar('node/border/selectedHover/color', s), '--node-border-selected-hover');
  // single-word segments are unaffected
  assert.equal(tokenToVar('node/border/selected/color', s), '--node-border-selected');
});

// ── Reverse map ────────────────────────────────────────────────────────────────────
test('[naming] varToToken reverses the default hyphen convention', () => {
  assert.equal(varToToken('--node-border-selected', DEFAULT_NAMING), 'node/border/selected');
});
