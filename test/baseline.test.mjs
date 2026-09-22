// baseline.mjs - gate-level adoption baseline + ratchet (feature #2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadBaselineLabels, currentFailingLabels, classifyBaseline, writeBaseline } from '../baseline.mjs';

const G = (label, pass, planLimited = false) => ({ label, pass, planLimited });

test('currentFailingLabels ignores passing and plan-limited gates', () => {
  const gates = [G('A', true), G('B', false), G('C', false, true), G('D', false)];
  assert.deepEqual(currentFailingLabels(gates), ['B', 'D']);
});

test('classifyBaseline splits debt / regressions / ratcheted / stale', () => {
  const gates = [G('A', true), G('B', false), G('C', false), G('D', true), G('E', false, true)];
  //            A passes, B fails, C fails, D passes, E plan-limited
  const baseline = ['B', 'D', 'GONE'];   // B still red (debt), D now green (ratchet), GONE removed (stale)
  const r = classifyBaseline(gates, baseline);
  assert.deepEqual(r.debt, ['B']);           // failing AND baselined
  assert.deepEqual(r.regressions, ['C']);    // failing AND NOT baselined
  assert.deepEqual(r.ratcheted, ['D']);      // baselined but now passing
  assert.deepEqual(r.stale, ['GONE']);       // baseline label with no matching gate
  assert.equal(r.gateFail, true);            // C is a real regression
});

test('classifyBaseline: everything covered by the baseline does not fail', () => {
  const gates = [G('A', false), G('B', false)];
  const r = classifyBaseline(gates, ['A', 'B']);
  assert.deepEqual(r.regressions, []);
  assert.equal(r.gateFail, false);
  assert.deepEqual(r.debt.sort(), ['A', 'B']);
});

test('classifyBaseline with no baseline treats every failure as a regression', () => {
  const gates = [G('A', false), G('B', true)];
  const r = classifyBaseline(gates, []);
  assert.deepEqual(r.regressions, ['A']);
  assert.equal(r.gateFail, true);
});

test('loadBaselineLabels degrades to null on missing/malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  assert.equal(loadBaselineLabels(join(dir, 'nope.json')), null);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.equal(loadBaselineLabels(bad), null);
  const noGates = join(dir, 'nogates.json');
  writeFileSync(noGates, JSON.stringify({ created: 'x' }));
  assert.deepEqual(loadBaselineLabels(noGates), []);   // valid JSON, no gates array
});

test('writeBaseline round-trips the current failing gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  const path = join(dir, 'parity-baseline.json');
  const gates = [G('A', true), G('B', false), G('C', false, true), G('D', false)];
  const written = writeBaseline(path, gates);
  assert.deepEqual(written, ['B', 'D']);
  assert.ok(existsSync(path));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(doc.gates, ['B', 'D']);
  assert.ok(typeof doc.$note === 'string' && doc.$note.length > 0);
  assert.deepEqual(loadBaselineLabels(path), ['B', 'D']);   // reads back what it wrote
});
