// The evaluation records kept in the repository: what they hold, and what they must never hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneRow } from './skill-evals/record.mjs';
import { readFolder, summarize } from './skill-evals/summarize.mjs';

const RECORDS = join(dirname(fileURLToPath(import.meta.url)), 'skill-evals', 'records');
const files = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : f.endsWith('.jsonl') ? [p] : []; });

test('a record keeps the run as scored, without private tasks, installed packages or very large files', () => {
  assert.equal(pruneRow({ task: 'private-badge-pt', files: {} }), null);
  const r = pruneRow({ task: 'proto-settings', changed: ['prototypes/a.json', 'node_modules/x/index.js', 'package-lock.json'], files: { 'prototypes/a.json': '{}', 'node_modules/x/index.js': 'x', 'package-lock.json': '{}', 'big.css': 'a'.repeat(50000) } });
  assert.deepEqual(r.changed, ['prototypes/a.json']);
  assert.deepEqual(Object.keys(r.files), ['prototypes/a.json', 'big.css']);
  assert.match(r.files['big.css'], /more characters left out of the record\)$/);
});

test('every record in the repository: no private task, no installed package, and its README names it', () => {
  if (!existsSync(RECORDS)) return;
  const readme = readFileSync(join(RECORDS, 'README.md'), 'utf8');
  for (const dir of readdirSync(RECORDS).filter((f) => statSync(join(RECORDS, f)).isDirectory())) {
    assert.ok(readme.includes(`\`${dir}\``), `records/README.md names ${dir}`);
    for (const f of files(join(RECORDS, dir))) {
      for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        assert.ok(!/^private/.test(row.task), `${f}: a private task`);
        assert.ok(!Object.keys(row.files ?? {}).some((p) => /node_modules\//.test(p)), `${f}: an installed package`);
      }
    }
    assert.match(summarize(readFolder(join(RECORDS, dir))), /\| Side \| Pass \|/);
  }
});
