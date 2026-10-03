#!/usr/bin/env node
// test/skill-evals/run.mjs - run the skill evaluation (idea I55). Spends model tokens; not in `node --test`.
//
//   node test/skill-evals/run.mjs --variant baseline|cookbook|skill|bare|mcp --model <id> --runs 5 --set dev|heldout|all|build|prototype
//        [--only <task-id>] [--jobs 2] [--budget 3] [--ref <git ref for baseline>] [--resume] [--dry]
//
// A run the API refused (a usage limit, a 429) is not a result: nothing is written for it, the pool stops, and
// the same command with --resume carries on, skipping each (task, run) already in the results file. Without
// --resume, a results file that already has rows is refused, so two measurements never mix.
//
// Results: one JSON line per run in test/skill-evals/results/<variant>.<model>.jsonl (demo tasks), and the
// transcripts beside them (not committed). Private tasks (DESIGN_SYSTEM_ENGINE_EVAL_PRIVATE_TASKS) write only under
// DESIGN_SYSTEM_ENGINE_EVAL_PRIVATE_OUT, never in the repository.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, makeHome, runClaude, context, decisionPoints, cleanup, keepFiles, projectHash, ENGINE, DEMO } from './lib.mjs';
import { globalChecks } from './rules.mjs';
import { DEV } from './tasks.mjs';
import { HELDOUT } from './heldout.mjs';
import { BUILD, TIDEPOOL } from './build-tasks.mjs';
import { PROTO } from './proto-tasks.mjs';
import { variant } from './variants.mjs';
import { envVar } from '../../names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1]; };
const V = arg('variant', 'baseline'), MODEL = arg('model', 'claude-sonnet-5'), RUNS = Number(arg('runs', 1)), SET = arg('set', 'dev');
const ONLY = arg('only', null), JOBS = Number(arg('jobs', 2)), BUDGET = Number(arg('budget', 3)), DRY = process.argv.includes('--dry'), RESUME = process.argv.includes('--resume');

let privateTasks = [];
const PRIVATE_TASKS = envVar(process.env, 'EVAL_PRIVATE_TASKS');
if (PRIVATE_TASKS && (SET === 'heldout' || SET === 'all' || SET === 'private')) {
  privateTasks = (await import(PRIVATE_TASKS)).PRIVATE.map((t) => ({ ...t, private: true }));
}
const sets = { dev: DEV, heldout: [...HELDOUT, ...privateTasks], private: privateTasks, all: [...DEV, ...HELDOUT, ...privateTasks], build: BUILD, prototype: PROTO };
const tasks = (sets[SET] ?? []).filter((t) => !ONLY || t.id === ONLY).map((t) => ({ ...t, set: BUILD.includes(t) ? 'build' : PROTO.includes(t) ? 'prototype' : DEV.includes(t) ? 'dev' : 'heldout', source: BUILD.includes(t) || PROTO.includes(t) ? TIDEPOOL : t.source }));
const vr = variant(V, { ref: arg('ref', undefined) });
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const engineHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ENGINE, encoding: 'utf8' }).trim() + (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ENGINE, encoding: 'utf8' }).trim() ? '+dirty' : '');
const cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
const meta = { variant: V, ref: vr.ref, guideHash: sha(vr.text), guideBytes: Buffer.byteLength(vr.text), engineHash, project: SET === 'build' || SET === 'prototype' ? `${projectHash(TIDEPOOL)}+${projectHash(join(HERE, 'build-reference'))}` : projectHash(DEMO), model: MODEL, cliVersion };
console.log(`${V} (${vr.ref}, guide ${meta.guideHash}, ${meta.guideBytes} bytes) · ${MODEL} · ${tasks.length} tasks × ${RUNS} runs · engine ${engineHash} · project ${meta.project} · ${cliVersion}`);
if (DRY) { for (const t of tasks) console.log(`  ${t.set.padEnd(8)} ${t.id}`); process.exit(0); }

const outFor = (t) => (t.private ? envVar(process.env, 'EVAL_PRIVATE_OUT') : t.set === 'build' ? join(HERE, 'results', 'build') : t.set === 'prototype' ? join(HERE, 'results', 'prototype') : join(HERE, 'results'));
const resultsFile = (t) => join(outFor(t), `${V}.${MODEL}.jsonl`);

// What is already measured, per results file. Rows from another guide or engine never mix with this one.
const done = new Set();
for (const f of new Set(tasks.filter((t) => outFor(t)).map(resultsFile))) {
  if (!existsSync(f)) continue;
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) continue;
  if (!RESUME) { console.log(`✗ ${f} already has ${rows.length} rows: add --resume to carry on, or move it away to start again`); process.exit(2); }
  const other = rows.find((r) => r.guideHash !== meta.guideHash || r.engineHash !== meta.engineHash || (r.project && r.project !== meta.project));
  if (other) { console.log(`✗ ${f} has rows from guide ${other.guideHash} / engine ${other.engineHash}, not ${meta.guideHash} / ${engineHash}: move it away to start again`); process.exit(2); }
  for (const r of rows) done.add(`${r.task}#${r.run}`);
}
const jobs = tasks.flatMap((t) => Array.from({ length: RUNS }, (_, run) => ({ t, run }))).filter((j) => !done.has(`${j.t.id}#${j.run}`));
if (done.size) console.log(`resuming: ${done.size} runs already measured, ${jobs.length} to go`);

class Refused extends Error {}

async function one({ t, run }) {
  const out = outFor(t);
  if (!out) throw new Error('private tasks need DESIGN_SYSTEM_ENGINE_EVAL_PRIVATE_OUT');
  mkdirSync(join(out, 'transcripts'), { recursive: true });
  const dir = makeProject(t.source ?? DEMO, t.setup, { engine: vr.engine !== false, skillFiles: t.skillFiles ?? [] });
  const { home, path } = makeHome(vr, { cliOnPath: t.cliOnPath !== false });
  const events = [];
  let sessionId = null, error = null;
  for (const prompt of t.prompts ?? [t.prompt]) {
    const r = await runClaude({ cwd: dir, home, path, prompt: `${vr.prefix ?? '/rms-design-system-engine '}${prompt}`, model: MODEL, resume: sessionId, budget: BUDGET });
    events.push(...r.events);
    sessionId = r.sessionId ?? sessionId;
    if (r.infra) {
      writeFileSync(join(out, 'transcripts', `${V}.${MODEL}.${t.id}.${run}.refused.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      cleanup(dir, home);
      throw new Refused(r.infra);
    }
    if (r.error) { error = r.error; break; }
  }
  const ctx = context(events, dir);
  let taskChecks;
  try { taskChecks = error ? [{ name: 'the run finished', ok: false, detail: error }] : await t.score(ctx); }
  catch (e) { taskChecks = [{ name: 'the scorer ran', ok: false, detail: e.message }]; }
  const rules = globalChecks(ctx, t);
  const row = { ...meta, task: t.id, set: t.set, run, pass: [...taskChecks, ...rules].every((c) => c.ok), checks: taskChecks, rules, usage: ctx.usage, calls: ctx.calls.length, decisionPoints: decisionPoints(ctx), engineRuns: ctx.engine.length, enginePaths: [...new Set(ctx.engine.map((b) => b.command.match(/node\s+(\S*audit\.mjs)/)?.[1] ?? 'rms-design-system-engine'))], changed: ctx.changed, commits: ctx.commits, files: keepFiles(ctx, t.keep ?? []), error, at: new Date().toISOString() };
  writeFileSync(join(out, 'transcripts', `${V}.${MODEL}.${t.id}.${run}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  appendFileSync(resultsFile(t), JSON.stringify(row) + '\n');
  cleanup(dir, home);
  console.log(`  ${row.pass ? '✓' : '✗'} ${t.id} #${run}  $${ctx.usage.cost.toFixed(2)}  ${ctx.usage.turns} turns${row.pass ? '' : `  (${[...taskChecks, ...rules].filter((c) => !c.ok).map((c) => c.name).join('; ')})`}`);
  return row;
}

// A small pool: each run starts a Claude session and, through the audit, a Chrome. A refused run stops it.
const rows = [];
let next = 0, refused = null;
await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
  while (!refused && next < jobs.length) {
    const j = jobs[next++];
    try { rows.push(await one(j)); } catch (e) {
      if (e instanceof Refused) { refused ??= e.message; console.log(`  ⏸ ${j.t.id} #${j.run}  not run: ${e.message}`); } else console.log(`  ✗ ${j.t.id} #${j.run}  harness error: ${e.message}`);
    }
  }
}));
const cost = rows.reduce((k, r) => k + r.usage.cost, 0);
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed · $${cost.toFixed(2)}`);
const left = jobs.length - rows.length;
if (refused) console.log(`⏸ stopped: the API refused a run (${refused}). ${left} runs not measured; run the same command with --resume after the limit resets.`);
else if (left) console.log(`⚠ ${left} runs failed in the harness; run the same command with --resume to retry them.`);
process.exit(refused || left ? 3 : 0);
