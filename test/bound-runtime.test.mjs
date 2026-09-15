// bound-check (Gate 4): a bound token whose CSS var is runtime-injected (token CSS
// loaded from a backend, absent from static files) but USED in component code DOES
// have a CSS variable - it must read as COVERED, not "no CSS var". A token neither
// declared nor used is still UNCOVERED. Mirrors the parity-check runtime-token fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const CFG = { paths: { themeCSS: 'theme.css' }, componentSrcDirs: ['src'] };
const MAP = 'export const COVERED=new Set();export const COVERED_PREFIX=[];export const EXPLICIT={};';

test('[bugfix bound runtime] a bound token used in code but absent from static CSS is COVERED', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'bound-tokens.json': { 'advanced/toast/bg': true },
    'src/Toast.vue': '<style>.t{ background: var(--advanced-toast-bg); }</style>\n',
  });
  assert.equal(code, 0, out);
  assert.match(out, /UNCOVERED\s+0/, out);
});

test('[regression bound] a bound token neither declared nor used is UNCOVERED', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'bound-tokens.json': { 'advanced/ghost/bg': true },
    'src/Toast.vue': '<style>.t{ color: red; }</style>\n',   // does NOT reference the var
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNCOVERED\s+1/, out);
});

test('[regression bound] a statically-declared bound token is still COVERED', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --advanced-toast-bg: #fff; }\n',
    'bound-tokens.json': { 'advanced/toast/bg': true },
  });
  assert.equal(code, 0, out);
  assert.match(out, /UNCOVERED\s+0/, out);
});
