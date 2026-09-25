// I47: what Figma and the code last agreed on, fact by fact, so a difference says which side moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { loadAgreed, classify, recordAgreed, AGREED_FILE } from '../agreed.mjs';
import { compareTokens } from '../capture-compare.mjs';

const f = (key, figma, code, same = figma === code) => ({ key, figma, code, same });

test('record: only agreements are written; a difference never overwrites; the same agreement keeps its date', () => {
  const dir = makeFixture({});
  recordAgreed(dir, [f('chip · gap', '8px', '8px'), f('chip · radius', '4px', '6px')], { at: 'T1', commit: 'abc' });
  let a = loadAgreed(dir);
  assert.deepEqual(a.facts, { 'chip · gap': { figma: '8px', code: '8px', at: 'T1', commit: 'abc' } });
  const r = recordAgreed(dir, [f('chip · gap', '8px', '8px'), f('chip · gap2', '1', '1')], { at: 'T2', commit: 'def' });
  a = loadAgreed(dir);
  assert.equal(a.facts['chip · gap'].at, 'T1');                          // unchanged agreement keeps its date
  assert.equal(r.recorded, 2);
  assert.match(readFileSync(join(dir, AGREED_FILE), 'utf8'), /commit it/);
});

test('classify: which side moved since they last agreed', () => {
  const agreed = { facts: { 'chip · gap': { figma: '8px', code: '8px' } } };
  assert.equal(classify(f('chip · gap', '12px', '8px'), agreed), 'figma-moved');
  assert.equal(classify(f('chip · gap', '8px', '6px'), agreed), 'code-moved');
  assert.equal(classify(f('chip · gap', '12px', '6px'), agreed), 'both-moved');
  assert.equal(classify(f('chip · radius', '4px', '6px'), agreed), 'unknown');   // never agreed
});

test('the comparison records every fact it compares, matching or not', () => {
  const code = { tokens: { '--brand': { modes: { light: { value: '#ffffff', confidence: 'verified' } } }, '--ink': { modes: { light: { value: '#000000', confidence: 'verified' } } } } };
  const r = compareTokens(code, { color: { light: { 'brand/color': '#ffffff', 'ink/color': '#111111' } } }, { figma: { namingConvention: { dropSegments: ['color'] } } }, { EXPLICIT: {}, EXPLICIT_SIZING: {}, SKIP_TOKENS: new Set(), NULL_TOKENS: new Set(), KNOWN_NULL: new Set(), SIZING_SKIP: new Map(), TYPO: {} });
  assert.deepEqual(r.facts, [
    { key: 'token brand [light]', figma: '#ffffff', code: '#ffffff', same: true },
    { key: 'token ink [light]', figma: '#111111', code: '#000000', same: false },
  ]);
});

test('hand-back: a patch for the code, a list for Figma, nothing applied', async () => {
  const { patchLine, codePatch, figmaChanges, wantOf } = await import('../handback.mjs');
  assert.equal(patchLine('  gap: var(--gap-m);   /* note */', 'gap', 'var(--gap-xl)'), '  gap: var(--gap-xl);   /* note */');
  assert.equal(patchLine('.x { padding: var(--p-s) var(--p-m); }', 'padding (left/right)', 'var(--p-l)'), '.x { padding: var(--p-s) var(--p-l); }');
  assert.equal(patchLine('  padding: 8px;', 'padding (top/bottom)', '4px'), null);         // one value sets both axes: by hand
  assert.equal(patchLine('  border-radius: 4px 0 0 4px;', 'radius', '8px'), null);          // several corners: by hand
  assert.equal(wantOf({ expectedVar: '--gap-xl', figma: 'gap/xl' }), 'var(--gap-xl)');
  const dir = makeFixture({ 'a.css': '.chip {\n  gap: var(--gap-m);\n  height: 24px;\n}\n' });
  const p = codePatch(dir, [{ component: 'chip', field: 'gap', figma: 'gap/xl', expectedVar: '--gap-xl', at: 'a.css:2' }, { component: 'chip', field: 'background', figma: 'paints a background', at: 'a.css:1' }]);
  assert.equal(p.diff, '--- a/a.css\n+++ b/a.css\n@@ -1,3 +1,3 @@\n .chip {\n-  gap: var(--gap-m);\n+  gap: var(--gap-xl);\n   height: 24px;\n');
  assert.equal(p.manual.length, 1);
  const md = figmaChanges([{ d: { component: 'badge', field: 'gap', figma: 'gap/s', figmaValue: '4px', code: '8px', codeVar: '--gap-m', at: 'a.css:9' }, moved: 'code-moved' }], () => 'https://figma/x');
  assert.match(md, /## badge  \(\[open in Figma\]\(https:\/\/figma\/x\)\)/);
  assert.match(md, /\*\*gap\*\*: set it to the token behind --gap-m \(now gap\/s, 4px\)\. Code: a\.css:9/);
});

test('hand-back: changed lines next to each other share one hunk, and the patch applies', async () => {
  const { codePatch } = await import('../handback.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const dir = makeFixture({ 'a.css': '.bar {\n  padding: 0 var(--p-l);\n  gap: var(--gap-m);\n}\n' });
  const p = codePatch(dir, [
    { component: 'bar', field: 'padding (top/bottom)', figma: 'p/m', expectedVar: '--p-m', at: 'a.css:2' },
    { component: 'bar', field: 'gap', figma: 'gap/xl', expectedVar: '--gap-xl', at: 'a.css:3' },
  ]);
  assert.equal((p.diff.match(/^@@/gm) ?? []).length, 1);
  writeFileSync(join(dir, 'x.diff'), p.diff);
  execFileSync('git', ['apply', 'x.diff'], { cwd: dir });
  assert.equal(readFileSync(join(dir, 'a.css'), 'utf8'), '.bar {\n  padding: var(--p-m) var(--p-l);\n  gap: var(--gap-xl);\n}\n');
});
