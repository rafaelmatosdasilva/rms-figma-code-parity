// state-check (Gate 13): a VISIBLE state token whose CSS var is runtime-injected
// (backend stylesheet) but USED in component code has a CSS variable -> covered, not
// UNCOVERED. A token neither declared nor used is still UNCOVERED. Mirrors bound-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const CFG = { paths: { themeCSS: 'theme.css' }, componentSrcDirs: ['src'] };
const MAP = 'export const COVERED_STATE=new Set();export const COVERED=new Set();export const COVERED_PREFIX=[];export const EXPLICIT={};export const EXPLICIT_SIZING={};';

test('[bugfix state runtime] a visible state token used in code but absent from static CSS is covered', () => {
  const { code, out } = runGate('state-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'component-state-tokens.json': { 'advanced/toast/bg': true },
    'src/Toast.vue': '<style>.t{ background: var(--advanced-toast-bg); }</style>\n',
  });
  assert.equal(code, 0, out);
  assert.match(out, /UNCOVERED\D+0/, out);
});

test('[regression state] a visible state token neither declared nor used is UNCOVERED', () => {
  const { code, out } = runGate('state-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'component-state-tokens.json': { 'advanced/ghost/bg': true },
    'src/Toast.vue': '<style>.t{ color: red; }</style>\n',
  });
  assert.equal(code, 1, out);
});
