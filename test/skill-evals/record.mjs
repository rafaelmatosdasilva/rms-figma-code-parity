#!/usr/bin/env node
// test/skill-evals/record.mjs - keep the runs of an evaluation in the repository, next to what RESULTS.md says of them.
//
//   node test/skill-evals/record.mjs <name> <results folder or file>…
//
// Copies each result file into test/skill-evals/records/<name>/ (a build/ or prototype/ file keeps its folder), every
// row as it was scored, without what is not the run's own work or must stay out of the repository: private tasks
// (private-*), packages a run installed (node_modules, lockfiles, build output), and anything past 40 KB in one file.
// Transcripts are never copied (they stay in results/, gitignored). Rescore and summarize read the copies as they read
// results/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP = /(^|\/)(node_modules|\.cache|dist|build\/static|coverage)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const MAX = 40 * 1024;

export function pruneRow(row) {
  if (/^private/.test(row.task)) return null;
  const files = {};
  for (const [p, t] of Object.entries(row.files ?? {})) {
    if (SKIP.test(p)) continue;
    const text = String(t ?? '');
    files[p] = text.length > MAX ? `${text.slice(0, MAX)}\n… (${text.length - MAX} more characters left out of the record)` : t;
  }
  return { ...row, changed: (row.changed ?? []).filter((p) => !SKIP.test(p)), files };
}

function sources(p) {
  if (statSync(p).isFile()) return [{ path: p, sub: /\/(build|prototype)\/[^/]+$/.exec(p)?.[1] ?? '' }];
  const out = [];
  for (const f of readdirSync(p)) {
    const q = join(p, f);
    if (f.endsWith('.jsonl')) out.push({ path: q, sub: ['build', 'prototype'].includes(basename(p)) ? basename(p) : '' });
    else if (['build', 'prototype'].includes(f) && statSync(q).isDirectory()) for (const g of readdirSync(q)) if (g.endsWith('.jsonl')) out.push({ path: join(q, g), sub: f });
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('record.mjs')) {
  const [name, ...from] = process.argv.slice(2);
  if (!name || !from.length || !from.every(existsSync)) { console.log('Usage: node test/skill-evals/record.mjs <name> <results folder or file>…'); process.exit(2); }
  for (const src of from.flatMap(sources)) {
    const rows = readFileSync(src.path, 'utf8').split('\n').filter(Boolean).map((l) => pruneRow(JSON.parse(l))).filter(Boolean);
    const dir = join(HERE, 'records', name, src.sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, basename(src.path)), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${join('records', name, src.sub, basename(src.path))}: ${rows.length} rows`);
  }
}
