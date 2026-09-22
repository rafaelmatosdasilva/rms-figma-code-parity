// eval-run.mjs - the evals runner (I7). runEvals is pure (injected candidate loader); loadContext
// assembles the DS var/class universe from the project files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runEvals, loadContext, generateCandidate, judgeCandidate, summarize } from '../eval-run.mjs';
import { makeFixture } from './helpers.mjs';

const ctx = { cssVars: new Set(['--color-bg']), dsClasses: new Set(['.buttonPrimary']) };

test('runEvals aggregates produced / zero-fix / violations across cases', () => {
  const candidates = {
    ok: '<button class="buttonPrimary" style="color: var(--color-bg)">Go</button>',
    bad: '<div style="color:#ff0000; padding: 9px">x</div>',
    missing: '',
  };
  const cases = [{ id: 'ok' }, { id: 'bad', component: 'input' }, { id: 'missing' }];
  const { results, summary } = runEvals(cases, ctx, (c) => candidates[c.id]);

  assert.equal(summary.cases, 3);
  assert.equal(summary.produced, 2);            // ok + bad produced; missing did not
  assert.equal(summary.clean, 1);               // only ok is clean
  assert.equal(summary.zeroFixRate, 33);        // 1/3
  assert.ok(summary.violations >= 2);           // bad has a raw color + a raw dimension
  assert.equal(summary.inlineStyles, 2);         // ok + bad each carry one style= attribute
  const bad = results.find((r) => r.id === 'bad');
  assert.ok(bad.violations.some((v) => v.type === 'raw-color'));
});

test('loadContext reads the DS var universe and classes from project files', () => {
  const dir = makeFixture({
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 'struct.json' },
      componentSelectors: { buttonPrimary: '.buttonPrimary' } },
    'theme.css': ':root { --color-bg: #fff; --radii-button: 8px; }\n',
    'struct.json': { components: { inputField: {}, buttonPrimary: {} } },
  });
  const cfg = JSON.parse(readFileSync(dir + '/ds-config.json', 'utf8'));
  const ctx2 = loadContext(dir, cfg);
  assert.ok(ctx2.cssVars.has('--color-bg') && ctx2.cssVars.has('--radii-button'));
  assert.ok(ctx2.dsClasses.has('.buttonPrimary'));
  assert.ok(ctx2.dsClasses.has('.inputField'));   // derived from the structure snapshot
});

test('summarize aggregates multi-run results (zero-fix over all runs; clean = every run clean)', () => {
  const results = [
    { id: 'a', metrics: { produced: true, inlineStyles: 0 }, violations: [], runs: 4, cleanRuns: 3 },
    { id: 'b', metrics: { produced: true, inlineStyles: 1 }, violations: [{ type: 'raw-color', value: '#f00' }], runs: 4, cleanRuns: 0 },
  ];
  const s = summarize(results);
  assert.equal(s.cases, 2);
  assert.equal(s.produced, 2);
  assert.equal(s.clean, 0);            // neither is clean across ALL runs (a: 3/4, b: 0/4)
  assert.equal(s.zeroFixRate, 38);     // 3 of 8 runs clean → 37.5 → 38
  assert.equal(s.runsPerCase, 4);
  assert.equal(s.inlineStyles, 1);
});

test('generateCandidate runs the command (prompt on stdin, id in env) and returns its stdout', () => {
  const run = (cmd, input, env) => `<!-- ${env.EVAL_ID} -->\n<button class="buttonPrimary">${input.trim().slice(0, 8)}</button>`;
  const code = generateCandidate({ id: 'login', prompt: 'a primary button', component: 'buttonPrimary' }, 'my-agent', '/x/llms.txt', run);
  assert.match(code, /<button class="buttonPrimary">/);
  assert.match(code, /login/);
  assert.equal(generateCandidate({ id: 'x', prompt: 'p' }, '', '', run), null);           // no cmd → null
  assert.equal(generateCandidate({ id: 'x', prompt: 'p' }, 'cmd', '', () => { throw new Error('nope'); }), null); // degrade
});

test('judgeCandidate parses a JSON verdict and degrades on non-JSON / no code', () => {
  const ok = judgeCandidate({ id: 'a', prompt: 'p' }, '<button/>', 'judge', () => 'noise {"ok":true,"notes":"right component"} trailing');
  assert.deepEqual(ok, { ok: true, notes: 'right component' });
  assert.equal(judgeCandidate({ id: 'a', prompt: 'p' }, '<x/>', 'judge', () => 'not json'), null);
  assert.equal(judgeCandidate({ id: 'a', prompt: 'p' }, '', 'judge', () => '{"ok":true}'), null);   // no code → null
});

test('judgeCandidate passes the component guidance (the "why") into the payload', () => {
  let seen = null;
  const run = (cmd, input) => { seen = JSON.parse(input); return '{"ok":true}'; };
  judgeCandidate(
    { id: 'a', prompt: 'a login button', component: 'Button', guidance: { whenNotToUse: 'not for navigation', useInstead: ['Link'] } },
    '<button/>', 'judge', run);
  assert.equal(seen.component, 'Button');
  assert.equal(seen.guidance.whenNotToUse, 'not for navigation');
  assert.deepEqual(seen.guidance.useInstead, ['Link']);
});
