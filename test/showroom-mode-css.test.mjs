// Regression tests for showroom-gen's deriveModeCSS: the showroom drives colour
// mode with a manual per-component [data-color] toggle, generated ENTIRELY from
// the DS @media (prefers-color-scheme: dark) blocks - nothing hand-copied, no
// value invented. These tests pin the behaviour that fixes the reported bug
// ("a per-component light override does not win under a global dark mode").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveModeCSS, deriveSizeCSS } from '../showroom-gen.mjs';

// A DS token file: neutrals flip by mode, semantics ride on them, plus a
// size-axis var and a typography var (which must NOT leak into colour blocks),
// a component-scoped dark rule, and a trailing ORPHAN brace (a real quirk seen
// in a shipping DS - harmless standalone, but it swallows the next rule when
// content is appended).
const CSS = `:root {
    --neutral-100: #0a0a0a;
    --neutral-900: #f7f7f7;
    --bg: var(--neutral-900);
    --text: var(--neutral-100);
    --padding-m: 12px;
    --m-size: 11px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --neutral-100: #f5f5f5;
      --neutral-900: #212121;
    }
  }
  @media (prefers-color-scheme: dark) {
    .buttonTertiary { color: var(--text); }
  }
}`;   // <- trailing orphan brace

const out = deriveModeCSS(CSS);
const block = (sel) => {
  const i = out.indexOf(sel + ' {'); if (i < 0) return null;
  const open = out.indexOf('{', i); let d = 0;
  for (let j = open; j < out.length; j++) { if (out[j] === '{') d++; else if (out[j] === '}') { d--; if (!d) return out.slice(open + 1, j); } }
  return null;
};

test('[showroom] a manual [data-color="light"] block is generated from :root', () => {
  const light = block('[data-color="light"]');
  assert.ok(light, 'light block missing');
  assert.match(light, /--neutral-900:\s*#f7f7f7/);
  assert.match(light, /--bg:\s*var\(--neutral-900\)/);
});

test('[showroom] a manual [data-color="dark"] block carries the dark ramp values', () => {
  const dark = block('[data-color="dark"]');
  assert.ok(dark, 'dark block missing');
  assert.match(dark, /--neutral-900:\s*#212121/);   // dark override
  assert.match(dark, /--neutral-100:\s*#f5f5f5/);
});

test('[showroom] the OS @media path is gated to :root:not([data-color]) so the toggle wins', () => {
  assert.match(out, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-color\]\)/);
});

test('[showroom] component-scoped dark rules become [data-color="dark"] .selector', () => {
  assert.match(out, /\[data-color="dark"\] \.buttonTertiary \{[^}]*color:\s*var\(--text\)/);
  // and its OS-media form is gated too, so it never fires against the toggle
  assert.match(out, /:root:not\(\[data-color\]\) \.buttonTertiary/);
});

test('[showroom bugfix] size- and typography-axis vars never leak into colour blocks', () => {
  // --padding-m (size axis) and --m-size (typography) do not reference a colour
  // primitive, so the closure must exclude them - otherwise a [data-color] scope
  // would fight the [data-size] axis in nested previews.
  const light = block('[data-color="light"]'), dark = block('[data-color="dark"]');
  for (const b of [light, dark]) {
    assert.doesNotMatch(b, /--padding-m/);
    assert.doesNotMatch(b, /--m-size/);
  }
  // colour semantics ARE included (they reference a mode-varying primitive)
  assert.match(light, /--text:/);
});

test('[showroom bugfix] an orphan brace in the DS file is balanced before appending', () => {
  // Net brace depth must be 0, or the first appended [data-color] rule is
  // swallowed by the unbalanced tail (the exact bug that dropped the light rule).
  let d = 0, inC = false, inS = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i], n = out[i + 1];
    if (inC) { if (c === '*' && n === '/') { inC = false; i++; } continue; }
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '/' && n === '*') { inC = true; i++; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '{') d++; else if (c === '}') d--;
  }
  assert.equal(d, 0, 'generated CSS is not brace-balanced');
});

// ── Size axis (Desktop/Phone) generated from the DS sizing-collection modes ──
test('[showroom] deriveSizeCSS emits [data-size] blocks from per-mode sizing (modeVariants)', () => {
  const mv = { Sizing: {
    modes: [{ name: 'Desktop', snapshotKey: 'desktop' }, { name: 'Phone', snapshotKey: 'phone' }],
    vars: {
      'padding/m':        { kind: 'scalar', values: { desktop: '12px', phone: '8px' } },
      'button/min-height':{ kind: 'scalar', values: { desktop: '24px', phone: '44px' } },
      'padding/l':        { kind: 'scalar', values: { desktop: '16px', phone: '16px' } }, // unchanged
    },
  } };
  const css = deriveSizeCSS(mv);
  assert.match(css, /\[data-size="phone"\] \{/);
  assert.match(css, /--padding-m:\s*8px/);            // Figma token padding/m -> CSS var --padding-m
  assert.match(css, /--button-min-height:\s*44px/);
  assert.doesNotMatch(css, /--padding-l/);            // unchanged from base -> not emitted
  assert.doesNotMatch(css, /\[data-size="desktop"\]/); // base mode is :root, no block
});

test('[showroom] deriveSizeCSS is a no-op when sizing was captured single-mode', () => {
  // The current real state: no modeVariants -> no phone data -> nothing emitted,
  // so the showroom keeps whatever the template already carries (no invention).
  assert.equal(deriveSizeCSS(undefined), '');
  assert.equal(deriveSizeCSS({}), '');
  assert.equal(deriveSizeCSS({ Sizing: { modes: [{ snapshotKey: 'desktop' }], vars: {} } }), '');
});

test('[showroom bugfix] a MID-FILE orphan brace is dropped at its position, not by trimming the tail', () => {
  // A stray top-level `}` in the middle (after :root already closed). A naive
  // trailing-strip would delete .card's real closing brace and corrupt it; the
  // position-aware balancer drops the stray one and leaves everything else intact.
  const MID = ':root { --neutral-100: #0a0a0a; --neutral-900: #f7f7f7; --bg: var(--neutral-900); }\n' +
    '}\n' +                                                       // <- mid-file orphan
    '.card { color: var(--neutral-100); background: var(--bg); }\n' +
    '@media (prefers-color-scheme: dark) { :root { --neutral-900: #212121; } }\n';
  const out = deriveModeCSS(MID);
  // brace-balanced (string/comment-aware)
  let d = 0, inC = false, inS = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i], n = out[i + 1];
    if (inC) { if (c === '*' && n === '/') { inC = false; i++; } continue; }
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '/' && n === '*') { inC = true; i++; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '{') d++; else if (c === '}') d--;
  }
  assert.equal(d, 0, 'must be balanced');
  assert.match(out, /\.card \{ color: var\(--neutral-100\); background: var\(--bg\); \}/, 'the rule after the orphan must survive intact');
  assert.match(out, /\[data-color="light"\] \{/);
  assert.match(out, /\[data-color="dark"\] \{/);
});
