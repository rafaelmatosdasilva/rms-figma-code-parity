// Gate [3] sizing: a token whose CSS var is not in the STATIC token CSS must not
// be blindly failed as "not declared". A runtime-token DS (its stylesheet injected
// from a backend, e.g. index.html <link id="dynamic-stylesheet"> with no href)
// declares these at run time; the var is still USED in the component code. These
// tests pin: runtime-injected-and-used -> accurate skip (not a fail); truly absent
// -> still fails; a differing-case :root var -> matched and value-checked; a
// component-scoped var -> reported accurately, not as "not declared".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runGate } from './helpers.mjs';

const BASE = {
  'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotVars: 'snap.json' }, componentSrcDirs: ['src'],
    figma: { colorCollection: 'Color', modes: [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' }] } },
  'parity-map.mjs': 'export const EXPLICIT={};export const SKIP_TOKENS=new Set();export const SIZING_SKIP=new Map();export const EXPLICIT_SIZING={};',
};
const result = (dir) => JSON.parse(readFileSync(join(dir, 'parity-check-result.json'), 'utf8'));

test('[bugfix runtime] a sizing token used in code but absent from static CSS is runtime-injected, not a fail', () => {
  const { dir } = runGate('parity-check.mjs', {
    ...BASE,
    'theme.css': ':root { --x: 1px; }\n',
    'snap.json': { sizing: { 'advanced/toast/margin/bottom': '8px' } },
    'src/Toast.vue': '<style>.t{ margin-bottom: var(--advanced-toast-margin-bottom); }</style>\n',
  }, ['--json']);
  const r = result(dir);
  assert.equal(r.fail.length, 0, 'must not FAIL: ' + JSON.stringify(r.fail));
  const s = r.skip.find(x => x.token === 'advanced/toast/margin/bottom');
  assert.ok(s && /runtime-injected/i.test(s.reason), 'expected runtime-injected skip: ' + JSON.stringify(r.skip));
});

test('[regression] a sizing token neither declared nor used still fails as not declared', () => {
  const { dir } = runGate('parity-check.mjs', {
    ...BASE,
    'theme.css': ':root { --x: 1px; }\n',
    'snap.json': { sizing: { 'advanced/ghost/token': '8px' } },
    'src/Toast.vue': '<style>.t{ color: red; }</style>\n',   // does NOT reference the var
  }, ['--json']);
  const r = result(dir);
  const f = r.fail.find(x => x.token === 'advanced/ghost/token');
  assert.ok(f && /not declared/i.test(f.issue || ''), 'expected a not-declared FAIL: ' + JSON.stringify(r.fail));
});

test('[bugfix case] a :root var declared in a different case is matched and value-checked (was a false not-declared)', () => {
  const { dir } = runGate('parity-check.mjs', {
    ...BASE,
    'theme.css': ':root { --advanced-toast-margin-leftright: 12px; }\n',      // lowercase leaf
    'snap.json': { sizing: { 'advanced/toast/margin/leftRight': '12px' } },   // camelCase token
  }, ['--json']);
  const r = result(dir);
  assert.equal(r.fail.length, 0, 'case-insensitive match should not fail: ' + JSON.stringify(r.fail));
  assert.ok(r.passList.includes('sizing advanced/toast/margin/leftRight'), 'expected a PASS: ' + JSON.stringify(r.passList));
});

test('[regression case] a case-matched :root var with the WRONG value still fails', () => {
  const { dir } = runGate('parity-check.mjs', {
    ...BASE,
    'theme.css': ':root { --advanced-toast-margin-leftright: 99px; }\n',      // wrong value
    'snap.json': { sizing: { 'advanced/toast/margin/leftRight': '12px' } },
  }, ['--json']);
  const r = result(dir);
  const f = r.fail.find(x => x.token === 'advanced/toast/margin/leftRight');
  assert.ok(f && f.css === '99px' && String(f.figma) === '12px', 'value mismatch must still FAIL: ' + JSON.stringify(r.fail));
});

test('[bugfix scope] a var declared outside :root is reported accurately, not as not-declared', () => {
  const { dir } = runGate('parity-check.mjs', {
    ...BASE,
    'theme.css': ':root { --x: 1px; }\n.toast { --advanced-toast-margin-bottom: 8px; }\n',
    'snap.json': { sizing: { 'advanced/toast/margin/bottom': '8px' } },
  }, ['--json']);
  const r = result(dir);
  assert.equal(r.fail.length, 0, 'component-scoped var should not FAIL: ' + JSON.stringify(r.fail));
  const s = r.skip.find(x => x.token === 'advanced/toast/margin/bottom');
  assert.ok(s && /outside :root/i.test(s.reason), 'expected outside-:root skip: ' + JSON.stringify(r.skip));
});
