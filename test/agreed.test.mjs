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
