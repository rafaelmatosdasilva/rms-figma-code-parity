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

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Pure orchestration: run each case's candidate through the conformance core. `loadCandidate(case)`
// returns the candidate code string (or '' when none). Injectable, so this is unit-testable.
export function runEvals(cases, ctx, loadCandidate) {
  const results = [];
  for (const c of cases) {
    const code = loadCandidate(c) || '';
    const { violations, metrics } = evalConformance(code, ctx);
    results.push({ id: c.id, prompt: c.prompt || '', component: c.component ?? null, metrics, violations });
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
  const ctx = loadContext(ROOT, cfg);
  const { results, summary } = runEvals(cases, ctx, fileLoader(ROOT, outDir));

  console.log(`\n─── DS-conformance evals ─────────────────────────────────────────`);
  console.log(`   context: ${ctx.cssVars.size} DS vars · ${ctx.dsClasses.size} DS classes · candidates in ${outDir}/\n`);
  for (const r of results) {
    const icon = !r.metrics.produced ? '⏭' : r.metrics.clean ? '✅' : '❌';
    const note = !r.metrics.produced ? 'no candidate file' :
      r.metrics.clean ? 'clean (zero-fix)' :
      `${r.violations.length} violation(s): ` + r.violations.slice(0, 6).map((v) => `${v.type} ${v.value}`).join(', ');
    console.log(`  ${icon} ${r.id}${r.component ? ` [${r.component}]` : ''} — ${note}`);
  }
  console.log(`\n   ${summary.produced}/${summary.cases} produced · ${summary.clean}/${summary.cases} zero-fix (${summary.zeroFixRate}%) · ${summary.violations} violation(s)`);
  console.log(`   Advisory: evals measure agent output, they never gate the repo.\n`);

  // History (best-effort; capped)
  try {
    const hp = join(ROOT, 'evals-history.json');
    let hist = []; try { hist = JSON.parse(readFileSync(hp, 'utf8')); } catch { /* first run */ }
    hist.push({ timestamp: new Date().toISOString(), ...summary });
    if (hist.length > 100) hist = hist.slice(-100);
    writeFileSync(hp, JSON.stringify(hist, null, 2) + '\n');
  } catch { /* optional */ }

  const strict = cfg.evals?.strict === true;
  process.exit(strict && summary.violations > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
