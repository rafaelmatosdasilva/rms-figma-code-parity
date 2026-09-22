// prune-check.mjs - "prune candidates" advisory (I8). Pure over emitted artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDeprecatedTokens, pruneCandidates } from '../prune-check.mjs';

test('collectDeprecatedTokens finds $deprecated leaves by dot-path, skips live ones', () => {
  const dict = {
    $description: 'x',
    color: {
      old: { $value: '#000', $deprecated: true },
      good: { $value: '#111', $deprecated: false },
    },
    radii: { legacy: { $value: '2px', $deprecated: true } },
  };
  assert.deepEqual(collectDeprecatedTokens(dict).sort(), ['color.old', 'radii.legacy']);
  assert.deepEqual(collectDeprecatedTokens(null), []);
});

test('pruneCandidates flags deprecated tokens, single-option variants, single-use components', () => {
  const built = [
    { name: 'Button', contract: {
      props: [
        { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'] },   // real axis - not flagged
        { name: 'tone', type: 'enum', options: ['brand'] },            // single-option - flagged
        { name: 'loading', type: 'boolean' },                          // not an enum - ignored
      ],
    } },
    { name: 'Icon', contract: { deprecated: true, props: [] } },       // explicitly deprecated component
    { name: 'Card', contract: { props: [] } },
  ];
  const usage = { components: new Map([['Icon', 1], ['Button', 2]]) };  // Icon used once, Card by nobody
  const tokensDict = { space: { old: { $value: '4px', $deprecated: true } } };

  const r = pruneCandidates({ built, usage, tokensDict });
  assert.deepEqual(r.deprecatedTokens, ['space.old']);
  assert.deepEqual(r.deprecatedComponents, ['Icon']);
  assert.deepEqual(r.singleOptionVariants, [{ component: 'Button', prop: 'tone', option: 'brand' }]);
  assert.deepEqual(r.singleUseComponents, ['Icon']);          // reach == 1
  assert.deepEqual(r.unreferencedComponents, ['Card']);       // reach == 0, reported separately
  assert.equal(r.total, 1 + 1 + 1 + 1);                       // token + component + variant + single-use
});

test('pruneCandidates accepts a plain-object reach map and empty inputs', () => {
  const r = pruneCandidates({ built: [{ name: 'A', contract: { props: [] } }], usage: { components: { A: 0 } } });
  assert.deepEqual(r.unreferencedComponents, ['A']);
  assert.equal(r.total, 0);                                   // unreferenced is NOT counted
  assert.deepEqual(pruneCandidates({}).total, 0);             // nothing in, nothing out
});
