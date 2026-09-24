// Stage 1 guarantees: a gate's outcome is always visible, a stuck browser gives up, and the audit
// survives an environment without `node` on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGateOutput, GATE_SUMMARY } from '../audit-parse.mjs';
import { launchChrome } from '../cdp.mjs';
import { makeFixture } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));

test('parser: a skip line is always shown, so a gate that checked nothing is never a silent green', () => {
  const r = parseGateOutput({ status: 0, stdout: '⏭  icon inventory: no figma-icons.snapshot.json - skipped (capture it to enable)\n', stderr: '' }, GATE_SUMMARY['icon-inventory-check.mjs']);
  assert.deepEqual(r, { pass: true, lines: ['⏭  icon inventory: no figma-icons.snapshot.json - skipped (capture it to enable)'] });
});

test('parser: a passing gate with no result line says so', () => {
  const r = parseGateOutput({ status: 0, stdout: 'all good\n', stderr: '' }, /MATCH/);
  assert.match(r.lines[0], /printed no result line/);
});

test('parser: each line once, fail details added, a failure without any line still shows why', () => {
  const r = parseGateOutput({ status: 1, stdout: '❌ FAIL  2\n❌ FAIL  2\n   ❌ x broke\n', stderr: '' }, /FAIL/);
  assert.deepEqual(r.lines, ['❌ FAIL  2', '  ❌ x broke']);
  const silent = parseGateOutput({ status: 1, stdout: '', stderr: 'TypeError: boom\n    at x' }, /FAIL/);
  assert.equal(silent.pass, false);
  assert.match(silent.lines.join('\n'), /TypeError: boom/);
  assert.deepEqual(parseGateOutput({ status: null, stdout: '', stderr: '' }, /x/), { pass: true, lines: ['⏭ script not found - skipped'] });
});

test('parser: the mode gate shows its OK and FAIL lines, not only the skip count', () => {
  const out = '✅ OK        140/140  (adapts)\n❌ FAIL      0/140  (missing)\n⏭  SKIPPED   18  (no CSS var)\n';
  assert.equal(parseGateOutput({ status: 0, stdout: out, stderr: '' }, GATE_SUMMARY['mode-completeness-check.mjs']).lines.length, 3);
});

test('browser: a Chrome that never becomes ready gives up with a clear reason', async () => {
  const dir = makeFixture({});
  const fake = join(dir, 'fake-chrome.sh');
  writeFileSync(fake, '#!/bin/sh\nsleep 30\n');
  chmodSync(fake, 0o755);
  const t0 = Date.now();
  await assert.rejects(launchChrome(fake, { timeoutMs: 400 }), /did not start within 0.4s/);
  assert.ok(Date.now() - t0 < 5000);
});

test('audit: runs its gates with its own Node, so a PATH without node does not crash it', () => {
  const dir = makeFixture({
    'ds-config.json': JSON.stringify({ paths: { themeCSS: 'theme.css' }, codeReading: { capture: 'off' } }),
    'theme.css': ':root { --a: 1px; }',
  });
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CI: '1' }, timeout: 240000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.doesNotMatch(out, /spawn node ENOENT|Unhandled 'error' event/, out.slice(-2000));
  assert.match(out, /PARITY AUDIT/, out.slice(-2000));
});
