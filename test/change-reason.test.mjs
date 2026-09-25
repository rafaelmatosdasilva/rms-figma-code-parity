// I49: the reason travels with a finding. The commit behind a code line, and the Figma file's latest
// named version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { codeReason, reasonLine, figmaReason, figmaReasonLine } from '../change-reason.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: '2026-09-20T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-20T10:00:00Z' } });

test('code side: the commit behind a line, an uncommitted line, and nothing outside git', () => {
  const dir = makeFixture({ 'theme.css': '.chip {\n  padding: 8px;\n}\n' });
  git(dir, 'init', '-q'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Tighten chip padding for dense tables');
  const r = codeReason(dir, 'theme.css:2');
  assert.deepEqual({ ...r, hash: r.hash.length }, { hash: 7, author: 'Ana', date: '2026-09-20', subject: 'Tighten chip padding for dense tables' });
  assert.match(reasonLine(r), /^last changed 2026-09-20 by Ana: "Tighten chip padding for dense tables" \([0-9a-f]{7}\)$/);
  // A line changed after the last commit says so.
  const dir3 = makeFixture({ 'b.css': '.b {\n}\n' });
  git(dir3, 'init', '-q'); git(dir3, 'add', '.'); git(dir3, 'commit', '-qm', 'b');
  appendFileSync(join(dir3, 'b.css'), '.c { gap: 4px; }\n');
  assert.equal(reasonLine(codeReason(dir3, 'b.css:3')), 'changed in the working copy, not committed yet');
  const dir2 = makeFixture({ 'a.css': '.a{}\n' });
  assert.equal(codeReason(dir2, 'a.css:1'), null);                  // not a git repository
  assert.equal(codeReason(dir, 'nowhere'), null);
});

test('Figma side: the latest named version, as one line', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ versions: [
    { created_at: '2026-09-24T09:00:00Z', label: '', user: { handle: 'Rui' } },
    { created_at: '2026-09-20T09:00:00Z', label: 'Buttons v3', description: 'Denser sizes', user: { handle: 'Ana' } },
  ] }) });
  const r = await figmaReason('KEY', 'TOKEN', { fetchImpl });
  assert.equal(figmaReasonLine(r), 'Figma: last named version "Buttons v3" (Denser sizes) on 2026-09-20 by Ana; last edit 2026-09-24');
  assert.equal(await figmaReason('KEY', null, { fetchImpl }), null);
});
