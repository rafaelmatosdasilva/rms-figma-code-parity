// bound-check.mjs — Run from project root: node scripts/bound-check.mjs
// Verifies every Figma variable bound to a node in your DS frames is
// implemented in code (CSS var declared) or explicitly deferred.
//
// A token bound in Figma with no CSS var and not on the deferral list is a
// divergence — the design uses it, the code doesn't.
//
// Requires at project root:
//   ds-config.json   — themeCSS + pluginCSS paths
//   parity-map.mjs   — COVERED, COVERED_PREFIX, EXPLICIT (optional)
//   bound-tokens.json — output of /rms-parity Phase 2 Step 1b
//
// Exit 0 = every bound token covered.
// Exit 1 = uncovered bound token(s).
// Exit 2 = bound-tokens.json missing (gate did NOT run — never a pass).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATH = cfg.paths?.themeCSS  ?? 'src/theme.css';
const PLUGIN_CSS = cfg.paths?.pluginCSS ?? [];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let COVERED = new Set(), COVERED_PREFIX = [], EXPLICIT = {};
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.COVERED)        COVERED        = map.COVERED;
  if (map.COVERED_PREFIX) COVERED_PREFIX = map.COVERED_PREFIX;
  if (map.EXPLICIT)       EXPLICIT       = map.EXPLICIT;
} catch { /* optional */ }

// ── Load bound-tokens.json ────────────────────────────────────────────────────
let raw;
try { raw = readFileSync(join(ROOT, 'bound-tokens.json'), 'utf8'); } catch {
  console.log('\n⚠️  bound-tokens.json not found at project root.');
  console.log('   Run /rms-parity Phase 2 Step 1b and save output to bound-tokens.json.');
  console.log('   (exit 2 — treated as "not run", never as a pass)\n');
  process.exit(2);
}
const parsed = JSON.parse(raw);
// _-prefixed keys are metadata (_updated stamp), not tokens
const boundTokens = (Array.isArray(parsed) ? parsed : Object.keys(parsed)).filter(t => !t.startsWith('_'));

// ── Collect all declared CSS vars ─────────────────────────────────────────────
const declared = new Set();
const sources = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
for (const f of sources) {
  const txt = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of txt.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);
}

// ── Coverage check ────────────────────────────────────────────────────────────
function normalize(token) { return token.replace(/\/color$/, ''); }

function isCovered(token) {
  const t = normalize(token);
  if (t.startsWith('primitives/')) return true;
  if (COVERED.has(t)) return true;
  if (COVERED_PREFIX.some(p => t.startsWith(p))) return true;
  if (EXPLICIT[t] && declared.has(EXPLICIT[t])) return true;
  // Convention: /iconText/ → /text/, drop /default, / → -
  const v = '--' + t.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
  if (declared.has(v)) return true;
  if (declared.has('--' + t.replace(/\//g, '-'))) return true;
  return false;
}

const UNCOVERED = [], OK = [];
for (const token of boundTokens) {
  if (isCovered(token)) OK.push(token);
  else UNCOVERED.push(token);
}

console.log(`\n✅ COVERED   ${OK.length}`);
console.log(`❌ UNCOVERED ${UNCOVERED.length}`);

if (UNCOVERED.length) {
  console.log('\n─── Bound in Figma, no CSS var (implement or add to COVERED in parity-map.mjs) ──');
  for (const t of UNCOVERED) console.log(`  ❌ ${t}`);
  console.log('');
  process.exit(1);
} else {
  console.log('\nEvery Figma-bound token is implemented or explicitly deferred. ✓\n');

  // ── #4: DS orphan-token report ──────────────────────────────────────────────
  // An orphan = a token that exists in the DS variable snapshot but is bound to NOTHING —
  // not to any frame node (bound-tokens.json) and not to any component variant
  // (component-state-tokens.json). Two tiers:
  //   • ORPHAN-BUT-USED (❌): the code declares/uses its CSS var. The DS binds the token
  //     nowhere, yet the code styles with it — a stale token the DS abandoned (the
  //     node/border/default class). This fails unless listed in ds-config knownOrphanExceptions.
  //   • ORPHAN (ℹ️): defined but unused on both sides — advisory, likely DS cleanup.
  let orphanFail = 0;
  try {
    const SNAP_VARS = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';
    const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
    const snapTokens = new Set(Object.keys(snap.color?.light ?? {}));

    // "Bound anywhere" = frame bindings ∪ component-variant bindings.
    const boundAnywhere = new Set(boundTokens);
    try {
      const st = JSON.parse(readFileSync(join(ROOT, 'component-state-tokens.json'), 'utf8'));
      for (const k of Object.keys(st)) if (!k.startsWith('_')) boundAnywhere.add(k);
    } catch { /* optional */ }

    const ORPHAN_SKIP = new Set(cfg.knownOrphanExceptions ?? []);
    const derivedVar = t => {
      const n = normalize(t);
      return EXPLICIT[n] ?? ('--' + n.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-'));
    };

    const orphanUsed = [], orphanBenign = [];
    for (const t of snapTokens) {
      if (boundAnywhere.has(t) || boundAnywhere.has(normalize(t))) continue; // bound somewhere → not orphan
      if (t.startsWith('primitives/')) continue;
      if (ORPHAN_SKIP.has(normalize(t)) || ORPHAN_SKIP.has(t)) continue;
      const v = derivedVar(t);
      if (declared.has(v)) orphanUsed.push({ t, v });
      else if (!isCovered(t)) orphanBenign.push(t);
    }

    if (orphanUsed.length) {
      // Advisory by default: the "bound" set can't perfectly tell a genuinely-stale token
      // (DS abandoned it) from a legit interaction-state token the DS keeps without a variant
      // (focus, selected+hover). So this surfaces review candidates but doesn't block. Set
      // ds-config → orphanUsedStrict:true to fail instead (after triaging real ones into
      // knownOrphanExceptions). Escalate a specific token to ❌ by removing it from that list.
      const strict = cfg.orphanUsedStrict === true;
      orphanFail = strict ? orphanUsed.length : 0;
      const mark = strict ? '❌' : '⚠️ ';
      console.log(`${mark} ORPHAN-BUT-USED (${orphanUsed.length}) — DS binds these to nothing, but the code uses their CSS var:`);
      for (const { t, v } of orphanUsed) console.log(`  ${mark} ${t}  →  ${v} (declared in CSS)`);
      console.log('   Review: is it a stale token (rebind in DS or drop the CSS var), or a legit');
      console.log('   interaction state with no variant? Add confirmed-legit ones to ds-config →');
      console.log('   knownOrphanExceptions; set orphanUsedStrict:true to make the rest fail.\n');
    }
    if (orphanBenign.length) {
      console.log(`ℹ️  ORPHANED TOKENS (${orphanBenign.length}) — in DS snapshot, bound to nothing, unused in code (DS cleanup candidates)`);
      for (const t of orphanBenign) console.log(`     ${t}`);
      console.log('');
    }
  } catch { /* snapshot may not exist yet */ }

  process.exit(orphanFail === 0 ? 0 : 1);
}
