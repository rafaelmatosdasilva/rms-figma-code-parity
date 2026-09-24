// capture-compare.mjs — the code capture side by side with the Figma snapshots. Token names must
// resolve exactly as Gate 3 resolves them, and a component field is only compared when the code
// really fixes it (content-sized heights, icon-only instances and "how" a background is drawn are
// not differences).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTokens, compareComponents } from '../capture-compare.mjs';

const maps = (over = {}) => ({ EXPLICIT: {}, EXPLICIT_SIZING: {}, SKIP_TOKENS: new Set(), NULL_TOKENS: new Set(), KNOWN_NULL: new Set(), SIZING_SKIP: new Map(), TYPO: {}, ...over });
const cfg = { figma: { namingConvention: { dropSegments: ['color', 'default'] } } };
const tok = (v) => ({ modes: { light: { value: v, confidence: 'verified' } } });

test('tokens: "/color" is dropped before parity-map lookup, an explicit null is skipped, values compare by meaning', () => {
  const code = { tokens: { '--card-bg': tok('#FFFFFF'), '--shared': tok('rgb(0, 0, 0)'), '--gap-s': tok('8px'), '--m-size': tok('11px') } };
  const vars = {
    color: { light: { 'card/bg/color': '#ffffff', 'badge/label/color': '#000000', 'overlay/color': '#000000', 'ghost/color': '#123456' } },
    sizing: { 'gap/s': '8px' },
    typography: { m: { size: '11px' } },
  };
  const r = compareTokens(code, vars, cfg, maps({ EXPLICIT: { 'badge/label': '--shared', overlay: null }, TYPO: { '--m-size': ['m', 'size'] } }));
  assert.equal(r.match, 4);                                    // card, badge (via EXPLICIT), gap, typography
  assert.equal(r.skipped, 1);                                  // overlay → no variable on purpose
  assert.deepEqual(r.missingInCode.map((m) => m.cssVar), ['--ghost']);
});

test('components: heights only when the code fixes one; min-height by its value; background by "paints or not"', () => {
  const code = { components: {
    bar: { confidence: 'high', instance: { hasText: true }, size: { height: 49 }, fill: 'direct', props: { minHeight: { value: '48px', rule: '.bar', confidence: 'verified' } } },
    card: { confidence: 'high', instance: { hasText: true }, size: { height: 232 }, fill: 'none', props: { height: { value: '232px', from: 'initial', confidence: 'default' } } },
    btn: { confidence: 'high', instance: { hasText: true }, size: { height: 24 }, fill: 'direct', props: { height: { value: '24px', rule: '.btn', confidence: 'verified' } } },
  } };
  const structure = { bar: { h: 48 }, card: { h: 248 }, btn: { h: 24, fillStructure: 'before' } };
  const r = compareComponents(code, structure, {}, cfg, maps());
  assert.equal(r.match, 3);                                    // bar min-height 48, btn height 24, btn paints (before ≈ direct)
  assert.deepEqual(r.notComparable.map((n) => `${n.component}:${n.why}`), ['card:the code height follows its content']);
  assert.equal(r.differ.length, 0);
});

test('components: a real difference names the token, the rule and the source line', () => {
  const code = { components: { bar: { confidence: 'high', instance: { hasText: true }, props: { columnGap: { value: '8px', var: '--gap-m', rule: '.bar', at: 'theme.css:12', confidence: 'verified' } } } } };
  const r = compareComponents(code, { bar: { gapVar: 'gap/xl' } }, { sizing: { 'gap/xl': '16px' } }, cfg, maps());
  assert.deepEqual(r.differ[0], { component: 'bar', field: 'gap', figma: 'gap/xl', figmaValue: '16px', code: '8px', codeVar: '--gap-m', expectedVar: '--gap-xl', rule: '.bar', at: 'theme.css:12' });
});

test('components: padding of icon-only instances is not compared with a labelled design default', () => {
  const code = { components: { btn: { confidence: 'high', instance: { hasText: false }, props: { paddingLeft: { value: '0px', rule: '.btn:has(svg)', confidence: 'verified' } } } } };
  const r = compareComponents(code, { btn: { paddingVar: { lr: 'padding/xs' }, fontSizeVar: 'm' } }, { sizing: { 'padding/xs': '4px' } }, cfg, maps());
  assert.equal(r.differ.length, 0);
  assert.match(r.notComparable[0].why, /icon-only/);
});
