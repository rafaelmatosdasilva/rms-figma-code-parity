// The engine must stay generic: it is exercised against private projects while it is built, and
// nothing from them (app names, repo names, their design system's component or class names) may
// end up in the engine's code, tests, examples or docs. This guard fails the moment one does.
// The forbidden terms are stored ONLY as hashes, so this file does not leak them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = new Set([
  'c411366b16d3e6f1', '1c52ae64d0c2147e', '5d986e63ff2f763b', '6d276d4c8562f9ca', 'e25e4e0bdefb175a',
  'f482813e1f552975', 'a014e20238d85a8b', '465a31889376534d', 'a17b72836b3c767c', '214bd8fc72fc14a5',
  '7645004daad329c8', '8a85212edd9b1cbf', '6f7e1788cf61f933', '58fc42db10026dd2', 'dc90e782ef3514fa',
  '4b58e238abcdc554', 'ea44371c73220699',
  '8d808f2ceea98a66', '13e1c22c1e6e6168', 'ac5f628a2d3196cb', '6cbf681846a571eb', '40c1f88fbe317aa3',
  'd1d40828ba0a9a71', '3ed4ed1073d30d61',
]);
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Every word run of 1 to 4 words, joined with "-" and with nothing, so "Some Name", "some-name",
// "some_name" and "someName" all normalise to the same candidates.
export function forbiddenHits(text) {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      for (const cand of [run.join('-'), run.join('')]) if (FORBIDDEN.has(hash(cand))) hits.add(`${i}:${n}`);
    }
  }
  return hits.size;
}

test('no private test-bed names anywhere in the engine repo', () => {
  const list = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const files = [...new Set([...list(['ls-files']), ...list(['ls-files', '--others', '--exclude-standard'])])]
    .filter((f) => /\.(mjs|js|md|json|ya?ml|sh|html|css|txt)$/.test(f) || !/\./.test(f.split('/').pop()));
  const offenders = [];
  for (const f of files) {
    let text; try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const n = forbiddenHits(text);
    if (n) offenders.push(`${f} (${n})`);
  }
  assert.deepEqual(offenders, [], 'private test-bed names found in: ' + offenders.join(', '));
});

test('the matcher normalises spacing, case and separators', () => {
  assert.equal(forbiddenHits('a perfectly generic sentence about buttons and tokens'), 0);
});
