// names.mjs: every name the engine keeps in a project, in one place, and only those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT, projectPath, newPath, codeSnapshotPath, envVar, ENGINE_DIRS, SKILL } from '../names.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'names-'));

test('every project name is under design-system-engine, read and written the same', () => {
  const dir = tmp();
  for (const [key, n] of Object.entries(PROJECT)) {
    assert.match(n.now, /design-system-engine/);
    assert.equal(projectPath(dir, key), n.now);
    assert.equal(newPath(key), n.now);
  }
  assert.throws(() => projectPath(dir, 'nope'));
  assert.deepEqual(ENGINE_DIRS.sort(), ['.design-system-engine-out', '.design-system-engine-refs']);
  assert.equal(SKILL, 'rms-design-system-engine');
});

test('the code capture goes in the output folder unless the config names another path', () => {
  assert.equal(codeSnapshotPath({}), '.design-system-engine-out/code.snapshot.json');
  assert.equal(codeSnapshotPath({ codeReading: { out: 'build/capture.json' } }), 'build/capture.json');
});

test('environment variables are DESIGN_SYSTEM_ENGINE_ ones', () => {
  assert.equal(envVar({ DESIGN_SYSTEM_ENGINE_NO_AUTO_UPDATE: '1' }, 'NO_AUTO_UPDATE'), '1');
  assert.equal(envVar({}, 'NO_AUTO_UPDATE'), undefined);
});

// The names the skill had before it was rms-design-system-engine. This test is the one place that spells them,
// to keep them out of everything else; git history keeps what was written under them.
const OLD = /rms-figma-code-parity|rms-parity\b|\.parity-out|\.parity-refs|parity-map|parity-baseline|parity-agreed|parity-history|parity-check-result|com\.rms\.parity|\bPARITY_[A-Z]/;
test('the old names appear nowhere', () => {
  const ROOT = join(import.meta.dirname, '..');
  const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .filter((f) => f !== 'test/names.test.mjs' && !f.startsWith('test/skill-evals/results/') && !f.startsWith('test/skill-evals/records/') && !/\.(png|jpe?g|gif|webp|ico)$/.test(f) && existsSync(join(ROOT, f)));
  const stray = files.filter((f) => OLD.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(stray, []);
});

test('project hooks that point at an engine that moved point at this one on the next run', async () => {
  const { installHooks, upgradeHooks, hooksStatus } = await import('../hooks-install.mjs');
  const dir = tmp();
  const gone = join(tmp(), 'moved-engine');
  installHooks(dir, { engineDir: gone });
  assert.equal(hooksStatus(dir).exists, false);
  assert.equal(upgradeHooks(dir, {}, { env: {} }), true);
  const h = hooksStatus(dir);
  assert.equal(h.exists, true);
  assert.equal(h.command.includes(gone), false);
  assert.equal(upgradeHooks(dir, {}, { env: {} }), false);
});
