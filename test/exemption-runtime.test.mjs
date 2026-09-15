// exemption-check: a mapped CSS var (EXPLICIT / EXPLICIT_SIZING) that is absent from
// the static token CSS but USED in component code is runtime-injected (backend
// stylesheet), not a BROKEN allowlist entry. A genuinely-absent, unused mapped var
// is still BROKEN. Mirrors the parity-check runtime-token fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from './helpers.mjs';

const CFG = { paths: { themeCSS: 'theme.css', snapshotVars: 'snap.json' }, componentSrcDirs: ['src'],
  figma: { modes: [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' }] } };
const MAP = 'export const EXPLICIT={};export const SKIP_TOKENS=new Set();export const EXPLICIT_SIZING={"advanced/toast/margin/bottom":"--advanced-toast-margin-bottom"};';

test('[bugfix exemption runtime] a runtime-injected mapped sizing var is OK, not BROKEN', () => {
  const { code, out } = runGate('exemption-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'snap.json': { sizing: { 'advanced/toast/margin/bottom': '8px' } },
    'src/Toast.vue': '<style>.t{ margin-bottom: var(--advanced-toast-margin-bottom); }</style>\n',
  });
  assert.equal(code, 0, out);                      // runtime-injected mapped var -> valid, not broken
  assert.match(out, /VALID\s+1/, out);
  assert.doesNotMatch(out, /BROKEN\s+[1-9]/, out);
});

test('[regression exemption] a genuinely-absent, unused mapped var is still BROKEN', () => {
  const { code, out } = runGate('exemption-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --x: 1px; }\n',
    'snap.json': { sizing: { 'advanced/toast/margin/bottom': '8px' } },
    'src/Toast.vue': '<style>.t{ color: red; }</style>\n',   // does NOT reference the var
  });
  assert.equal(code, 1, out);
  assert.match(out, /not declared/i, out);
});

test('[regression exemption] a declared mapped var with the WRONG value is still BROKEN', () => {
  const { code, out } = runGate('exemption-check.mjs', {
    'ds-config.json': CFG, 'parity-map.mjs': MAP,
    'theme.css': ':root { --advanced-toast-margin-bottom: 99px; }\n',   // declared, wrong value
    'snap.json': { sizing: { 'advanced/toast/margin/bottom': '8px' } },
  });
  assert.equal(code, 1, out);
  assert.match(out, /value mismatch/i, out);
});
