// contract-gen.mjs (Phase A) — the standard contract emitter.
// Pins: (1) it emits a W3C DTCG token dictionary + a schema-valid Equinor-shaped
// contract whose anatomy references tokens by {family.token} and never copies token
// VALUES in; (2) regeneration is merge-aware — authored fields (version, semantics,
// props[].bindings.code) survive, captured fields refresh from the snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { generateContracts } from '../contract-gen.mjs';

const cfg = {
  paths: {
    themeCSS: 'theme.css', snapshotVars: 'vars.json', snapshotStructure: 'struct.json',
    compPropsSnapshot: 'props.json', structureContract: 'structure-contract.mjs',
  },
  figma: { modes: [{ name: 'Light', snapshotKey: 'light' }, { name: 'Dark', snapshotKey: 'dark' }] },
  contracts: { pilot: ['buttonPrimary'] },
};

const fixture = () => makeFixture({
  'theme.css': ':root{}\n',
  'vars.json': {
    color: {
      light: { 'buttonPrimary/background/color': '#0a84ff', 'buttonPrimary/iconText/color': '#ffffff' },
      dark:  { 'buttonPrimary/background/color': '#0060df', 'buttonPrimary/iconText/color': '#ffffff' },
    },
    sizing: { 'radii/button': '24px', 'padding/xs': '4px' },
    typography: { m: { size: '11px', weight: '600', lh: '16px' } },
  },
  'struct.json': { components: { buttonPrimary: { nodeId: '1428:21123', h: 24, paddingVar: { tb: null, lr: 'padding/xs' }, gapVar: null, fontSizeVar: 'm', innerRadiusVar: 'radii/button' } } },
  'props.json': { buttonPrimary: { nodeId: '1428:21123', properties: {
    'label-content#1428:0': { type: 'TEXT', defaultValue: 'label' },
    'disabled': { type: 'VARIANT', defaultValue: 'false', variantOptions: ['false', 'true'] },
  }, annotations: [] } },
  'structure-contract.mjs': "export const CONTRACT = { buttonPrimary: { h:24, paddingVar:{tb:null,lr:'padding/xs'}, gapVar:null, gapPx:0, fontSizeVar:'m', innerRadiusVar:'radii/button', strokeSides:'none', children:[{name:'LabelContainer', cssSelector:'.buttonPrimary span', gapVar:null, paddingVar:{tb:null,lr:'padding/xs'}}], propertyMap:{ disabled:{ false:'.buttonPrimary', true:'.buttonPrimary:disabled' } } } };\n",
});

test('emits a DTCG dictionary + a schema-valid contract that references tokens by {family.token}, no values copied in', async () => {
  const dir = fixture();
  const r = await generateContracts(dir, cfg, {});
  assert.deepEqual(r.invalid, [], 'contract must validate against the schema: ' + JSON.stringify(r.invalid));
  assert.equal(r.components.length, 1);

  const tokens = JSON.parse(readFileSync(r.tokensOut, 'utf8'));
  assert.equal(tokens.radii.button.$type, 'dimension');
  assert.equal(tokens.radii.button.$value, '24px');
  assert.equal(tokens.buttonPrimary.background.color.$type, 'color');
  assert.equal(tokens.buttonPrimary.background.color.$value, '#0a84ff');
  assert.equal(tokens.buttonPrimary.background.color.$extensions['com.rms.parity'].modes.dark, '#0060df');
  assert.equal(tokens.typography.m.$type, 'typography');
  assert.equal(tokens.typography.m.$value.fontSize, '11px');

  const c = JSON.parse(readFileSync(join(r.outDir, 'buttonPrimary.contract.json'), 'utf8'));
  assert.equal(c.id, 'rms.buttonPrimary');
  const disabled = c.props.find((p) => p.name === 'disabled');
  assert.equal(disabled.bindings.figma.kind, 'VARIANT');
  assert.equal(disabled.bindings.figma.property, 'disabled');
  assert.equal(disabled.bindings.code, null, 'bindings.code is authored, starts unset');
  assert.deepEqual(disabled.options, ['false', 'true']);
  // anatomy references tokens by {family.token}; the resolved values live ONLY in the token file.
  assert.equal(c.anatomy.root.radiusToken, '{radii.button}');
  assert.equal(c.anatomy.root.inset.inlineToken, '{padding.xs}');
  assert.equal(c.anatomy.LabelContainer.selector, '.buttonPrimary span');
  const blob = JSON.stringify(c);
  assert.ok(!blob.includes('24px'), 'contract must not duplicate token dimension VALUES');
  assert.ok(!blob.includes('#0a84ff'), 'contract must not duplicate token color VALUES');
  // disabled maps to a state selector
  assert.ok(c.states.some((s) => s.name === 'disabled=true' && s.selector === '.buttonPrimary:disabled'));

  // generated DS data is kept LOCAL by default: a .gitignore is dropped in each output dir
  assert.ok(readFileSync(join(r.outDir, '.gitignore'), 'utf8').includes('*'), 'contracts dir must be gitignored');
  assert.ok(readFileSync(join(dirname(r.tokensOut), '.gitignore'), 'utf8').includes('*'), 'tokens dir must be gitignored');
});

test('by default emits a contract for EVERY component the scan found (no fixed pilot, project-agnostic)', async () => {
  const dir = makeFixture({
    'theme.css': ':root{}\n',
    'vars.json': { color: { light: { 'a/color': '#111' }, dark: { 'a/color': '#222' } }, sizing: { 'radii/x': '2px' }, typography: {} },
    'struct.json': { components: {
      widgetOne: { nodeId: '1:1', h: 10, paddingVar: { tb: null, lr: null }, innerRadiusVar: 'radii/x' },
      widgetTwo: { nodeId: '2:2', h: 20, paddingVar: { tb: null, lr: null } },
    } },
    'props.json': { _updated: 'x', widgetOne: { nodeId: '1:1', properties: {}, annotations: [] }, widgetTwo: { nodeId: '2:2', properties: {}, annotations: [] } },
    'structure-contract.mjs': 'export const CONTRACT = { widgetThree: { h:5, paddingVar:{tb:null,lr:null} } };\n',
  });
  // cfg with NO contracts.only / .pilot → default is "everything scanned"
  const r = await generateContracts(dir, { paths: cfg.paths, figma: cfg.figma }, {});
  assert.deepEqual([...r.components].sort(), ['widgetOne', 'widgetThree', 'widgetTwo']);
  for (const n of ['widgetOne', 'widgetTwo', 'widgetThree']) {
    assert.ok(readFileSync(join(r.outDir, `${n}.contract.json`), 'utf8').includes(`rms.${n}`), `${n} contract must be emitted`);
  }
});

test('authored decisions live in the committed contract.authored.json; regen reflects them and refreshes captured', async () => {
  const dir = fixture();
  const r1 = await generateContracts(dir, cfg, {});
  // the committed authored file is scaffolded on first run
  assert.ok(existsSync(r1.authoredPath), 'authored file scaffolded');

  // author a binding + semantics + version in the COMMITTED authored file (not the local view)
  const authored = JSON.parse(readFileSync(r1.authoredPath, 'utf8'));
  authored.components.buttonPrimary = {
    version: '1.2.0',
    semantics: { element: 'button', aria: { 'aria-disabled': 'reflects the disabled state' } },
    bindings: { disabled: { attribute: 'isDisabled' } },
  };
  writeFileSync(r1.authoredPath, JSON.stringify(authored, null, 2));

  // change a captured input (token value) and regenerate
  const vars = JSON.parse(readFileSync(join(dir, 'vars.json'), 'utf8'));
  vars.sizing['radii/button'] = '999px';
  writeFileSync(join(dir, 'vars.json'), JSON.stringify(vars));
  const r2 = await generateContracts(dir, cfg, {});

  const c2 = JSON.parse(readFileSync(join(r2.outDir, 'buttonPrimary.contract.json'), 'utf8'));
  // authored reflected FROM the committed file
  assert.equal(c2.version, '1.2.0');
  assert.equal(c2.semantics.element, 'button');
  assert.deepEqual(c2.props.find((p) => p.name === 'disabled').bindings.code, { attribute: 'isDisabled' });
  // captured refreshed: the token dictionary picked up the new value; the contract still refs by name
  const tokens = JSON.parse(readFileSync(r2.tokensOut, 'utf8'));
  assert.equal(tokens.radii.button.$value, '999px');
  assert.equal(c2.anatomy.root.radiusToken, '{radii.button}');
});
