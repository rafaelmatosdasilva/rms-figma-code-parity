// test/helpers.mjs - shared fixture builder + gate runner for the regression tests.
//
// Each gate is an independent script that reads ds-config.json + snapshots + CSS from its
// working directory. runGate() builds a throwaway project from a { path: content } map and
// runs the gate against it (cwd = fixture), returning { code, out, dir }. `content` is written
// verbatim when it is a string, otherwise as pretty JSON.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url));

export function makeFixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

export function runGate(gateFile, files = {}, args = []) {
  const dir = makeFixture(files);
  try {
    const out = execFileSync('node', [join(SCRIPTS_DIR, gateFile), ...args], { cwd: dir, encoding: 'utf8' });
    return { code: 0, out, dir };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || ''), dir };
  }
}

// A minimal parity-map.mjs. Most gates import it optionally; a few read specific exports.
export const EMPTY_PARITY_MAP =
  'export const EXPLICIT={};export const SKIP_TOKENS=new Set();' +
  'export const COVERED=new Set();export const COVERED_PREFIX=[];';

// A crash in a gate surfaces as a Node stack trace on stderr - the marker every
// "array config must not crash" test asserts against.
export function crashed(out) {
  return /TypeError|ERR_INVALID_ARG_TYPE|\bat \S+ \(/.test(out);
}
