// contrast-check.mjs - token-level WCAG contrast (I28), no browser.
//
// Complements the render-based a11y gate (I18): given text/background token PAIRS the project declares,
// compute the WCAG contrast from the DS's own token values (per mode) and flag any pair below AA. Runs
// anywhere (CI without Chrome), it is pure math on resolved token values. Opt-in and project-declared:
//   ds-config.json → a11y.tokenPairs: [ { text: "<token>", bg: "<token>", large?: bool, name?: "…" } ]
// Never imposed (no pairs = does not run), advisory (never fails). Reuses a11y-check's contrast math.

import { contrastRatio } from './a11y-check.mjs';
import { parseColor } from './css-values.mjs';

// Hex (#rgb / #rgba / #rrggbb / #rrggbbaa) -> {r,g,b} in 0-255, or null (the alpha channel is read by
// tokenContrastFindings through css-values.mjs).
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if ((h.length !== 6 && h.length !== 8) || !/^[0-9a-fA-F]+$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// pairs: [{ name?, text, bg, large? }]; resolve(tokenName) -> hex string (or null). Returns the pairs
// whose ratio is below AA (4.5 normal, 3 large), plus how many were checked / skipped (unresolvable).
// A see-through text colour is blended over its background before measuring (what the eye sees).
// A see-through background cannot be measured without the surface under it, so that pair is skipped.
export function tokenContrastFindings(pairs, resolve) {
  const findings = [];
  let checked = 0, skipped = 0;
  for (const p of pairs || []) {
    const textHex = resolve(p.text);
    const bgHex = resolve(p.bg);
    const tc = parseColor(textHex), bc = parseColor(bgHex);
    if (!tc || !bc || bc[3] < 1) { skipped++; continue; }
    checked++;
    const a = tc[3];
    const t = { r: tc[0] * a + bc[0] * (1 - a), g: tc[1] * a + bc[1] * (1 - a), b: tc[2] * a + bc[2] * (1 - a) };
    const b = { r: bc[0], g: bc[1], b: bc[2] };
    const ratio = Math.round(contrastRatio(t, b) * 100) / 100;
    const threshold = p.large ? 3 : 4.5;
    if (ratio < threshold) {
      findings.push({ name: p.name || `${p.text} on ${p.bg}`, text: p.text, bg: p.bg, textHex, bgHex, ratio, threshold });
    }
  }
  return { findings, checked, skipped };
}

// State contrast from the code capture (code.snapshot.json), no new browser run: each component's
// text against its own background in every mode, and in every state the capture produced (colours
// measured in the first mode). Disabled states are exempt (WCAG 1.4.3). A see-through background has
// no known surface under it, so it is skipped. Large text (24px, or 18.66px bold) needs 3:1.
export function stateContrastFindings(code) {
  const findings = [];
  let checked = 0;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  for (const [name, c] of Object.entries(code?.components ?? {})) {
    const colors = c.colors ?? {};
    const modes = Object.keys(colors);
    // Only components that show text, on a background the component itself paints (not one set by
    // the page in a style attribute, such as a swatch showing its colour).
    if (!modes.length || c.instance?.hasText === false || /\(style attribute\)/.test(String(c.props?.backgroundColor?.rule ?? ''))) continue;
    const tp = c.parts?.text?.props ?? c.props ?? {};
    const size = num(tp.fontSize?.value), weight = num(tp.fontWeight?.value);
    const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const check = (state, mode, fg, bg) => {
      const f = parseColor(fg), b = parseColor(bg);
      if (!f || !b || b[3] < 1 || f[3] === 0) return;
      checked++;
      const a = f[3];
      const ratio = Math.round(contrastRatio({ r: f[0] * a + b[0] * (1 - a), g: f[1] * a + b[1] * (1 - a), b: f[2] * a + b[2] * (1 - a) }, { r: b[0], g: b[1], b: b[2] }) * 100) / 100;
      if (ratio < threshold) findings.push({ component: name, state, mode, ratio, threshold, fg, bg });
    };
    for (const m of modes) check('default', m, colors[m].color, colors[m].backgroundColor);
    const base = colors[modes[0]];
    for (const [label, st] of Object.entries(c.states ?? {})) {
      if (/disabled|inactive/i.test(label)) continue;
      if (/^found/i.test(String(st.produced ?? ''))) continue;   // measured on another element: its text may differ
      const ch = st.changed ?? {};
      if (!ch.color && !ch.backgroundColor) continue;
      check(label, modes[0], ch.color?.value ?? base.color, ch.backgroundColor?.value ?? base.backgroundColor);
    }
  }
  return { findings, checked };
}
