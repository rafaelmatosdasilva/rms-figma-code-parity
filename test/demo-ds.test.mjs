// I44: Tidepool, a fictional design system in test/fixtures/demo-ds, audited end to end and compared with
// a committed report, so a change in one gate that shows up in another is caught. Every name is invented.
//
// Deliberate differences, one per recent check:
//   • a token value (radii/chip is 16px in Figma, 12px in code)
//   • disabled wins (the button's :hover has no :not(:disabled) guard)
//   • a variant combination (chip Size=L with Icon=True is 36px high in code, 32px in Figma)
//   • a role contract (the chip is a toggle button in Figma, with no aria-pressed in code)
//   • a visual difference (the Figma image of the button has a border no structure fact records)
// Themes switch with a data attribute (data-theme="dark"), unlike a media query, and the components
// have React sources for the props check.
//
// Two goldens: expected-report.txt with Chrome (the capture, the measured comparison and the accessibility
// check), expected-report-static.txt without it. UPDATE_GOLDEN=1 rewrites the one that ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../cdp.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ENGINE, 'test', 'fixtures', 'demo-ds');
const CHROME = findChrome({ playwright: true });

// A fresh copy, its snapshots dated today, committed once so git blame has a commit to name.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'demo-ds-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (p) => !/expected-report/.test(p) });
  const today = new Date().toISOString();
  for (const f of readdirSync(join(dir, 'src')).filter((x) => x.endsWith('.json'))) {
    const p = join(dir, 'src', f);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/"_updated": "[^"]*"/, `"_updated": "${today}"`));
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) execFileSync('git', args, { cwd: dir, env });
  return dir;
}

// A PATH with only git and which, so a run meant to be without Chrome cannot find one.
function bareEnv() {
  const bin = mkdtempSync(join(tmpdir(), 'demo-bin-'));
  for (const name of ['git', 'which']) {
    const p = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();
    if (p) symlinkSync(p, join(bin, name));
  }
  const { CHROME_PATH, ...rest } = process.env;
  return { ...rest, PATH: bin, PLAYWRIGHT_BROWSERS_PATH: join(bin, 'none') };
}

// Dates, durations, ages, commit hashes and the temporary directory change from run to run.
export function normalise(text, dir) {
  return text.split(dir).join('<DIR>')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>')
    .replace(/PARITY AUDIT {2}· {2}[\d-]+/, 'PARITY AUDIT  ·  <DATE>')
    .replace(/\b\d+(\.\d+)?m?s\b/g, '<DUR>')
    .replace(/\(([0-9a-f]{7})\)/g, '(<HASH>)')
    .replace(/\d+h (old|ago)/g, '<AGE>h $1')
    .replace(/\d+ ?(day|days|hour|hours) ago/g, '<AGE> ago')
    .replace(/^.*newer version of the parity skill.*\n/gm, '');
}

function audit(env) {
  const dir = project();
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs')], { cwd: dir, encoding: 'utf8', env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }, timeout: 300000 });
  return { dir, code: r.status, out: normalise((r.stdout ?? '') + (r.stderr ?? ''), dir) };
}

function golden(name, out) {
  const p = join(FIXTURE, name);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, out); return; }
  const want = readFileSync(p, 'utf8');
  if (out === want) return;
  const actual = join(mkdtempSync(join(tmpdir(), 'demo-ds-actual-')), name);
  writeFileSync(actual, out);
  assert.fail(`the report differs from ${name} (this run: ${actual}); if the change is intended, rerun with UPDATE_GOLDEN=1 and review the diff`);
}

test('demo design system, without Chrome: the static report matches its golden', { timeout: 300000 }, () => {
  const r = audit(bareEnv());
  assert.equal(r.code, 1, r.out.slice(-3000));
  assert.match(r.out, /❌ \[sizing\/-\] radii\/chip → --radii-chip/);
  golden('expected-report-static.txt', r.out);
});

test('demo design system, with Chrome: every deliberate difference is found, and the report matches its golden', { timeout: 300000, skip: CHROME ? false : 'Chrome not found' }, () => {
  const r = audit({ ...process.env, CHROME_PATH: CHROME });
  assert.equal(r.code, 1, r.out.slice(-3000));
  assert.match(r.out, /❌ \[sizing\/-\] radii\/chip → --radii-chip/);
  assert.match(r.out, /button hover while disabled \(Disabled=True\): Figma no change, rendered changes background/);
  assert.match(r.out, /chip height \(Size=L, Icon=True\): Figma 32, rendered 36px/);
  assert.match(r.out, /chip \(toggle button\)|component does not expose what its role requires/);
  assert.doesNotMatch(r.out, /chip height \(Icon=True\)/);   // a single axis is never compared with a combination
  assert.match(r.out, /🖼  ⚠️  button: [\d.]+% of pixels differ outside text/);   // a border only the Figma image has
  assert.match(r.out, /🖼  ✓  chip: 0% of pixels differ outside text/);
  golden('expected-report.txt', r.out);
});

test('in progress: an experimental component on one side is listed, never failed; on both sides it is compared', async () => {
  const { inProgressList, inProgressNames } = await import('../in-progress.mjs');
  const { makeFixture } = await import('./helpers.mjs');
  const files = (css) => ({
    'ds-config.json': { paths: { themeCSS: 'theme.css', compPropsSnapshot: 'props.json', snapshotStructure: 'struct.json' }, knownUnimplementedComponents: ['sheet'] },
    'theme.css': css,
    'props.json': { tag: { description: '@experimental', properties: {} }, badge: { properties: {} } },
    'struct.json': { components: { sheet: {} } },
    'contract.authored.json': { components: { drawer: { status: 'experimental' } } },
  });
  const cfgOf = (dir) => JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  let dir = makeFixture(files('.badge { color: red; }'));
  assert.deepEqual((await inProgressList(dir, cfgOf(dir))).map((x) => [x.name, x.why, x.figma, x.code]),
    [['drawer', 'experimental', false, false], ['sheet', 'not built yet', true, false], ['tag', 'experimental', true, false]]);
  assert.deepEqual([...(await inProgressNames(dir, cfgOf(dir)))].sort(), ['drawer', 'sheet', 'tag']);
  dir = makeFixture(files('.tag { color: red; } .sheet { color: blue; }'));
  const list = await inProgressList(dir, cfgOf(dir));
  assert.deepEqual(list.filter((x) => x.ready).map((x) => x.name), ['sheet', 'tag']);
  assert.deepEqual([...(await inProgressNames(dir, cfgOf(dir)))].sort(), ['drawer', 'sheet']);   // tag is compared now; sheet stays the owner's call
});

test('visual diff: a Figma image from a reference, else the REST API (a component set gives its default variant), cached', async () => {
  const { figmaImage } = await import('../visual-diff.mjs');
  const { makeFixture } = await import('./helpers.mjs');
  const dir = makeFixture({ '.parity-refs/components/chip.png': 'png' });
  const cfg = { figmaFileKey: 'KEY' };
  assert.equal((await figmaImage(dir, cfg, 'chip', {})).from, 'reference');
  assert.match((await figmaImage(dir, cfg, 'tag', { nodeId: '1:2', token: null })).why, /no FIGMA_TOKEN/);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const json = (x) => ({ ok: true, json: async () => x });
    if (url.includes('/nodes?')) return json({ nodes: { '1:2': { document: { type: 'COMPONENT_SET', children: [{ id: '1:3', name: 'Size=S' }, { id: '1:4', name: 'Size=M' }] } } } });
    if (url.includes('/images/')) return json({ images: { '1:4': 'https://img.example/x.png' } });
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('bytes').buffer };
  };
  const first = await figmaImage(dir, cfg, 'tag', { nodeId: '1:2', defaultVariant: 'Size=M', version: 'v1', token: 't', fetchImpl });
  assert.equal(first.from, 'figma');
  assert.match(calls[1], /ids=1%3A4/);   // the default variant, not the whole set
  assert.equal(readFileSync(first.file, 'utf8'), 'bytes');
  assert.equal((await figmaImage(dir, cfg, 'tag', { nodeId: '1:2', defaultVariant: 'Size=M', version: 'v1', token: 't', fetchImpl })).from, 'figma (cached)');
  assert.equal(calls.length, 3);
});

test('Figma prop types: one interface per component, states left out, names as the code uses them', async () => {
  const { propTypesDts, codePropName } = await import('../figma-props.mjs');
  const props = {
    _updated: 'x',
    chip: { nodeId: '1:1', properties: { 'Size': { type: 'VARIANT', defaultValue: 'M', variantOptions: ['M', 'L'] }, 'Icon': { type: 'VARIANT', defaultValue: 'False', variantOptions: ['False', 'True'] },
      'Show Label#2:0': { type: 'BOOLEAN', defaultValue: true }, 'Label#2:1': { type: 'TEXT', defaultValue: 'Filter' }, 'State': { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover'] },
      'Lead#2:2': { type: 'INSTANCE_SWAP', defaultValue: '9:9' } } },
    card: { properties: { 'Phase': { type: 'VARIANT', defaultValue: 'Rest', variantOptions: ['Rest', 'Hover'] } } },
  };
  const dts = propTypesDts(props, { cfg: { states: { hover: { prop: 'Phase', value: 'Hover' } } }, authored: { chip: { bindings: { Label: { attribute: 'text' }, Lead: { slot: 'leading' } } } } });
  assert.match(dts, /export interface ChipFigmaProps \{\n  \/\*\* Figma: Size \(variant\) \*\/\n  size\?: "M" \| "L";/);
  assert.match(dts, /icon\?: boolean;/);
  assert.match(dts, /showLabel\?: boolean;/);
  assert.match(dts, /text\?: string;/);                 // the authored binding renames it
  assert.match(dts, /leading\?: unknown;/);             // a slot
  assert.doesNotMatch(dts, /state\?|CardFigmaProps/);  // interaction states are CSS, not props (a declared axis too)
  assert.match(dts, /export interface ChipFigmaDefaults \{\n  size: "M";\n  icon: false;\n  showLabel: true;\n  text: "Filter";\n\}/);
  assert.equal(codePropName('x', 'Show Label#1:2', { aliases: { x: { 'Show Label': 'labelVisible' } } }), 'labelVisible');
});

const TSC = spawnSync('which', ['tsc'], { encoding: 'utf8' }).stdout.trim();
test('Figma prop types: tsc accepts matching props and rejects drifted ones', { skip: TSC ? false : 'no tsc' }, async () => {
  const { propTypesDts } = await import('../figma-props.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'figma-props-'));
  writeFileSync(join(dir, 'figma-props.d.ts'), propTypesDts(JSON.parse(readFileSync(join(FIXTURE, 'src', 'figma-component-props.snapshot.json'), 'utf8')), { cfg: JSON.parse(readFileSync(join(FIXTURE, 'ds-config.json'), 'utf8')) }));
  const file = (name, sizes) => { writeFileSync(join(dir, name), `import type { ChipFigmaProps } from './figma-props';\ntype ChipProps = { label?: string; size?: ${sizes}; icon?: boolean };\nconst p: ChipProps = {};\nexport const check: ChipFigmaProps = p;\n`); return name; };
  const tsc = (f) => spawnSync(TSC, ['--noEmit', '--strict', f, 'figma-props.d.ts'], { cwd: dir, encoding: 'utf8' });
  assert.equal(tsc(file('ok.ts', "'M' | 'L'")).status, 0);
  const drift = tsc(file('drift.ts', "'m' | 'l'"));
  assert.notEqual(drift.status, 0);
  assert.match(drift.stdout, /size/);
});
