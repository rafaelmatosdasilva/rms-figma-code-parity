// Step 8: gates that read the code snapshot. A fresh snapshot (same inputs as now) is used; a stale
// one is ignored. Snapshots here are made by the real capture with the browser off, then edited
// to hold the fact under test, keeping their input hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture, EMPTY_PARITY_MAP } from './helpers.mjs';
import { captureCode, readFreshSnapshot } from '../code-capture.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (dir, gate) => {
  try { return { code: 0, out: execFileSync('node', [join(ENGINE, gate)], { cwd: dir, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
};
async function withSnapshot(files, edit) {
  const dir = makeFixture(files);
  const cfg = JSON.parse(files['ds-config.json']);
  const { outPath } = await captureCode(dir, cfg, { force: true, browser: false });
  const snap = JSON.parse(readFileSync(outPath, 'utf8'));
  edit?.(snap);
  writeFileSync(outPath, JSON.stringify(snap));
  return { dir, cfg, outPath };
}

test('freshness: a snapshot is used while the code is unchanged, and ignored once it changes', async () => {
  const { dir, cfg } = await withSnapshot({ 'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css' } }), 'theme.css': ':root { --a: #111111; }' });
  assert.ok(await readFreshSnapshot(dir, cfg));
  appendFileSync(join(dir, 'theme.css'), '\n:root { --b: 1px; }');
  assert.equal(await readFreshSnapshot(dir, cfg), null);
});

test('token gate: a mismatch on a token the capture could not read reliably is not verified, never a design failure', async () => {
  const files = {
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' }, figma: { colorCollection: 'Color' } }),
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand: #123456; }\n@media (prefers-color-scheme: dark) { :root { --brand: #000000; } }',
    'figma-vars.snapshot.json': JSON.stringify({ color: { light: { 'brand/color': '#ffffff' }, dark: { 'brand/color': '#000000' } } }),
  };
  const plain = run(makeFixture(files), 'parity-check.mjs');
  assert.match(plain.out, /❌ \[color\/Light\] brand/);   // no snapshot: an ordinary failure
  const { dir } = await withSnapshot(files, (s) => {
    s.tokens['--brand'].modes.light = { value: '#ffffff', confidence: 'uncertain', readings: { browser: '#ffffff', static: '#123456' } };
  });
  const r = run(dir, 'parity-check.mjs');
  assert.doesNotMatch(r.out, /❌ \[color\/Light\] brand/, r.out);
  assert.match(r.out, /could not read reliably - light: browser #ffffff · CSS #123456/, r.out);
  assert.equal(r.code, 1, 'not verified is never a pass');
});

test('nesting gate: a sub-component the rendered page shows inside the parent counts as used', async () => {
  const files = {
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css' }, componentSelectors: { Card: '.card', Badge: '.badge' } }),
    'theme.css': ':root { --a: 1px; }',
    'component-composition.snapshot.json': JSON.stringify({ Card: ['Badge'] }),
    'src/Card.jsx': "export function Card() { return <div className='card' ref={fill} />; }\n",
  };
  const before = run(makeFixture(files), 'component-composition-check.mjs');
  assert.equal(before.code, 1, before.out);   // the source alone never mentions Badge
  const { dir } = await withSnapshot(files, (s) => { s.nesting = { Card: { instancesSeen: 1, contains: { Badge: { renderedIn: ['app'], instances: 1, confidence: 'single-source', readBy: 'rendered' } } } }; });
  const after = run(dir, 'component-composition-check.mjs');
  assert.equal(after.code, 0, after.out);
});

test('coverage gate: reports what the code capture read, or that it is missing or out of date', async () => {
  const files = {
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css', snapshotStructure: 'figma-structure.snapshot.json' } }),
    'theme.css': ':root { --a: 1px; --b: #fff; }',
    'figma-structure.snapshot.json': JSON.stringify({ components: {} }),
  };
  assert.match(run(makeFixture(files), 'coverage-check.mjs').out, /CODE CAPTURE not run/);
  const { dir } = await withSnapshot(files);
  assert.match(run(dir, 'coverage-check.mjs').out, /CODE CAPTURE tokens 2 \(0 verified · 0 uncertain\).*read by static CSS only/);
  appendFileSync(join(dir, 'theme.css'), '\n:root { --c: 2px; }');
  assert.match(run(dir, 'coverage-check.mjs').out, /CODE CAPTURE out of date/);
});

test('structure gate: a rendered value that differs from Figma is listed as measured, and never changes the result', async () => {
  const files = {
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css', snapshotStructure: 'figma-structure.snapshot.json', pluginCSS: ['app.css'] } }),
    'theme.css': ':root { --h: 32px; }\n.chip { height: var(--h); }',
    'app.css': '.chip.big { height: 48px; }',
    'figma-structure.snapshot.json': JSON.stringify({ components: { chip: { h: 32 } } }),
    'structure-contract.mjs': "export const CONTRACT = { chip: { h: 32 } }; export const COMPONENT_CSS_SELECTORS = { chip: { main: '.chip' } };",
  };
  const plain = run(makeFixture(files), 'structure-check.mjs');
  const { dir } = await withSnapshot(files, (s) => {
    s._sources.browser = 'chrome';
    s.components = { chip: { selector: '.chip', size: { height: 48 }, props: { height: { value: '48px', rule: '.chip.big', at: 'app.css:1', confidence: 'verified' } } } };
  });
  const r = run(dir, 'structure-check.mjs');
  assert.match(r.out, /⚠️  MEASURED 1/, r.out);
  assert.match(r.out, /chip height: Figma 32, rendered 48\s+\(\.chip\.big · app\.css:1\)/);
  assert.equal(r.code, plain.code, 'advisory only');
});

test('structure gate: renderedParityStrict makes a measured difference fail the gate', async () => {
  const files = {
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css', snapshotStructure: 'figma-structure.snapshot.json', pluginCSS: ['app.css'] }, renderedParityStrict: true }),
    'theme.css': ':root { --h: 32px; }\n.chip { height: var(--h); }',
    'app.css': '.chip.big { height: 48px; }',
    'figma-structure.snapshot.json': JSON.stringify({ components: { chip: { h: 32 } } }),
    'structure-contract.mjs': "export const CONTRACT = { chip: { h: 32 } }; export const COMPONENT_CSS_SELECTORS = { chip: { main: '.chip' } };",
  };
  const { dir } = await withSnapshot(files, (s) => {
    s._sources.browser = 'chrome';
    s.components = { chip: { selector: '.chip', size: { height: 48 }, props: { height: { value: '48px', rule: '.chip.big', at: 'app.css:1', confidence: 'verified' } } } };
  });
  const r = run(dir, 'structure-check.mjs');
  assert.match(r.out, /❌ MEASURED 1/, r.out);
  assert.equal(r.code, 1);
});
