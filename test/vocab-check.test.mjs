// vocab-check.mjs - closed-vocabulary / raw-container advisory (I16). Opt-in, project-declared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBannedContainers } from '../vocab-check.mjs';

test('counts banned container tags but not lookalikes', () => {
  const html = '<div><span>x</span></div><div/>\n<divider></divider>\n<nav>';
  const c = scanBannedContainers(html, ['div', 'nav', 'span']);
  assert.equal(c.div, 2, '<div> and <div/> count; <divider> does not');
  assert.equal(c.span, 1);
  assert.equal(c.nav, 1);
});

test('no bans configured = empty result', () => {
  assert.deepEqual(scanBannedContainers('<div><nav>', []), {});
  assert.deepEqual(scanBannedContainers('', ['div']), {});
});

test('accepts tags written with or without the leading <', () => {
  const c = scanBannedContainers('<ul><li>', ['<ul>', 'li']);
  assert.equal(c.ul, 1);
  assert.equal(c.li, 1);
});
