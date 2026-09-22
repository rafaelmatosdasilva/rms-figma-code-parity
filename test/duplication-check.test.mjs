// duplication-check.mjs - single-source-of-truth / list-duplication advisory (I21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNameMentions, duplicationFindings } from '../duplication-check.mjs';

test('findNameMentions matches whole tokens, not substrings, and handles token paths', () => {
  const text = 'Use buttonPrimary and radii/button. Avoid myButtonPrimary and radii/buttonLarge.';
  const found = findNameMentions(text, ['buttonPrimary', 'radii/button', 'buttonSecondary']);
  assert.deepEqual(found.sort(), ['buttonPrimary', 'radii/button']);   // exact only
  assert.deepEqual(findNameMentions('', ['x']), []);
});

test('duplicationFindings flags a surface that restates a cluster, ignores a passing mention', () => {
  const components = ['Button', 'Chip', 'Panel', 'Toast', 'Tooltip', 'Badge'];
  const doc = 'Our components: Button, Chip, Panel, Toast, Tooltip. See design.';
  const note = 'The Button is nice.';   // one mention - not a list
  const r = duplicationFindings({
    surfaces: [{ name: 'AGENTS.md', text: doc }, { name: 'note.md', text: note }],
    componentNames: components, minCluster: 5,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].surface, 'AGENTS.md');
  assert.equal(r.findings[0].kind, 'components');
  assert.equal(r.findings[0].count, 5);
  assert.equal(r.findings[0].total, 6);
});

test('duplicationFindings detects parallel truths across >=2 surfaces', () => {
  const tokens = ['radii/button', 'gap/s', 'gap/m', 'padding/s', 'padding/xs', 'padding/l'];
  const list = 'radii/button gap/s gap/m padding/s padding/xs';
  const r = duplicationFindings({
    surfaces: [{ name: 'a.md', text: list }, { name: 'b.md', text: list }],
    tokenNames: tokens, minCluster: 5,
  });
  assert.equal(r.findings.length, 2);
  assert.equal(r.parallel.length, 1);
  assert.equal(r.parallel[0].kind, 'tokens');
  assert.deepEqual(r.parallel[0].surfaces.sort(), ['a.md', 'b.md']);
});

test('duplicationFindings is a no-op with no surfaces or below the cluster threshold', () => {
  assert.deepEqual(duplicationFindings({}).findings, []);
  const r = duplicationFindings({
    surfaces: [{ name: 'x.md', text: 'Button Chip' }],
    componentNames: ['Button', 'Chip', 'Panel'], minCluster: 5,
  });
  assert.deepEqual(r.findings, []);   // only 2 < 5
});
