#!/usr/bin/env node
// test/skill-evals/summarize.mjs - the tables of a recorded evaluation, from its saved runs.
//
//   node test/skill-evals/summarize.mjs <folder> [--md]
//
// <folder> holds result files (<variant>.<model>.jsonl), in it or one level down (build/, prototype/). Each file is one
// side of the comparison: the variant (mcp: Claude with the Figma MCP alone; cookbook: with the skill) on one model.
// Prints, per side, the runs that pass, the cost, the turns and the input read; then each task across the sides, and
// the checks that failed most. Private tasks (private-*) are never printed.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const LABEL = { mcp: 'Claude alone', cookbook: 'with the skill', g9: 'with the skill (g9)', bare: 'bare guide', baseline: 'one-file guide' };
const MODEL = (m) => (/opus/.test(m) ? 'Opus' : /sonnet/.test(m) ? 'Sonnet' : /haiku/.test(m) ? 'Haiku' : m);

export function readFolder(dir) {
  const files = [];
  const add = (d, set) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f.endsWith('.jsonl')) files.push({ path: p, set }); else if (statSync(p).isDirectory() && !['transcripts', 'smoke'].includes(f) && set === null) add(p, f); } };
  add(dir, null);
  return files.map(({ path, set }) => {
    const [variant, ...model] = basename(path).replace(/\.jsonl$/, '').split('.');
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !/^private/.test(r.task));
    return { set: set ?? 'guide', variant, model: model.join('.'), rows };
  }).filter((s) => s.rows.length);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function sideStats(s) {
  const u = s.rows.map((r) => r.usage ?? {});
  return {
    set: s.set, side: `${MODEL(s.model)}, ${LABEL[s.variant] ?? s.variant}`, variant: s.variant, model: s.model,
    runs: s.rows.length, pass: s.rows.filter((r) => r.pass).length,
    cost: u.reduce((a, x) => a + (x.cost ?? 0), 0), turns: mean(u.map((x) => x.turns ?? 0)), input: mean(u.map((x) => x.input ?? 0)),
    engine: [...new Set(s.rows.map((r) => r.engineHash))].join(', '), guide: [...new Set(s.rows.map((r) => r.guideHash))].join(', '),
  };
}

export function summarize(sides) {
  const out = [];
  for (const set of [...new Set(sides.map((s) => s.set))]) {
    const group = sides.filter((s) => s.set === set).sort((a, b) => a.model.localeCompare(b.model) || (a.variant === 'mcp' ? -1 : 1));
    out.push(`### ${set}`, '', '| Side | Pass | Cost | Turns a run | Input a run | Engine |', '|---|---|---|---|---|---|');
    for (const s of group.map(sideStats)) out.push(`| ${s.side} | ${s.pass}/${s.runs} | $${s.cost.toFixed(2)} | ${s.turns.toFixed(1)} | ${Math.round(s.input / 1000)}k | ${s.engine} |`);
    const tasks = [...new Set(group.flatMap((s) => s.rows.map((r) => r.task)))];
    out.push('', `| Task | ${group.map((s) => sideStats(s).side).join(' | ')} |`, `|---|${group.map(() => '---').join('|')}|`);
    for (const t of tasks) out.push(`| ${t} | ${group.map((s) => { const rs = s.rows.filter((r) => r.task === t); return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : ''; }).join(' | ')} |`);
    const fails = new Map();
    for (const s of group) for (const r of s.rows) for (const c of [...(r.checks ?? []), ...(r.rules ?? [])]) if (!c.ok) { const k = `${sideStats(s).side}: ${c.name}`; fails.set(k, (fails.get(k) ?? 0) + 1); }
    if (fails.size) { out.push('', 'Checks that failed most:', ''); for (const [k, n] of [...fails].sort((a, b) => b[1] - a[1]).slice(0, 12)) out.push(`- ${k} (${n})`); }
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('summarize.mjs')) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) { console.log('Usage: node test/skill-evals/summarize.mjs <folder of result files>'); process.exit(2); }
  process.stdout.write(summarize(readFolder(dir)) + '\n');
}
