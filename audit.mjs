// audit.mjs — Single-command parity audit runner.
// Run from project root: node scripts/audit.mjs [--trend]
//
// --trend: print the last 20 audit runs and exit (no new run)
//
// Requires at project root:
//   ds-config.json   — paths, plugin list, known-unused vars
//
// Gates:
//   [1] Snapshot freshness     — warns if snapshots are stale (> 24 h)
//   [2] Parity check           — token values: color + sizing + typography
//   [3] Structure check        — heights + CSS base-rule var bindings
//   [4] Bound-token coverage   — every bound Figma token has a CSS var
//   [5] Unused var check       — no declared-but-orphaned CSS vars
//   [6] Hardcoded value scan   — no raw hex / px in CSS rules
//   [7] Build freshness        — source files not newer than built output
//   [8] Sub-component isolation — no broad element selector overrides sub-component styles
//   [9] Visual regression      — Figma frame screenshots match stored references
//                               (requires FIGMA_TOKEN env var; skipped if not set)
//
// Hard Rules (enforced across all gates):
//   • Hard Rule #2: every CSS var must have at least one rule consumer — no orphans
//   • Hard Rule #5: no hardcoded hex/px in CSS rules (declarations OK)
//   • Hard Rule #7: hidden Figma nodes (visible=false) are flagged but NEVER
//     implemented in code. A token whose only binding is on a hidden layer is
//     not a code requirement.
//   • Hard Rule #8: every DS sub-component nested inside another DS component
//     must retain its own CSS styles. A parent component's rule that uses a bare
//     element selector (e.g. .node svg { color: X }) will override inherited styles
//     from nested sub-components — direct targeting beats inheritance. Any such
//     broad rule must be in subcomponent-isolation-check.mjs's ALLOWED map.
//
// History is appended to parity-history.json at project root after every run.
// View trend: node scripts/audit.mjs --trend
//
// Exit 0 = all gates pass. Exit 1 = one or more failed.
//
// Performance: gates 2–4 and 8–9 (subprocess-based) run in parallel via Promise.all.
// Total runtime = max(slowest gate) instead of sum(all gates).

import { spawn, spawnSync }                                   from 'child_process';
import { existsSync, readFileSync, statSync, writeFileSync }  from 'fs';
import { join, dirname, resolve }                             from 'path';
import { fileURLToPath }                                      from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT       = process.cwd();
const today      = new Date().toISOString().slice(0, 10);
const WIDTH      = 60;
const SHOW_TREND = process.argv.includes('--trend');

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8'));
} catch {
  console.error('\n❌ ds-config.json not found at project root.');
  console.error('   Copy ds-config.example.json → ds-config.json and fill in your values.\n');
  process.exit(1);
}

const THEME       = cfg.paths?.themeCSS          ?? 'src/theme.css';
const SNAP_VARS   = cfg.paths?.snapshotVars       ?? 'src/figma-vars.snapshot.json';
const SNAP_STRUCT = cfg.paths?.snapshotStructure  ?? 'src/figma-structure.snapshot.json';
const PLUGIN_CSS  = cfg.paths?.pluginCSS          ?? [];
const PLUGINS     = cfg.paths?.plugins            ?? [];
const KNOWN_UNUSED     = new Set(cfg.knownUnusedVars         ?? []);
const KNOWN_FS_EXCEPTS = cfg.knownHardcodedExceptions        ?? cfg.knownFontSizeExceptions ?? [];

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const C = {
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ── --trend: show history and exit ───────────────────────────────────────────
if (SHOW_TREND) {
  const histPath = join(ROOT, 'parity-history.json');
  try {
    const hist = JSON.parse(readFileSync(histPath, 'utf8'));
    console.log('\n' + C.bold('─── Parity Trend ───────────────────────────────────────────'));
    const recent = hist.slice(-20);
    for (const entry of recent) {
      const icon = entry.fail === 0 ? C.green('✅') : C.red('❌');
      const filled = entry.pass ?? 0;
      const total  = entry.total ?? 8;
      const bar    = C.green('█'.repeat(filled)) + C.dim('░'.repeat(total - filled));
      console.log(`  ${icon}  ${entry.date}  ${String(filled).padStart(2)}/${total} [${bar}]`);
    }
    if (!hist.length) console.log('  No history yet — run: node scripts/audit.mjs');
    console.log(C.bold('─'.repeat(WIDTH)) + '\n');
  } catch {
    console.log('\n⏭  No history yet — run: node scripts/audit.mjs\n');
  }
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sh(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// Async subprocess runner — used for gates that spawn Node scripts.
// All such gates run concurrently via Promise.all; total time = max(slowest gate).
function runScriptAsync(scriptPath) {
  return new Promise(res => {
    const abs = resolve(SCRIPT_DIR, scriptPath);
    if (!existsSync(abs)) return res({ status: null, stdout: '', stderr: '' });
    const child = spawn('node', [abs], { cwd: ROOT, env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => res({ status, stdout, stderr }));
  });
}

function snapshotAge(file) {
  try {
    const snap = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    if (!snap._updated) return null;
    return Math.floor((Date.now() - new Date(snap._updated).getTime()) / 3_600_000);
  } catch { return null; }
}

function boundAge() {
  try {
    return Math.floor((Date.now() - statSync(join(ROOT, 'bound-tokens.json')).mtime) / 3_600_000);
  } catch { return null; }
}

// ── Gate parsers for subprocess-based gates ───────────────────────────────────
function parseGate2(r) {
  if (r.status === null) return { pass: false, lines: [C.red('parity-check.mjs not found')] };
  const out  = r.stdout + r.stderr;
  const pass = r.status === 0;
  const summary    = out.split('\n').filter(l => /✅|❌|⚠️/.test(l) && l.trim()).map(l => l.trim());
  const failDetails = pass ? [] : out.split('\n')
    .filter(l => l.trim().startsWith('❌') || l.trim().startsWith('Fix:'))
    .map(l => '  ' + l.trim()).slice(0, 30);
  return { pass, lines: [...summary, ...failDetails] };
}

function parseGate3(r) {
  if (r.status === null) return { pass: true, lines: ['⏭ structure-check.mjs not found — skipped'] };
  const out  = r.stdout + r.stderr;
  const pass = r.status === 0;
  const summary    = out.split('\n').filter(l => /✅|❌/.test(l) && l.trim()).map(l => l.trim());
  const failDetails = pass ? [] : out.split('\n')
    .filter(l => l.trim().startsWith('❌') && !l.includes('FAIL  0'))
    .map(l => '  ' + l.trim()).slice(0, 20);
  return { pass, lines: [...summary, ...failDetails] };
}

function parseGate4(r) {
  if (r.status === null) return { pass: true, lines: ['⏭ bound-check.mjs not found — skipped'] };
  const out = r.stdout + r.stderr;

  if (r.status === 2) {
    return {
      pass: false,
      lines: [
        C.red('❌ HARD FAIL — bound-tokens.json missing.'),
        C.red('   Run /rms-parity Phase 2 Step 1b and save output to bound-tokens.json.'),
      ],
    };
  }

  const pass       = r.status === 0;
  const summary    = out.split('\n').filter(l => /COVERED|UNCOVERED/.test(l) && l.trim()).map(l => l.trim());
  const failDetails = pass ? [] : out.split('\n').filter(l => l.trim().startsWith('❌')).map(l => '  ' + l.trim()).slice(0, 20);
  return { pass, lines: [...summary, ...failDetails] };
}

function parseGate8(r) {
  if (r.status === null) return { pass: true, lines: ['⏭ subcomponent-isolation-check.mjs not found — skipped'] };
  const out  = r.stdout + r.stderr;
  const pass = r.status === 0;
  const summary    = out.split('\n')
    .filter(l => /✅ DOCUMENTED|✅ No new|❌ UNDOCUMENTED/.test(l) && l.trim())
    .map(l => l.trim());
  const failDetails = pass ? [] : out.split('\n')
    .filter(l => l.trim().startsWith('❌') && !l.includes('UNDOCUMENTED'))
    .map(l => '  ' + l.trim()).slice(0, 20);
  return { pass, lines: [...summary, ...failDetails] };
}

function parseGate9(r) {
  if (r.status === null) return { pass: true, lines: ['⏭ visual-regression-check.mjs not found — skipped'] };
  const out = r.stdout + r.stderr;

  if (r.status === 0 && (out.includes('FIGMA_TOKEN') || out.includes('No frames'))) {
    const msg = out.split('\n').find(l => l.trim()) ?? 'Skipped';
    return { pass: true, lines: [`⏭ ${msg.trim()}`] };
  }

  const pass     = r.status === 0;
  const summary  = out.split('\n')
    .filter(l => /✅|❌|📸/.test(l) && l.trim())
    .map(l => l.trim()).slice(0, 6);
  const fixLines = pass ? [] : out.split('\n')
    .filter(l => l.trim().startsWith('mv ') || l.includes('.new.png'))
    .map(l => '  ' + l.trim()).slice(0, 6);
  return { pass, lines: [...summary, ...fixLines] };
}

// ── Inline gate computations (sync — no subprocess) ──────────────────────────
function computeGate1() {
  const vars   = snapshotAge(SNAP_VARS);
  const struct = snapshotAge(SNAP_STRUCT);
  const bnd    = boundAge();
  const lines  = [];
  let warn     = false;

  if (vars === null) {
    lines.push(C.red(`${SNAP_VARS} missing — run /rms-parity Phase 1`)); warn = true;
  } else if (vars > 24) {
    lines.push(C.yellow(`⚠️  ${SNAP_VARS} is ${vars}h old`)); warn = true;
  } else {
    lines.push(`${SNAP_VARS} ✓ (updated today)`);
  }

  if (struct === null) {
    lines.push(C.red(`${SNAP_STRUCT} missing — run /rms-parity Phase 1`)); warn = true;
  } else if (struct > 24) {
    lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old`)); warn = true;
  } else {
    lines.push(`${SNAP_STRUCT} ✓ (updated today)`);
  }

  if (bnd === null) {
    lines.push(C.red('bound-tokens.json missing — run /rms-parity Phase 2 Step 1b')); warn = true;
  } else if (bnd > 24) {
    lines.push(C.yellow(`⚠️  bound-tokens.json is ${bnd}h old`)); warn = true;
  } else {
    lines.push(`bound-tokens.json ✓ (${bnd}h old)`);
  }

  return { pass: !warn, lines };
}

function computeGate5() {
  if (!existsSync(join(ROOT, THEME))) {
    return { pass: false, lines: [C.red(`theme CSS not found at ${THEME}`)] };
  }

  const themeText = readFileSync(join(ROOT, THEME), 'utf8');
  const declared  = [...new Set(
    [...themeText.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)].map(m => '--' + m[1])
  )];

  const srcFiles = [THEME, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
  const allSrc   = srcFiles.map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n');

  const unused = declared.filter(v => !KNOWN_UNUSED.has(v) && !allSrc.includes(`var(${v})`));
  const pass   = unused.length === 0;
  return {
    pass,
    lines: pass
      ? [`✅ 0 unused vars  (${KNOWN_UNUSED.size} known-unused exempted)`]
      : [`❌ ${unused.length} unused: ${unused.join(', ')}`],
  };
}

function computeGate6() {
  const scanTargets = [THEME, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
  const scanArgs    = ['-n', '-E'];

  const hexR = sh('grep', [
    ...scanArgs,
    '(background|color|border|fill|stroke)\\s*:[^;]*#[0-9a-fA-F]{3,8}\\b',
    ...scanTargets,
  ]);

  const KNOWN_HEX_VARS = ['--swatch-stripe', '--semantic-positive', '--semantic-negative',
    '--semantic-warning', '--input-auto-border', '--overlay-bg', '--scrollbar-thumb', '--neutral-'];

  const hexHits = (hexR.stdout || '').split('\n').filter(l => {
    if (!l.trim()) return false;
    const codePart = l.replace(/^[^:]+:\d+:\s*/, '');
    if (/^\s*--[a-zA-Z]/.test(codePart)) return false;
    const stripped = codePart.replace(/\/\*[^*]*\*\//g, '');
    if (!/#[0-9a-fA-F]{3,8}\b/.test(stripped)) return false;
    if (KNOWN_HEX_VARS.some(k => l.includes(k))) return false;
    if (/color\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i.test(codePart)) return false;
    return true;
  });

  const fsR = sh('grep', [
    ...scanArgs,
    'font-size\\s*:\\s*[0-9]+(\\.[0-9]+)?(px|rem|em)',
    ...scanTargets,
  ]);

  const fsHits = (fsR.stdout || '').split('\n').filter(l => {
    if (!l.trim()) return false;
    if (/[`"'].*font-size.*[`"']/.test(l)) return false;
    if (KNOWN_FS_EXCEPTS.some(e => l.includes(e.file ?? e) && l.includes(e.size ?? e))) return false;
    return true;
  });

  const hits = [...hexHits, ...fsHits];
  const pass = hits.length === 0;
  return {
    pass,
    lines: pass
      ? ['✅ Clean']
      : [`❌ ${hits.length} hit(s):`, ...hits.slice(0, 15).map(l => '  ' + l)],
  };
}

function computeGate7() {
  if (!PLUGINS.length) {
    return { pass: true, lines: ['⏭ No plugins configured in ds-config.json — skipped'] };
  }

  const stale       = [];
  const themePath   = join(ROOT, THEME);
  const themeMtime  = existsSync(themePath) ? statSync(themePath).mtime : null;

  for (const p of PLUGINS) {
    const src = join(ROOT, `apps/${p}/ui.src.html`);
    const out = join(ROOT, `apps/${p}/ui.html`);
    if (!existsSync(src) || !existsSync(out)) continue;
    if (statSync(src).mtime > statSync(out).mtime) stale.push(p);
    else if (themeMtime && themeMtime > statSync(out).mtime && !stale.includes(p)) {
      stale.push(`${p} (theme newer)`);
    }
  }

  const pass = stale.length === 0;
  return {
    pass,
    lines: pass
      ? ['✅ All outputs current']
      : [`❌ Stale — rebuild: ${stale.join(', ')}`],
  };
}

// ── Main — async so we can await the parallel gate batch ─────────────────────
(async () => {
  const gates   = [];
  let anyFail   = false;

  function addGate(label, result) {
    if (!result.pass) anyFail = true;
    gates.push({ label, ...result });
  }

  // Gate 1 — sync (file stat only, no subprocess)
  addGate('Snapshot freshness', computeGate1());

  // Gates 2, 3, 4, 8, 9 — all subprocess-based; launch concurrently
  // Total subprocess wait time = max(slowest gate) instead of sum(all gates)
  const [r2, r3, r4, r8, r9] = await Promise.all([
    runScriptAsync('parity-check.mjs'),
    runScriptAsync('structure-check.mjs'),
    runScriptAsync('bound-check.mjs'),
    runScriptAsync('subcomponent-isolation-check.mjs'),
    runScriptAsync('visual-regression-check.mjs'),
  ]);

  // Gates 5, 6, 7 — inline sync; run while subprocesses were already running above
  // Order: present them in their logical gate positions
  addGate('Token parity  (color · sizing · typography)',               parseGate2(r2));
  addGate('Structure     (snapshot · CSS height · base-rule vars)',    parseGate3(r3));
  addGate('Bound-token coverage  (DS frames → CSS vars)',              parseGate4(r4));
  addGate('Unused CSS vars',                                           computeGate5());
  addGate('Hardcoded values  (no raw hex / font-size in rules)',       computeGate6());
  addGate('Build freshness  (source ≤ built output)',                  computeGate7());
  addGate('Sub-component isolation  (no parent rule overrides sub-component styles)', parseGate8(r8));
  addGate('Visual regression  (frames match stored references)',       parseGate9(r9));

  // ── Final report ─────────────────────────────────────────────────────────────
  console.log('\n' + C.bold('─'.repeat(WIDTH)));
  console.log(C.bold(`  PARITY AUDIT  ·  ${today}`));
  console.log(C.bold('─'.repeat(WIDTH)) + '\n');

  gates.forEach((g, i) => {
    const icon = g.pass ? C.green('✅') : C.red('❌');
    console.log(`${icon}  [${i + 1}] ${C.bold(g.label)}`);
    for (const line of g.lines || []) console.log(`       ${line}`);
    console.log();
  });

  console.log('─'.repeat(WIDTH));
  if (anyFail) {
    console.log(C.bold(C.red('\n  AUDIT FAILED — fix all ❌ above before declaring parity\n')));
  } else {
    console.log(C.bold(C.green('\n  ALL GATES PASS ✅\n')));
  }
  console.log('─'.repeat(WIDTH) + '\n');

  // ── Write parity history ──────────────────────────────────────────────────────
  const histPath = join(ROOT, 'parity-history.json');
  let hist = [];
  try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
  hist.push({
    date:      today,
    timestamp: new Date().toISOString(),
    pass:      gates.filter(g => g.pass).length,
    fail:      gates.filter(g => !g.pass).length,
    total:     gates.length,
    gates:     gates.map(g => ({ label: g.label, pass: g.pass })),
  });
  if (hist.length > 100) hist = hist.slice(-100);
  try { writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n'); } catch {}

  process.exit(anyFail ? 1 : 0);
})();
