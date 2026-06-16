// structure-check.mjs — Run from project root: node scripts/structure-check.mjs
// Gate [3] — structural parity: snapshot vs contract, CSS height rules,
//             base-rule var bindings, and state/variant selector + var bindings.
//
// Full verification chain for every Figma state:
//   1. Selector exists in CSS
//   2. Selector's rule uses the correct token var for each property
//   3. (Gate [2]) That var resolves to the correct hex value
//
// Requires at project root:
//   ds-config.json          — themeCSS + snapshotStructure + pluginCSS paths
//   structure-contract.mjs  — CONTRACT, CSS_HEIGHT_RULES, CSS_BASE_RULE_VARS,
//                             STATE_SELECTORS
//
// Exit 0 = all checks pass. Exit 1 = any failure.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATH    = cfg.paths?.themeCSS          ?? 'src/theme.css';
const SNAPSHOT_PATH = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';
const PLUGIN_CSS    = cfg.paths?.pluginCSS          ?? [];

// ── Load structure-contract.mjs ───────────────────────────────────────────────
let CONTRACT = {}, CSS_HEIGHT_RULES = {}, CSS_BASE_RULE_VARS = [], STATE_SELECTORS = [];
let FIGMA_LAYOUT_TO_CSS = {}, FONT_SCALE_TO_CSS = {}, COMPONENT_CSS_SELECTORS = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.CONTRACT)                CONTRACT                = m.CONTRACT;
  if (m.CSS_HEIGHT_RULES)        CSS_HEIGHT_RULES        = m.CSS_HEIGHT_RULES;
  if (m.CSS_BASE_RULE_VARS)      CSS_BASE_RULE_VARS      = m.CSS_BASE_RULE_VARS;
  if (m.STATE_SELECTORS)         STATE_SELECTORS         = m.STATE_SELECTORS;
  if (m.FIGMA_LAYOUT_TO_CSS)     FIGMA_LAYOUT_TO_CSS     = m.FIGMA_LAYOUT_TO_CSS;
  if (m.FONT_SCALE_TO_CSS)       FONT_SCALE_TO_CSS       = m.FONT_SCALE_TO_CSS;
  if (m.COMPONENT_CSS_SELECTORS) COMPONENT_CSS_SELECTORS = m.COMPONENT_CSS_SELECTORS;
} catch { /* optional — runs with empty contract */ }

// ── Load snapshot ─────────────────────────────────────────────────────────────
let snap;
try {
  snap = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8'));
} catch {
  console.log('\n❌ figma-structure.snapshot.json not found or unreadable.');
  console.log('   Run /rms-parity Phase 1 to capture it.\n');
  process.exit(1);
}

if (!Object.keys(CONTRACT).length && !STATE_SELECTORS.length) {
  console.log('\n⏭  structure-contract.mjs not found or all exports empty.');
  console.log('   Copy structure-contract.example.mjs → structure-contract.mjs and fill in your components.\n');
  process.exit(0);
}

// ── Load CSS sources ──────────────────────────────────────────────────────────
// themeCSS  — used for height rules and base-rule var checks (central declarations)
// allCss    — theme + all plugin files, used for state selector checks
//             (state rules often live in plugin/component files)
let themeCSS = null;
try { themeCSS = readFileSync(join(ROOT, THEME_PATH), 'utf8'); } catch {}

const cssFiles  = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
const allCss    = cssFiles.map(f => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

// Build block indexes once — findBlock() uses these for O(1) lookups
const themeIndex = themeCSS ? buildBlockIndex(themeCSS) : null;
const allIndex   = buildBlockIndex(allCss);

// ── CSS utility helpers ───────────────────────────────────────────────────────
// Both helpers take an explicit css string so they work on themeCSS or allCss.

// buildBlockIndex — parse CSS once into Map<normalizedSelector → blockContent>.
// Handles flat rules only (no nested braces). Called once per CSS source on load;
// subsequent findBlock calls hit the Map in O(1) instead of scanning all lines.
function buildBlockIndex(css) {
  const index = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (sel) index.set(sel, m[2]);
  }
  return index;
}

// findBlock — O(1) index lookup with linear-scan fallback for complex selectors.
function findBlock(css, selector, index) {
  if (index) {
    // Exact match
    if (index.has(selector)) return index.get(selector);
    // Normalised-whitespace match (handles extra spaces in source)
    const norm = selector.replace(/\s+/g, ' ').trim();
    if (index.has(norm)) return index.get(norm);
  }
  // Fallback: original line-scan for selectors not found in the index
  // (e.g. multi-selector rules `.a, .b { }`, or selectors with combinators)
  const lines   = css.split('\n');
  const escaped = selector.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const pat     = new RegExp('^\\s*' + escaped + '(?![.\\w-])\\s*\\{');
  const start   = lines.findIndex(l => pat.test(l));
  if (start < 0) return null;
  if (/\}/.test(lines[start])) { const m = lines[start].match(/\{([^}]*)\}/); return m ? m[1] : ''; }
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\}/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

function extractPropVar(block, prop) {
  const re = new RegExp('(?<![a-zA-Z-])' + prop + '\\s*:\\s*(var\\(--[\\w-]+\\)|[^;\\n]+)');
  const m  = block?.match(re);
  if (!m) return null;
  const vm = m[1].trim().match(/^var\((--[\w-]+)/);
  return vm ? vm[1] : null;
}

function selectorExists(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[,\\n])\\s*${esc}\\s*(?:,|\\{)`, 'm').test(css);
}

// ── 1. Snapshot vs CONTRACT ───────────────────────────────────────────────────
const components = snap.components ?? {};
const FAIL = [], PASS = [], MISSING = [];
const SCALAR_FIELDS = ['h', 'gapVar', 'fontSizeVar', 'fontWeightVar', 'fillStructure', 'innerRadiusVar', 'strokeOnDefault'];

for (const [name, expect] of Object.entries(CONTRACT)) {
  const got = components[name];
  if (!got) { MISSING.push(name); continue; }
  for (const f of SCALAR_FIELDS) {
    if (expect[f] !== got[f])
      FAIL.push({ component: name, field: f, expected: expect[f], got: got[f] });
  }
  for (const side of ['tb', 'lr']) {
    const e = expect.paddingVar?.[side] ?? null, g = got.paddingVar?.[side] ?? null;
    if (e !== g) FAIL.push({ component: name, field: `paddingVar.${side}`, expected: e, got: g });
  }
  if (!FAIL.some(x => x.component === name)) PASS.push(name);
}

const extra = Object.keys(components).filter(c => !CONTRACT[c]);

// ── 2. CSS height cross-check ─────────────────────────────────────────────────
const CSS_FAIL = [], CSS_PASS = [];

if (themeCSS) {
  const cssVars = {};
  let inRoot = false, depth = 0, rootContent = '';
  for (const line of themeCSS.split('\n')) {
    if (!inRoot && /:root\s*\{/.test(line)) { inRoot = true; depth = 1; continue; }
    if (inRoot) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) { inRoot = false; continue; }
      rootContent += line + '\n';
    }
  }
  for (const m of rootContent.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) cssVars[`--${m[1]}`] = m[2].trim();

  function resolveVar(val, depth = 0) {
    if (depth > 8) return val;
    const m = String(val).match(/^var\((--[\w-]+)\)/);
    if (m && cssVars[m[1]]) return resolveVar(cssVars[m[1]], depth + 1);
    return val;
  }
  function toPx(val) {
    const r = resolveVar(val.trim()), m = String(r).match(/^(\d+(?:\.\d+)?)px/);
    return m ? Math.round(parseFloat(m[1])) : null;
  }

  for (const [comp, rule] of Object.entries(CSS_HEIGHT_RULES)) {
    const contractH = CONTRACT[comp]?.h;
    if (contractH === undefined || contractH === 'auto') { CSS_PASS.push(comp); continue; }
    const block = findBlock(themeCSS, rule.selector, themeIndex);
    if (!block) { CSS_FAIL.push(`${comp}: selector "${rule.selector}" not found in theme CSS`); continue; }
    const propPattern = rule.prop === 'height' ? '(?<!-)height' : 'min-height';
    const hMatch = block.match(new RegExp(propPattern + '\\s*:\\s*([^;\\n]+)'));
    if (!hMatch) { CSS_FAIL.push(`${comp}: "${rule.prop}" not set — contract expects ${contractH}px`); continue; }
    const cssPx = toPx(hMatch[1]);
    if (cssPx === null) CSS_FAIL.push(`${comp}: could not resolve "${hMatch[1].trim()}" to px`);
    else if (cssPx !== contractH) CSS_FAIL.push(`${comp}: CSS ${rule.prop} is ${cssPx}px — contract expects ${contractH}px`);
    else CSS_PASS.push(comp);
  }
}

// ── 3. CSS base-rule var bindings ─────────────────────────────────────────────
const VAR_FAIL = [], VAR_PASS = [];

if (themeCSS) {
  for (const rule of CSS_BASE_RULE_VARS) {
    const block = findBlock(themeCSS, rule.selector, themeIndex);
    if (!block) { VAR_FAIL.push(`${rule.key}: selector "${rule.selector}" not found`); continue; }
    const usedVar = extractPropVar(block, rule.prop);
    if (!usedVar) VAR_FAIL.push(`${rule.key}: "${rule.prop}" not set in "${rule.selector}"`);
    else if (usedVar !== rule.expectedVar) VAR_FAIL.push(`${rule.key}: "${rule.selector}" ${rule.prop} uses ${usedVar} — expected ${rule.expectedVar}`);
    else VAR_PASS.push(rule.key);
  }
}

// ── 4. State/variant selectors + var bindings ─────────────────────────────────
// Full chain per state:
//   (a) selector exists in CSS (theme or plugin files)
//   (b) for each declared var: selector's rule uses the expected token var
//
// Token values are verified by Gate [2] — this gate verifies the wiring.
const SELECTOR_FAIL = [], SELECTOR_PASS = [];

for (const entry of STATE_SELECTORS) {
  const label = `${entry.component} [${entry.figmaState}] "${entry.selector}"`;

  // (a) Selector existence
  if (!selectorExists(allCss, entry.selector)) {
    SELECTOR_FAIL.push({ label, issue: 'selector not found in any CSS file' });
    continue;
  }

  // (b) Var bindings (if declared)
  if (!entry.vars?.length) {
    SELECTOR_PASS.push(label);
    continue;
  }

  const block = findBlock(allCss, entry.selector, allIndex);
  if (!block) {
    SELECTOR_FAIL.push({ label, issue: 'selector found but rule block could not be parsed' });
    continue;
  }

  let allVarsPass = true;
  for (const v of entry.vars) {
    const usedVar = extractPropVar(block, v.prop);
    if (!usedVar) {
      SELECTOR_FAIL.push({ label, issue: `"${v.prop}" not set in rule`, expected: v.expectedVar });
      allVarsPass = false;
    } else if (usedVar !== v.expectedVar) {
      SELECTOR_FAIL.push({ label, issue: `"${v.prop}" uses ${usedVar} — expected ${v.expectedVar}` });
      allVarsPass = false;
    }
  }
  if (allVarsPass) SELECTOR_PASS.push(label);
}

// ── 5. CSS property binding checks ───────────────────────────────────────────
// Verifies each component's CSS rule uses the Figma-bound CSS var for key layout
// properties. Catches right-value-wrong-var bugs (e.g. gap: var(--padding-m) when
// gap/m and padding/m have the same px but differ by DS spec).
// Only runs when COMPONENT_CSS_SELECTORS is exported from structure-contract.mjs.
const PROP_FAIL = [], PROP_PASS = [];

if (themeCSS && Object.keys(COMPONENT_CSS_SELECTORS).length) {
  function propHasVar(block, prop, expectedVar) {
    if (!block || !expectedVar) return false;
    const re = new RegExp('(?<![a-zA-Z-])' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+)');
    const m  = block.match(re);
    return m ? m[1].includes(`var(${expectedVar})`) : false;
  }

  function propActual(block, prop) {
    if (!block) return '(not set)';
    const re = new RegExp('(?<![a-zA-Z-])' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+)');
    const m  = block?.match(re);
    return m ? m[1].trim().slice(0, 60) : '(not set)';
  }

  for (const [comp, contract] of Object.entries(CONTRACT)) {
    const selCfg = COMPONENT_CSS_SELECTORS[comp];
    if (!selCfg) continue;

    const mainBlock   = findBlock(themeCSS, selCfg.main, themeIndex);
    const gapBlock    = selCfg.gapSel    ? findBlock(themeCSS, selCfg.gapSel,    themeIndex) : mainBlock;
    const fontBlock   = selCfg.fontSel   ? findBlock(themeCSS, selCfg.fontSel,   themeIndex) : mainBlock;
    const radiusBlock = selCfg.radiusSel ? findBlock(themeCSS, selCfg.radiusSel, themeIndex) : mainBlock;

    if (!mainBlock) {
      PROP_FAIL.push(`${comp}: selector "${selCfg.main}" not found in theme CSS`);
      continue;
    }

    const check = (label, block, prop, expectedVar, sel) => {
      if (!expectedVar) return;
      if (!block) { PROP_FAIL.push(`${comp}/${label}: selector "${sel}" not found`); return; }
      if (propHasVar(block, prop, expectedVar)) {
        PROP_PASS.push(`${comp}/${label}`);
      } else {
        PROP_FAIL.push(`${comp}/${label}: expected var(${expectedVar}) in "${prop}" — got: ${propActual(block, prop)}`);
      }
    };

    if (contract.gapVar)
      check('gap', gapBlock, 'gap', FIGMA_LAYOUT_TO_CSS[contract.gapVar], selCfg.gapSel ?? selCfg.main);
    if (contract.paddingVar?.tb && !selCfg.skipTBPadding)
      check('padding-tb', mainBlock, 'padding', FIGMA_LAYOUT_TO_CSS[contract.paddingVar.tb], selCfg.main);
    if (contract.paddingVar?.lr)
      check('padding-lr', mainBlock, 'padding', FIGMA_LAYOUT_TO_CSS[contract.paddingVar.lr], selCfg.main);
    if (contract.fontSizeVar)
      check('font-size', fontBlock, 'font-size', FONT_SCALE_TO_CSS[contract.fontSizeVar]?.size, selCfg.fontSel ?? selCfg.main);
    if (contract.fontWeightVar)
      check('font-weight', fontBlock, 'font-weight', FONT_SCALE_TO_CSS[contract.fontWeightVar]?.weight, selCfg.fontSel ?? selCfg.main);
    if (contract.innerRadiusVar)
      check('radius', radiusBlock, 'border-radius', FIGMA_LAYOUT_TO_CSS[contract.innerRadiusVar], selCfg.radiusSel ?? selCfg.main);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ PASS  ${PASS.length}/${Object.keys(CONTRACT).length} components (structure)`);
console.log(`❌ FAIL  ${FAIL.length} field(s)`);
if (MISSING.length) console.log(`❓ MISSING from snapshot: ${MISSING.join(', ')}`);
if (extra.length)   console.log(`🆕 In snapshot, not in contract: ${extra.join(', ')}`);

if (FAIL.length) {
  console.log('\n─── Structural drift ──────────────────────────────────────────');
  for (const f of FAIL)
    console.log(`  ❌ ${f.component}.${f.field}: contract=${JSON.stringify(f.expected)}  Figma=${JSON.stringify(f.got)}`);
}

if (themeCSS) {
  console.log(`\n✅ PASS  ${CSS_PASS.length}/${Object.keys(CSS_HEIGHT_RULES).length} CSS height rules`);
  console.log(`❌ FAIL  ${CSS_FAIL.length}`);
  if (CSS_FAIL.length) for (const f of CSS_FAIL) console.log(`  ❌ ${f}`);

  console.log(`\n✅ PASS  ${VAR_PASS.length}/${CSS_BASE_RULE_VARS.length} CSS base-rule var bindings`);
  console.log(`❌ FAIL  ${VAR_FAIL.length}`);
  if (VAR_FAIL.length) for (const f of VAR_FAIL) console.log(`  ❌ ${f}`);

  if (Object.keys(COMPONENT_CSS_SELECTORS).length) {
    const propTotal = PROP_PASS.length + PROP_FAIL.length;
    console.log(`\n✅ PASS  ${PROP_PASS.length}/${propTotal} CSS property bindings`);
    console.log(`❌ FAIL  ${PROP_FAIL.length}`);
    if (PROP_FAIL.length) {
      console.log('\n─── Wrong var in property binding (Figma-bound token, wrong CSS var in rule) ──');
      for (const f of PROP_FAIL) console.log(`  ❌ ${f}`);
    }
  }
} else {
  console.log('\n⚠️  theme CSS not found — height and base-rule var checks skipped');
}

if (STATE_SELECTORS.length) {
  const totalVarChecks = STATE_SELECTORS.reduce((n, e) => n + (e.vars?.length ?? 0), 0);
  console.log(`\n✅ PASS  ${SELECTOR_PASS.length}/${STATE_SELECTORS.length} state/variant selectors`);
  if (totalVarChecks) console.log(`   (${totalVarChecks} var binding(s) verified across all states)`);
  console.log(`❌ FAIL  ${SELECTOR_FAIL.length}`);
  if (SELECTOR_FAIL.length) {
    console.log('\n─── State selector failures ───────────────────────────────────');
    for (const f of SELECTOR_FAIL) {
      console.log(`  ❌ ${f.label}`);
      console.log(`       ${f.issue}${f.expected ? `  →  expected: ${f.expected}` : ''}`);
    }
  }
} else {
  console.log('\n⏭  STATE_SELECTORS empty in structure-contract.mjs — state/variant check skipped');
}

const anyFail = FAIL.length > 0 || MISSING.length > 0 || CSS_FAIL.length > 0
             || VAR_FAIL.length > 0 || SELECTOR_FAIL.length > 0 || PROP_FAIL.length > 0;

if (!anyFail) { console.log('\nAll structural checks pass. ✓\n'); process.exit(0); }
else { console.log(''); process.exit(1); }
