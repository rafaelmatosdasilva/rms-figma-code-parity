// contrast-check.mjs — Gate [17]: WCAG contrast parity.
// The DS defines text colors and background colors but nothing verifies they're legible
// together. This computes the WCAG 2.1 contrast ratio of every foreground token against its
// background token, per mode, straight from the resolved hexes in figma-vars.snapshot.json —
// no rendering, fully deterministic. Pairs are auto-derived by naming convention
// (a component's label/text/icon/title/value tokens vs its background token) plus explicit
// pairs from parity-map.mjs → CONTRAST_PAIRS. Fails below the threshold (default 4.5 for
// text, override per pair). Exempt a pair via ds-config.json → knownContrastExceptions
// (["fg|bg", ...]) — for decorative or intentionally-subtle cases.
//
// Exit 0 = all pairs meet threshold (or are exempt). Exit 1 = a pair is below threshold.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const SNAP_VARS = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';
let snap;
try { snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8')); } catch {
  console.log('⏭  [17] contrast skipped — vars snapshot not found'); process.exit(0);
}
const modes = snap.color ?? {};
if (!Object.keys(modes).length) { console.log('⏭  [17] contrast skipped — no color modes'); process.exit(0); }

let CONTRAST_PAIRS = [];
try {
  const m = await import(join(ROOT, 'parity-map.mjs'));
  if (Array.isArray(m.CONTRAST_PAIRS)) CONTRAST_PAIRS = m.CONTRAST_PAIRS;
} catch { /* optional */ }
const EXEMPT = new Set(cfg.knownContrastExceptions ?? []);
const DEFAULT_MIN = cfg.contrastMinRatio ?? 4.5;

// ── WCAG 2.1 relative luminance + contrast ratio ──────────────────────────────
function toRgb(hex) {
  const h = hex.replace('#', '');
  if (h.length < 6) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
function luminance(hex) {
  const rgb = toRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fgHex, bgHex) {
  const l1 = luminance(fgHex), l2 = luminance(bgHex);
  if (l1 == null || l2 == null) return null;
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Auto-derive fg/bg pairs by convention ─────────────────────────────────────
// For a component prefix C, pair C/{label,text,iconText,title,value,icon}/… against
// C/background/… (best-effort: match the state segment when both carry one).
const FG_RE = /\/(label|text|iconText|title|value|icon)\//;
const stateOf = t => {
  const m = /\/(default|hover|selected|unselected|disabled|active|negative|warning|positive|neutral|loading|success|sucess|filled|empty|current)\b/.exec(t);
  return m ? m[1] : null;
};
const compOf = t => t.split('/')[0];

function derivePairs(tokens) {
  const bgs = tokens.filter(t => /\/background\//.test(t) || /\/background$/.test(t));
  const pairs = [];
  for (const fg of tokens.filter(t => FG_RE.test(t))) {
    const c = compOf(fg), s = stateOf(fg);
    // prefer a same-component background with a matching state, else the component's sole bg
    const candidates = bgs.filter(b => compOf(b) === c);
    if (!candidates.length) continue;
    const bg = candidates.find(b => stateOf(b) === s) ?? (candidates.length === 1 ? candidates[0] : candidates.find(b => stateOf(b) === 'default')) ?? candidates[0];
    if (bg) pairs.push({ fg, bg, min: DEFAULT_MIN, derived: true });
  }
  return pairs;
}

// Explicit CONTRAST_PAIRS are curated (correct fg/bg, solid backgrounds) → these can hard-fail.
// Auto-derived pairs are best-effort and can mispair (alpha-tint backgrounds resolve to the
// same solid hex; cross-type components) → advisory only, unless ds-config contrastStrict:true.
// A pair whose fg and bg resolve to the SAME hex is an alpha/tint background we can't assess
// from the solid snapshot value — skipped, not failed.
const STRICT = cfg.contrastStrict === true;
const explicitKeys = new Set(CONTRAST_PAIRS.map(p => `${p.fg}|${p.bg}`));
const HARD = [], SOFT = [], PASS = [], SKIP = [];
for (const [mode, colors] of Object.entries(modes)) {
  const tokens = Object.keys(colors);
  const allPairs = [...CONTRAST_PAIRS, ...derivePairs(tokens)];
  const seen = new Set();
  for (const p of allPairs) {
    const key = `${p.fg}|${p.bg}`;
    if (seen.has(key + mode)) continue;
    seen.add(key + mode);
    if (EXEMPT.has(key) || EXEMPT.has(`${key}|${mode}`)) { SKIP.push(`${mode} ${key} (exempt)`); continue; }
    const fgHex = colors[p.fg], bgHex = colors[p.bg];
    if (!fgHex || !bgHex) continue;
    if (fgHex.toLowerCase() === bgHex.toLowerCase()) { SKIP.push(`${mode} ${key} (alpha/tint bg — undetectable from solid hex)`); continue; }
    const r = ratio(fgHex, bgHex);
    if (r == null) continue;
    const min = p.min ?? DEFAULT_MIN;
    const label = `${mode}: ${p.fg} on ${p.bg} = ${r.toFixed(2)}:1 (min ${min})   ${fgHex} on ${bgHex}`;
    if (r < min - 0.005) (explicitKeys.has(key) ? HARD : SOFT).push(label);
    else PASS.push(label);
  }
}

console.log(`\n✅ PASS  ${PASS.length}  (contrast ≥ threshold)`);
console.log(`❌ FAIL  ${HARD.length}  (curated pairs)`);
console.log(`⚠️  REVIEW ${SOFT.length}  (auto-derived — possible mispairing)`);
if (SKIP.length) console.log(`⏭  SKIP  ${SKIP.length}  (exempt or alpha-bg)`);

if (HARD.length) {
  console.log('\n─── Gate [17] — curated text/background pair below WCAG threshold ──');
  for (const f of HARD) console.log(`  ❌ ${f}`);
  console.log('   Fix: adjust the DS token to meet the ratio, or exempt via knownContrastExceptions.');
}
if (SOFT.length) {
  const mark = STRICT ? '❌' : '⚠️ ';
  console.log(`\n─── Gate [17] — auto-derived low-contrast pairs (${STRICT ? 'strict' : 'advisory'}) ──`);
  for (const f of SOFT) console.log(`  ${mark} ${f}`);
  console.log('   Review: real low contrast (fix the token) vs decorative/placeholder/mispair.');
  console.log('   Promote a verified pair into parity-map CONTRAST_PAIRS, or exempt it; set');
  console.log('   contrastStrict:true to fail on all of these.');
}
console.log('');
const failCount = HARD.length + (STRICT ? SOFT.length : 0);
process.exit(failCount > 0 ? 1 : 0);
