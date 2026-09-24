// decision-status.mjs (I33) — per-component decision status + the *why*, so an agent never finds
// two right answers with no note saying which one won.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { parseStatusTags, resolveStatus, statusFindings, statusLine, lintStatusFields } from '../decision-status.mjs';
import { generateContracts } from '../contract-gen.mjs';

test('[I33] parses the tag convention from a Figma description, and nothing when there are no tags', () => {
  assert.deepEqual(parseStatusTags('A plain description.'), {});
  assert.deepEqual(parseStatusTags('Old toggle. @deprecated merged into switch @use-instead switch @since 2.0'),
    { state: 'deprecated', rationale: 'merged into switch', supersededBy: 'switch', since: '2.0' });
  assert.deepEqual(parseStatusTags('@experimental'), { state: 'experimental' });
  assert.deepEqual(parseStatusTags('@status: current'), { state: 'current' });
  // a replacement alone implies deprecated
  assert.equal(parseStatusTags('@replaced-by chip').state, 'deprecated');
});

test('[I33] authored fields win over the captured description; nothing said means null', () => {
  assert.equal(resolveStatus({}, 'no tags'), null);
  const s = resolveStatus({ supersededBy: 'switch', rationale: 'one control, not two' }, '@deprecated old reason @since 1.4');
  assert.deepEqual(s, { state: 'deprecated', supersededBy: 'switch', since: '1.4', rationale: 'one control, not two', source: 'authored+figma' });
  assert.equal(resolveStatus({ status: 'experimental' }, '').source, 'authored');
  assert.equal(resolveStatus({ status: 'bogus' }, '@experimental').state, 'experimental');
  assert.equal(statusLine(s), 'deprecated · use switch instead · since 1.4 · why: one control, not two');
});

test('[I33] lints the authored status fields', () => {
  assert.deepEqual(lintStatusFields('x', { status: 'deprecated', supersededBy: 'y' }), []);
  assert.ok(lintStatusFields('x', { status: 'old' })[0].includes('x.status must be one of'));
  assert.ok(lintStatusFields('x', { rationale: 3 })[0].includes('x.rationale must be a string'));
});

test('[I33] cross-checks decisions: unknown / chained targets, no what-or-why, guidance to a deprecated component', () => {
  const built = [
    { name: 'toggle',  contract: { status: { state: 'deprecated', supersededBy: 'switchV1' } } },
    { name: 'switchV1', contract: { status: { state: 'deprecated', supersededBy: 'switch' } } },
    { name: 'switch',  contract: {} },
    { name: 'oldChip', contract: { status: { state: 'deprecated' } } },
    { name: 'ghost',   contract: { status: { state: 'deprecated', supersededBy: 'nope' } } },
    { name: 'card',    contract: { useInstead: ['toggle'], relationships: { composesWith: ['oldChip', 'switch'] } } },
  ];
  const kinds = statusFindings(built).map((f) => `${f.kind}:${f.component}`).sort();
  assert.deepEqual(kinds, [
    'chain:toggle', 'composes-deprecated:card', 'guidance-to-deprecated:card', 'not-legible:oldChip', 'unknown-target:ghost',
  ]);
  const chain = statusFindings(built).find((f) => f.kind === 'chain');
  assert.match(chain.msg, /point it at switch/);
});

test('[I33] contract-gen emits status, tags llms.txt, reports a newly deprecated component, and explains deprecated tokens', async () => {
  const dir = makeFixture({
    'theme.css': ':root{}\n',
    'vars.json': {
      color: { light: {}, dark: {} },
      sizing: { 'radii/button': '24px', 'radii/legacy': '8px' },
      typography: {},
      tokenMeta: { 'radii/legacy': { description: '@deprecated too sharp @use-instead radii/button', deprecated: true } },
    },
    'struct.json': { components: { toggle: { nodeId: '1:1', h: 24 }, switch: { nodeId: '1:2', h: 24 } } },
    'props.json': {
      toggle: { nodeId: '1:1', description: 'Legacy toggle. @deprecated @use-instead switch', properties: {}, annotations: [] },
      switch: { nodeId: '1:2', description: 'On/off control.', properties: {}, annotations: [] },
    },
  });
  const cfg = { paths: { themeCSS: 'theme.css', snapshotVars: 'vars.json', snapshotStructure: 'struct.json', compPropsSnapshot: 'props.json' },
    figma: { modes: [{ name: 'Light', snapshotKey: 'light' }, { name: 'Dark', snapshotKey: 'dark' }] } };
  writeFileSync(join(dir, 'contract.authored.json'), JSON.stringify({ components: { toggle: { rationale: 'two on/off controls confused people' } } }));

  const r = await generateContracts(dir, cfg, {});
  assert.deepEqual(r.invalid, []);
  const toggle = JSON.parse(readFileSync(join(r.outDir, 'toggle.contract.json'), 'utf8'));
  assert.deepEqual(toggle.status, { state: 'deprecated', supersededBy: 'switch', rationale: 'two on/off controls confused people', source: 'authored+figma' });
  const sw = JSON.parse(readFileSync(join(r.outDir, 'switch.contract.json'), 'utf8'));
  assert.equal(sw.status, undefined, 'a component with no decision gets no status field');
  assert.deepEqual(r.statusCounts, { deprecated: 1 });
  assert.deepEqual(r.statusIssues, []);
  assert.ok(r.prune.deprecatedComponents.includes('toggle'));

  const llms = readFileSync(r.llmsOut, 'utf8');
  assert.match(llms, /- \[deprecated\] \[toggle\]/);
  assert.match(llms, /status: deprecated · use switch instead · why: two on\/off controls confused people/);

  const tokens = JSON.parse(readFileSync(r.tokensOut, 'utf8'));
  assert.equal(tokens.radii.legacy.$deprecated, 'Use radii/button instead. too sharp');   // DTCG string form
  assert.ok(r.prune.deprecatedTokens.includes('radii.legacy'));

  // Deprecating a component between runs is reported as a deprecation change.
  writeFileSync(join(dir, 'contract.authored.json'), JSON.stringify({ components: { switch: { status: 'deprecated', supersededBy: 'toggle' } } }));
  const r2 = await generateContracts(dir, cfg, {});
  assert.ok(r2.breaking.some((c) => c.level === 'deprecation' && /component "switch" deprecated \(use toggle\)/.test(c.msg)));
  assert.ok(r2.statusIssues.some((f) => f.kind === 'chain'), 'two components pointing at each other, both deprecated');
});
