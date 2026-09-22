// contrast-check.mjs - token-level WCAG contrast (I28), no browser.
//
// Complements the render-based a11y gate (I18): given text/background token PAIRS the project declares,
// compute the WCAG contrast from the DS's own token values (per mode) and flag any pair below AA. Runs
// anywhere (CI without Chrome), it is pure math on resolved token values. Opt-in and project-declared:
//   ds-config.json → a11y.tokenPairs: [ { text: "<token>", bg: "<token>", large?: bool, name?: "…" } ]
// Never imposed (no pairs = does not run), advisory (never fails). Reuses a11y-check's contrast math.

import { contrastRatio } from './a11y-check.mjs';

// Hex (#rgb / #rgba / #rrggbb / #rrggbbaa) -> {r,g,b} in 0-255, or null. Alpha is ignored (token bg
// colors are effectively opaque; a translucent pair is a11y-check's render job, not this one).
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if ((h.length !== 6 && h.length !== 8) || !/^[0-9a-fA-F]+$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// pairs: [{ name?, text, bg, large? }]; resolve(tokenName) -> hex string (or null). Returns the pairs
// whose ratio is below AA (4.5 normal, 3 large), plus how many were checked / skipped (unresolvable).
export function tokenContrastFindings(pairs, resolve) {
  const findings = [];
  let checked = 0, skipped = 0;
  for (const p of pairs || []) {
    const textHex = resolve(p.text);
    const bgHex = resolve(p.bg);
    const t = hexToRgb(textHex), b = hexToRgb(bgHex);
    if (!t || !b) { skipped++; continue; }
    checked++;
    const ratio = Math.round(contrastRatio(t, b) * 100) / 100;
    const threshold = p.large ? 3 : 4.5;
    if (ratio < threshold) {
      findings.push({ name: p.name || `${p.text} on ${p.bg}`, text: p.text, bg: p.bg, textHex, bgHex, ratio, threshold });
    }
  }
  return { findings, checked, skipped };
}
