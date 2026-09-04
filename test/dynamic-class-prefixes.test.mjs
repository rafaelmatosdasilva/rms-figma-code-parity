import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDynamicClassPrefixes } from '../dynamic-class-prefixes.mjs';

test('extracts the trailing class prefix from a + splice and a ${} template', () => {
  const corpus = [
    `const a = '<div class="card issue-item t-' + iss.type + '">';`,
    'const b = `panel section-${name}`;',
  ].join('\n');
  const prefixes = extractDynamicClassPrefixes(corpus);
  assert.ok(prefixes.includes('t-'));         // from the + splice
  assert.ok(prefixes.includes('section-'));   // from the ${} template
});

test('does NOT hang on a large embedded data blob (the ICC/base64 case) and stays linear', () => {
  // A single 400k-char quoted base64-like blob with no early quote/`/$/} — the exact shape that
  // made the old unbounded regexes go O(n²) and hang the audit. Must return quickly.
  const blob = 'A'.repeat(400000);
  const corpus = `window.__ICC = "${blob}";\nconst c = 'x issue-' + k;`;
  const t = Date.now();
  const prefixes = extractDynamicClassPrefixes(corpus);
  const ms = Date.now() - t;
  assert.ok(ms < 2000, `expected fast scan, took ${ms}ms`); // was effectively unbounded before
  assert.ok(prefixes.includes('issue-'));                    // real prefix still found past the blob
});

test('returns nothing for a fragment with no name-ish trailing prefix', () => {
  assert.deepEqual(extractDynamicClassPrefixes(`const a = '' + x;`), []);
});
