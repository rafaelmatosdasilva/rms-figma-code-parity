// transition-check.mjs — Gate [16]
// Verifies every selector in TRANSITION_CONTRACT has a CSS transition
// matching the documented value. Catches duration/easing drift before DS
// EASING/TIMING variables are available (snapshot.animation is empty).
//
// Run from project root: node scripts/transition-check.mjs
// Exit 0 = all checks pass. Exit 1 = any failure.

import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATH = cfg.paths?.themeCSS ?? 'src/theme.css';
const PLUGIN_CSS = Array.isArray(cfg.paths?.pluginCSS) ? cfg.paths.pluginCSS : [];

// ── Load structure-contract.mjs ───────────────────────────────────────────────
let TRANSITION_CONTRACT = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.TRANSITION_CONTRACT) TRANSITION_CONTRACT = m.TRANSITION_CONTRACT;
} catch { /* optional — structure-contract.mjs may not exist yet */ }

if (!Object.keys(TRANSITION_CONTRACT).length) {
  console.log('\n⏭  TRANSITION_CONTRACT empty — skipped\n');
  process.exit(0);
}

// ── Load CSS sources ──────────────────────────────────────────────────────────
// theme.css is read as-is (pure CSS). Plugin files are HTML — extract only
// the content of <style> tags to avoid JS brace confusion in the block parser.
function extractCss(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) {
    return raw;
  }
  // Extract content of all <style> blocks.
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
}

const themePath = join(ROOT, THEME_PATH);
if (!existsSync(themePath)) {
  console.error(`❌ Theme CSS not found: ${THEME_PATH}`);
  process.exit(1);
}
const allCss = [THEME_PATH, ...PLUGIN_CSS]
  .filter(f => existsSync(join(ROOT, f)))
  .map(f => extractCss(join(ROOT, f)).replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

// ── CSS block scanner ─────────────────────────────────────────────────────────
// findAllBlocks: line-scan that concatenates EVERY CSS rule block for a selector.
// Using a flat index (last-wins) would silently drop the first of two same-selector
// rules (e.g. base style + dark-mode override) — the base rule often has transition
// while the override only sets a color, so we must accumulate all blocks.
function findAllBlocks(css, selector) {
  const lines   = css.split('\n');
  const escaped = selector.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const pat     = new RegExp('^\\s*' + escaped + '(?![.\\w-])\\s*\\{');
  const blocks  = [];
  for (let li = 0; li < lines.length; li++) {
    if (!pat.test(lines[li])) continue;
    if (/\}/.test(lines[li])) {
      const m = lines[li].match(/\{([^}]*)\}/);
      if (m) blocks.push(m[1]);
      continue;
    }
    const block = [];
    for (let j = li + 1; j < lines.length; j++) {
      if (/^\s*\}/.test(lines[j])) break;
      block.push(lines[j]);
    }
    blocks.push(block.join('\n'));
  }
  return blocks.length ? blocks.join('\n') : null;
}

// ── Transition parser ─────────────────────────────────────────────────────────
// Split a CSS transition value on top-level commas (skipping parens for cubic-bezier).
function splitTransition(val) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of val) {
    if      (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ── Check each contract entry ─────────────────────────────────────────────────
const FAIL = [], PASS = [];

for (const [selector, expected] of Object.entries(TRANSITION_CONTRACT)) {
  const block = findAllBlocks(allCss, selector);
  if (!block) {
    FAIL.push(`${selector}: selector not found in CSS`);
    continue;
  }

  const transMatch = block.match(/(?<![a-zA-Z-])transition\s*:\s*([^;]+)/);
  if (!transMatch) {
    FAIL.push(`${selector}: "transition" property not declared`);
    continue;
  }

  const actualParts  = splitTransition(transMatch[1]);
  const expectedArr  = (Array.isArray(expected) ? expected : [expected])
    .map(e => e.replace(/\s+/g, ' ').trim());

  const missing = expectedArr.filter(e => !actualParts.some(a => a === e));

  if (missing.length === 0) {
    PASS.push(selector);
  } else {
    const actualStr = actualParts.join(', ');
    FAIL.push(
      `${selector}: missing [ ${missing.join(', ')} ]  actual: ${actualStr || '(empty)'}`
    );
  }
}

// ── Output ────────────────────────────────────────────────────────────────────
const total = PASS.length + FAIL.length;
console.log(`\n✅ PASS  ${PASS.length}/${total} transition contract entries`);
console.log(`❌ FAIL  ${FAIL.length}`);

if (FAIL.length) {
  console.log('\n─── Gate [16] — transition value diverges from contract ─────────────');
  for (const f of FAIL) console.log(`  ❌ ${f}`);
  console.log('   Fix: update the CSS transition to match the TRANSITION_CONTRACT entry,');
  console.log('        or update the contract when the DS spec changes.');
  console.log('');
  process.exit(1);
}

console.log('\nAll transition checks pass. ✓\n');
process.exit(0);
