#!/usr/bin/env node
// test/skill-evals/rescore-prototype.mjs - score the prototype evaluation's saved runs again with the current scorers,
// without running them again: each row keeps the files the run changed, and its final reply is read from its transcript.
//
//   node test/skill-evals/rescore-prototype.mjs [results/prototype/<variant>.<model>.jsonl …]   (default: every file there)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTO } from './proto-tasks.mjs';
import { globalChecks } from './rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'results', 'prototype');
const files = process.argv.slice(2).length ? process.argv.slice(2) : (existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.jsonl')).map((f) => join(OUT, f)) : []);

function finalOf(transcript) {
  if (!existsSync(transcript)) return null;
  const results = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === 'result');
  return results.map((r) => String(r.result ?? '')).join('\n\n');
}

for (const file of files) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const [variant, ...model] = basename(file).replace(/\.jsonl$/, '').split('.');
  let changed = 0;
  for (const row of rows) {
    const task = PROTO.find((t) => t.id === row.task);
    if (!task) continue;
    const final = finalOf(join(OUT, 'transcripts', `${variant}.${model.join('.')}.${row.task}.${row.run}.jsonl`));
    if (final == null) { console.log(`  ⏭ ${row.task} #${row.run}: no transcript, kept as scored`); continue; }
    const files = row.files ?? {};
    const ctx = { changed: row.changed ?? [], read: (p) => files[p] ?? null, final, all: final, commits: row.commits ?? 1, bash: [], calls: [] };
    const checks = await task.score(ctx);
    const rules = row.rules ?? globalChecks(ctx, task);
    const pass = [...checks, ...rules].every((c) => c.ok);
    if (pass !== row.pass) changed++;
    Object.assign(row, { checks, pass });
    if (!pass) console.log(`  ✗ ${variant} ${row.task} #${row.run}  (${[...checks, ...rules].filter((c) => !c.ok).map((c) => c.name).join('; ')})`);
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${basename(file)}: ${rows.length} rows, ${rows.filter((r) => r.pass).length} pass, ${changed} changed verdict`);
}
