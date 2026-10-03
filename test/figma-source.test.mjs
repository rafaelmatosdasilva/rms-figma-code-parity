// The way to read Figma, chosen automatically: design.json, figma-cli, the session's Figma MCP, the API (I84).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chooseFigmaSource, figmaCliPort, refreshFromFigmaCli } from '../figma-source.mjs';
import { fixtureProject } from './helpers.mjs';
import { tidepoolDesign } from './figma-cli-design.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const TP = join(ENGINE, 'test', 'fixtures', 'tidepool-figma');

test('the route, in order: a newer design.json, figma-cli connected, the API with a token, else the session\'s Figma tool', async () => {
  const at = (times) => (p) => times[Object.keys(times).find((k) => p.endsWith(k))] ?? null;
  const cfg = { paths: { snapshotVars: 'src/figma-vars.snapshot.json' }, figmaFileKey: 'abc' };
  const none = { which: () => null, answers: async () => false, env: {} };
  assert.equal((await chooseFigmaSource('/p', cfg, { ...none, mtime: at({ 'design.json': 2, 'figma-vars.snapshot.json': 1 }) })).route, 'design-json');
  assert.equal((await chooseFigmaSource('/p', cfg, { ...none, mtime: at({ 'design.json': 1, 'figma-vars.snapshot.json': 2 }) })).route, 'mcp', 'an older design.json is not read again');
  assert.equal((await chooseFigmaSource('/p', cfg, { ...none, mtime: at({}), which: () => '/bin/figma-cli', answers: async (port) => port === 9222 })).route, 'figma-cli');
  assert.equal((await chooseFigmaSource('/p', cfg, { ...none, mtime: at({}), which: () => '/bin/figma-cli' })).route, 'mcp', 'installed but Figma not connected');
  assert.equal((await chooseFigmaSource('/p', cfg, { ...none, mtime: at({}), env: { FIGMA_TOKEN: 't' } })).route, 'rest');
  assert.equal(figmaCliPort({ FIGMA_PORT: '9333' }), 9333);
  assert.equal(figmaCliPort({ FIGMA_PORT: 'x' }), 9222);
});

test('figma-cli is run to write design.json, then it is read; a failed snapshot says why', async () => {
  const dir = fixtureProject(TP, 'fc-run-');
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  const r = await refreshFromFigmaCli(dir, cfg, { run: () => { writeFileSync(join(dir, 'design.json'), JSON.stringify(tidepoolDesign())); return { status: 0 }; } });
  assert.equal(r.source, 'Tidepool');
  assert.equal(r.counts.components, 4);
  await assert.rejects(refreshFromFigmaCli(dir, cfg, { run: () => ({ status: 1, stderr: 'not connected to Figma\n' }) }), /figma-cli snapshot did not finish: not connected to Figma/);
});

test('--from-figma-cli reads a design.json; a newer one is read by the audit on its own, and the summary says so', { timeout: 300000 }, () => {
  const dir = fixtureProject(TP, 'fc-audit-');
  writeFileSync(join(dir, 'design.json'), JSON.stringify(tidepoolDesign()));
  const run = (...args) => spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', PATH: '/usr/bin:/bin' } });
  let r = run('--from-figma-cli');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✅ Figma read from design\.json \(Tidepool\): 18 colours in 2 modes, 8 sizes, 4 components/);
  // Older than the snapshots it wrote: the audit does not read it again.
  r = run('--refresh-figma');
  assert.match(r.stdout, /Figma source: mcp/);
  assert.match(r.stdout, /NEXT: rms-design-system-engine --recipe refresh-figma/);
  // The person runs figma-cli snapshot again: the audit reads it first and says so.
  const later = new Date(Date.now() + 60000);
  utimesSync(join(dir, 'design.json'), later, later);
  r = run();
  assert.match(r.stdout, /Figma read from design\.json \(Tidepool\)/);
  assert.match(readFileSync(join(dir, '.design-system-engine-out', 'summary.md'), 'utf8'), /read from design\.json \(Tidepool\), written by figma-cli, in this run/);
});
