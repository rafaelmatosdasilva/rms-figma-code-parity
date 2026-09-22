// eval-run.mjs - the evals runner (I7). A SEPARATE entry point from the repo audit: it points the
// DS-conformance core at an agent's GENERATED candidates (not the repo), and reports metrics.
// It NEVER gates the repo. Run: node eval-run.mjs   (advisory; exit 1 only under evals.strict).
//
// v1 is deterministic: candidates are PRE-GENERATED files under evals.outDir/<id>.<ext>. Driving a
// live agent to produce them is a pluggable adapter (the next step; see plans/PARITY-evals-spec.md).
//
// ds-config.json:
//   "evals": {
//     "cases": [ { "id": "login", "prompt": "build a login screen with the DS", "component": "input" } ],
//     "outDir": "evals",            // where <id>.<ext> candidates live (default: "evals")
//     "strict": false               // true → exit 1 when any candidate has violations
//   }

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evalConformance } from './eval-check.mjs';

const CANDIDATE_EXTS = ['html', 'htm', 'jsx', 'tsx', 'vue', 'svelte', 'js', 'ts', 'md', 'txt'];

// Assemble the DS context the core needs: the declared CSS var universe + the DS component classes.
export function loadContext(ROOT, cfg) {
  const themePaths = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const pluginPaths = [cfg.paths?.pluginCSS ?? []].flat();
  const cssVars = new Set();
  for (const p of [...themePaths, ...pluginPaths]) {
    const abs = resolve(ROOT, p);
    if (!existsSync(abs)) continue;
    let css; try { css = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of css.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) cssVars.add(m[1]);
  }
  const dsClasses = new Set();
  for (const sel of Object.values(cfg.componentSelectors || {})) {
    const cls = String(sel).match(/[.#][\w-]+/)?.[0];
    if (cls) dsClasses.add(cls);
  }
  const struct = (() => { try { return JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotStructure || 'figma-structure.snapshot.json'), 'utf8')); } catch { return null; } })();
  for (const name of Object.keys(struct?.components || {})) dsClasses.add('.' + name.charAt(0).toLowerCase() + name.slice(1));
  return { cssVars, dsClasses };
}

// A configurable command adapter, so ANY agent/CLI can plug in (no provider lock-in). The command
// runs via the shell; the caller decides what it reads/writes. Injectable `run` for tests.
const defaultRun = (cmd, input, env) => execFileSync('/bin/sh', ['-c', cmd], {
  input: input ?? '', env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000,
});

// GENERATION adapter (I7): run `cmd` to produce a candidate from the prompt. The prompt is piped on
// stdin; the DS context path (llms.txt) is in $EVAL_CONTEXT, and $EVAL_ID / $EVAL_COMPONENT are set.
// The candidate is the command's stdout. Returns null on any failure (degrade-safe).
export function generateCandidate(c, cmd, ctxPath, run = defaultRun) {
  if (!cmd) return null;
  const prompt = `${c.prompt || ''}${c.component ? `\n\nUse the design system component: ${c.component}.` : ''}`;
  try {
    const out = run(cmd, prompt, { EVAL_CONTEXT: ctxPath || '', EVAL_ID: c.id || '', EVAL_COMPONENT: c.component || '' });
    return out && out.trim() ? out : null;
  } catch { return null; }
}

// LLM-JUDGE adapter (I7, advisory): run `cmd` with a JSON payload on stdin ({id,prompt,component,
// candidate}); it must print a JSON verdict {ok:boolean, notes?:string}. Advisory only - it scores
// judgment (right component for the intent, empty/error states), never gates. Returns null on failure.
export function judgeCandidate(c, code, cmd, run = defaultRun) {
  if (!cmd || !code || !code.trim()) return null;
  const payload = JSON.stringify({ id: c.id, prompt: c.prompt || '', component: c.component ?? null, candidate: code });
  try {
    const out = run(cmd, payload, { EVAL_ID: c.id || '' });
    const m = out && out.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const v = JSON.parse(m[0]);
    return { ok: v.ok === true, notes: typeof v.notes === 'string' ? v.notes : '' };
  } catch { return null; }
}

// Pure orchestration: run each case's candidate through the conformance core. `loadCandidate(case)`
// returns the candidate code string (or '' when none). Injectable, so this is unit-testable.
export function runEvals(cases, ctx, loadCandidate) {
  const results = [];
  for (const c of cases) {
    const code = loadCandidate(c) || '';
    const { violations, metrics } = evalConformance(code, ctx);
    results.push({ id: c.id, prompt: c.prompt || '', component: c.component ?? null, code, metrics, violations });
  }
  const n = results.length;
  const produced = results.filter((r) => r.metrics.produced).length;
  const clean = results.filter((r) => r.metrics.clean).length;
  const violations = results.reduce((s, r) => s + r.violations.length, 0);
  return {
    results,
    summary: {
      cases: n,
      produced,
      clean,
      zeroFixRate: n ? Math.round((clean / n) * 100) : null,
      violations,
    },
  };
}

function fileLoader(ROOT, outDir) {
  return (c) => {
    for (const ext of CANDIDATE_EXTS) {
      const abs = resolve(ROOT, outDir, `${c.id}.${ext}`);
      if (existsSync(abs)) { try { return readFileSync(abs, 'utf8'); } catch { /* keep trying */ } }
    }
    return '';
  };
}

async function main() {
  const ROOT = process.cwd();
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
    console.error('❌ ds-config.json not found at project root.'); process.exit(1);
  }
  const cases = cfg.evals?.cases || [];
  if (!cases.length) {
    console.log('\n⏭  evals: no cases configured (ds-config.json → evals.cases[]). Nothing to run.\n');
    process.exit(0);
  }
  const outDir = cfg.evals?.outDir || 'evals';
  const ext = cfg.evals?.ext || 'html';
  const ctx = loadContext(ROOT, cfg);

  // GENERATION (optional): when evals.generate.cmd is set, produce the candidate from the prompt.
  // Don't overwrite an existing candidate unless --generate is passed. Degrade-safe: a failure just
  // leaves whatever candidate exists (or none).
  const genCmd = cfg.evals?.generate?.cmd;
  const forceGen = process.argv.includes('--generate');
  const ctxPath = resolve(ROOT, cfg.contracts?.llmsOut || join(outDir === 'contracts' ? outDir : 'contracts', 'llms.txt'));
  if (genCmd) {
    for (const c of cases) {
      const target = resolve(ROOT, outDir, `${c.id}.${ext}`);
      if (!forceGen && existsSync(target)) continue;
      const code = generateCandidate(c, genCmd, existsSync(ctxPath) ? ctxPath : '');
      if (code) { try { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code); console.log(`   ↻ generated ${c.id} via evals.generate.cmd`); } catch { /* keep going */ } }
    }
  }

  const { results, summary } = runEvals(cases, ctx, fileLoader(ROOT, outDir));

  // LLM-JUDGE (optional, advisory): score each produced candidate. Never gates.
  const judgeCmd = cfg.evals?.judge?.cmd;
  if (judgeCmd) {
    for (const r of results) {
      if (!r.metrics.produced) continue;
      const v = judgeCandidate({ id: r.id, prompt: r.prompt, component: r.component }, r.code, judgeCmd);
      if (v) r.judge = v;
    }
  }
  const judged = results.filter((r) => r.judge).length;
  const judgePass = results.filter((r) => r.judge?.ok).length;

  console.log(`\n─── DS-conformance evals ─────────────────────────────────────────`);
  console.log(`   context: ${ctx.cssVars.size} DS vars · ${ctx.dsClasses.size} DS classes · candidates in ${outDir}/${genCmd ? ' · generate:on' : ''}${judgeCmd ? ' · judge:on' : ''}\n`);
  for (const r of results) {
    const icon = !r.metrics.produced ? '⏭' : r.metrics.clean ? '✅' : '❌';
    const note = !r.metrics.produced ? 'no candidate file' :
      r.metrics.clean ? 'clean (zero-fix)' :
      `${r.violations.length} violation(s): ` + r.violations.slice(0, 6).map((v) => `${v.type} ${v.value}`).join(', ');
    const judge = r.judge ? `   ${r.judge.ok ? '⚖️ ok' : '⚖️ review'}${r.judge.notes ? ` — ${r.judge.notes}` : ''}` : '';
    console.log(`  ${icon} ${r.id}${r.component ? ` [${r.component}]` : ''} — ${note}${judge}`);
  }
  console.log(`\n   ${summary.produced}/${summary.cases} produced · ${summary.clean}/${summary.cases} zero-fix (${summary.zeroFixRate}%) · ${summary.violations} violation(s)${judged ? ` · judge ${judgePass}/${judged} ok (advisory)` : ''}`);
  console.log(`   Advisory: evals measure agent output, they never gate the repo.\n`);

  // History (best-effort; capped)
  try {
    const hp = join(ROOT, 'evals-history.json');
    let hist = []; try { hist = JSON.parse(readFileSync(hp, 'utf8')); } catch { /* first run */ }
    hist.push({ timestamp: new Date().toISOString(), ...summary, judged, judgePass });
    if (hist.length > 100) hist = hist.slice(-100);
    writeFileSync(hp, JSON.stringify(hist, null, 2) + '\n');
  } catch { /* optional */ }

  const strict = cfg.evals?.strict === true;
  process.exit(strict && summary.violations > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
