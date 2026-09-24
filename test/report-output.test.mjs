// Stage 5: the report says what changed since the last run, links each component to Figma, and
// leaves out lines that report nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFindings, diffFindings, diffReport, ZERO_FAIL } from '../run-diff.mjs';
import { figmaLink, figmaLinker } from '../figma-link.mjs';
import { stateContrastFindings } from '../contrast-check.mjs';
import { makeFixture } from './helpers.mjs';

const report = (extra = []) => [
  '  PARITY AUDIT  ·  2026-01-01',
  '✅  [13] Structure  (height · spacing)',
  '       ✅ PASS  7/7 CSS height rules',
  '       ❌ FAIL  0',
  '       ⚠️  toast height: Figma 32, rendered 48  (.toast · theme.css:890)',
  '❌  [16] Sub-components match Figma  (nesting)',
  '       (exit 2 - treated as "not run", never a pass)',
  '       bound-tokens.json ✓ (updated today)',
  '  GATE SUMMARY',
  '  ❌  [16]   Sub-components match Figma     Fail',
  '  AUDIT FAILED - fix all ❌ above before declaring parity',
  '⚠️  State contrast: 3 component state(s) below WCAG AA (30 checked).',
  '     chip [default · light]: 3.11:1 (needs 4.5:1)',
  '   Advisory: pairs are derived …',
  '─── Accessibility check (advisory — never blocks the build) ───',
  'Found 107 things (checked in 2 themes):',
  '• 4 pieces of text are hard to read',
  '     Why it matters: The text colour is too close.',
  ...extra,
];

test('findings: failing gates, warning lines and listed advisory items; never zero counts or summaries', () => {
  const f = collectFindings(report());
  assert.deepEqual(f, [
    'Structure :: ⚠️  toast height: Figma 32, rendered 48  (.toast · theme.css:890)',
    'Sub-components match Figma :: gate fails',
    'Sub-components match Figma :: (exit 2 - treated as "not run", never a pass)',
    'State contrast :: chip [default · light]: 3.11:1 (needs 4.5:1)',
    'Accessibility :: • 4 pieces of text are hard to read',
  ]);
  assert.equal(ZERO_FAIL.test('❌ MISSING  0  propertyMap selectors'), true);
  assert.equal(ZERO_FAIL.test('❌ FAIL  3 field(s)'), false);
});

test('since the last run: new, gone, and a count that moved is one changed finding', () => {
  const prev = collectFindings(report());
  const cur = collectFindings(report().map((l) => l.replace('4 pieces', '6 pieces').replace(/^.*toast height.*$/, '       ⚠️  chip gap: Figma 8, rendered 4')));
  const d = diffFindings(prev, cur);
  assert.deepEqual(d.added, ['Structure :: ⚠️  chip gap: Figma 8, rendered 4']);
  assert.deepEqual(d.gone, ['Structure :: ⚠️  toast height: Figma 32, rendered 48  (.toast · theme.css:890)']);
  assert.equal(d.changed.length, 1);
  assert.match(diffReport(d).join('\n'), /changed  Accessibility: • 4 pieces .*→  • 6 pieces/);
  assert.deepEqual(diffFindings(prev, prev), { added: [], gone: [], changed: [] });
});

test('Figma links: from the snapshots node ids and the file key, nothing without them', () => {
  assert.equal(figmaLink('KEY', '12:345'), 'https://www.figma.com/design/KEY?node-id=12-345');
  assert.equal(figmaLink(null, '1:2'), null);
  const dir = makeFixture({ 's.json': { components: { chip: { nodeId: '1:2' } } }, 'p.json': { chip: { nodeId: '9:9' }, tag: { nodeId: '3:4' } } });
  const link = figmaLinker(dir, { figmaFileKey: 'K', paths: { snapshotStructure: 's.json', compPropsSnapshot: 'p.json' } });
  assert.equal(link('chip'), 'https://www.figma.com/design/K?node-id=1-2');
  assert.equal(link('tag'), 'https://www.figma.com/design/K?node-id=3-4');
  assert.equal(link('none'), null);
});

test('state contrast: each state in every mode, with the token names and the source line', () => {
  const code = { components: { chip: { instance: { hasText: true },
    props: { color: { value: 'rgb(0, 0, 0)', var: '--chip-text', at: 'theme.css:4' }, backgroundColor: { value: 'rgb(255, 255, 255)', var: '--chip-bg', at: 'theme.css:5' } },
    colors: { light: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)' }, dark: { color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(0, 0, 0)' } },
    states: { 'State=Hover': { produced: 'forced :hover', changed: { color: { value: 'rgb(230, 230, 230)', var: '--chip-text-hover', at: 'theme.css:9' } },
      colors: { light: { color: 'rgb(230, 230, 230)', backgroundColor: 'rgb(255, 255, 255)' }, dark: { color: 'rgb(40, 40, 40)', backgroundColor: 'rgb(0, 0, 0)' } } } } } } };
  const r = stateContrastFindings(code);
  assert.deepEqual(r.findings.map((f) => [f.state, f.mode, f.fgVar, f.bgVar, f.at]), [['State=Hover', 'light', '--chip-text-hover', '--chip-bg', 'theme.css:9'], ['State=Hover', 'dark', '--chip-text-hover', '--chip-bg', 'theme.css:9']]);
});

test('right-to-left: one-sided and asymmetric physical properties, with the logical one to use', async () => {
  const { rtlFindings } = await import('../rtl-check.mjs');
  const r = rtlFindings([{ file: 'a.css', text: '.ok { padding-left: 8px; padding-right: 8px; margin: 0 auto; }\n.pad { padding-left: 8px; }\n.four { padding: 1px 2px 3px 4px; text-align: left; }\n.pos { left: 4px; float: right; }' }]);
  assert.deepEqual(r.map((f) => `${f.selector} ${f.use}`), ['.pad padding-inline-start', '.four padding-block and padding-inline (or -inline-start / -inline-end)', '.four text-align: start', '.pos inset-inline-start', '.pos float: inline-end']);
  assert.equal(r[0].at, 'a.css:2');
});
