import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const MOTION = fileURLToPath(new URL('../motion-check.mjs', import.meta.url));
const EFFECT = fileURLToPath(new URL('../effect-check.mjs', import.meta.url));

function run(gate, { themeCss, snapshot, config }) {
  const dir = mkdtempSync(join(tmpdir(), 'me-gate-'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'theme.css'), themeCss);
  writeFileSync(join(dir, 'figma-vars.snapshot.json'), JSON.stringify(snapshot));
  try {
    return { code: 0, out: execFileSync('node', [gate], { cwd: dir, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const base = { paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' } };

// ── Motion ────────────────────────────────────────────────────────────────────
test('motion: no-op (exit 0, skipped) when not configured', () => {
  const { code, out } = run(MOTION, { themeCss: ':root{}', snapshot: {}, config: base });
  assert.equal(code, 0);
  assert.match(out, /not configured/i);
});

test('motion: passes when CSS matches (whitespace/case-insensitive)', () => {
  const snapshot = { motion: { 'ease/standard': 'cubic-bezier(0.2, 0, 0, 1)', 'dur/fast': '150ms' } };
  const config = { ...base, figma: { motion: {} } };
  const themeCss = `:root { --ease-standard: cubic-bezier(0.2,0,0,1); --dur-fast: 150MS; }`;
  const { code } = run(MOTION, { themeCss, snapshot, config });
  assert.equal(code, 0);
});

test('motion: fails on a wrong duration', () => {
  const snapshot = { motion: { 'dur/fast': '150ms' } };
  const config = { ...base, figma: { motion: {} } };
  const themeCss = `:root { --dur-fast: 200ms; }`;
  const { code, out } = run(MOTION, { themeCss, snapshot, config });
  assert.equal(code, 1);
  assert.match(out, /dur\/fast.*Figma 150ms, CSS 200ms/);
});

// ── Effects ─────────────────────────────────────────────────────────────────────
test('effect: no-op when not configured', () => {
  const { code, out } = run(EFFECT, { themeCss: ':root{}', snapshot: {}, config: base });
  assert.equal(code, 0);
  assert.match(out, /not configured/i);
});

test('effect: passes when CSS box-shadow matches (hex vs rgba normalised)', () => {
  const snapshot = { effects: { 'elevation/1': '0px 1px 3px rgba(0, 0, 0, 0.2)' } };
  const config = { ...base, figma: { effects: {} } };
  // CSS uses hex; the gate normalises #rrggbbaa → rgba() on both sides.
  const themeCss = `:root { --elevation-1: 0px 1px 3px #00000033; }`;
  const { code, out } = run(EFFECT, { themeCss, snapshot, config });
  assert.equal(code, 0, out);
});

test('effect: fails on a wrong shadow', () => {
  const snapshot = { effects: { 'elevation/1': '0px 1px 3px rgba(0, 0, 0, 0.2)' } };
  const config = { ...base, figma: { effects: {} } };
  const themeCss = `:root { --elevation-1: 0px 2px 6px rgba(0, 0, 0, 0.2); }`;
  const { code, out } = run(EFFECT, { themeCss, snapshot, config });
  assert.equal(code, 1);
  assert.match(out, /elevation\/1/);
});
