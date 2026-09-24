// capture-compare.mjs — the code capture side by side with the Figma snapshots. Token names must
// resolve exactly as Gate 3 resolves them, and a component field is only compared when the code
// really fixes it (content-sized heights, icon-only instances and "how" a background is drawn are
// not differences).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTokens, compareComponents, measuredLine } from '../capture-compare.mjs';

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
  assert.deepEqual(r.differ[0], { component: 'bar', field: 'gap', figma: 'gap/xl', figmaValue: '16px', code: '8px', codeVar: '--gap-m', expectedVar: '--gap-xl', rule: '.bar', at: 'theme.css:12', confidence: 'verified' });
  // The line a person reads: what differs, where, and what to write.
  assert.equal(measuredLine(r.differ[0]), 'bar gap: Figma gap/xl (16px), rendered 8px via --gap-m  (.bar · theme.css:12)  → set var(--gap-xl)');
  assert.match(measuredLine({ ...r.differ[0], confidence: 'single-source' }), /\[read from one source\]/);
  assert.doesNotMatch(measuredLine({ component: 'x', field: 'background', figma: 'paints a background', code: 'no background', rule: '.x', at: 'a.css:1' }), /→ set/);
});

test('components: padding of icon-only instances is not compared with a labelled design default', () => {
  const code = { components: { btn: { confidence: 'high', instance: { hasText: false }, props: { paddingLeft: { value: '0px', rule: '.btn:has(svg)', confidence: 'verified' } } } } };
  const r = compareComponents(code, { btn: { paddingVar: { lr: 'padding/xs' }, fontSizeVar: 'm' } }, { sizing: { 'padding/xs': '4px' } }, cfg, maps());
  assert.equal(r.differ.length, 0);
  assert.match(r.notComparable[0].why, /icon-only/);
});

test('icons: compared by viewBox and path data; missing and code-only icons counted', async () => {
  const { compareIcons } = await import('../capture-compare.mjs');
  const { pathHash } = await import('../icon-source.mjs');
  const code = { icons: {
    'icon-a': { viewBox: '0 0 16 16', paths: 1, pathHash: pathHash(['M1']), definedAt: ['a.html:3'] },
    'icon-b': { viewBox: '0 0 24 24', paths: 1, pathHash: pathHash(['M2']), definedAt: ['a.html:4'] },
    'icon-app': { viewBox: '0 0 16 16', paths: 1, pathHash: 'x' },
  } };
  const r = compareIcons(code, { _updated: 'x', 'icon-a': { viewBox: '0 0 16 16', paths: ['M1'] }, 'icon-b': { viewBox: '0 0 16 16', paths: ['M9'] }, 'icon-c': { viewBox: '0 0 16 16', paths: [] } });
  assert.equal(r.match, 1);
  assert.deepEqual(r.differ, [{ id: 'icon-b', what: 'viewBox Figma 0 0 16 16, code 0 0 24 24 · path data differs (Figma 1 path(s), code 1)', at: 'a.html:4' }]);
  assert.deepEqual(r.missingInCode, ['icon-c']);
  assert.equal(r.codeOnly, 1);
});

test('nesting: Figma sub-components against what the code nests', async () => {
  const { compareNesting } = await import('../capture-compare.mjs');
  const code = { nesting: { Card: { instancesSeen: 2, contains: { Badge: { renderedIn: ['app'] }, Avatar: { inSource: true } } } } };
  const r = compareNesting(code, { Card: ['Badge', 'Button', 'Icon/Star'], Modal: ['Button'] });
  assert.equal(r.match, 1);
  assert.deepEqual(r.differ, [{ parent: 'Card', child: 'Button', figma: 'nests it', code: 'not inside any of 2 rendered instance(s)' }]);
  assert.deepEqual(r.notComparable, [{ parent: 'Modal', why: 'not seen in the code' }]);
  assert.deepEqual(r.codeOnly, [{ parent: 'Card', child: 'Avatar' }]);
});

test('components: padding on both sides, every corner, and line height from the text style', () => {
  const v = (value, extra = {}) => ({ value, confidence: 'verified', rule: '.c', ...extra });
  const code = { components: { c: { confidence: 'high', instance: { hasText: true }, props: {
    paddingLeft: v('8px'), paddingRight: v('4px'), paddingTop: v('4px'), paddingBottom: v('4px'),
    borderTopLeftRadius: v('6px'), borderTopRightRadius: v('6px'), borderBottomRightRadius: v('0px'), borderBottomLeftRadius: v('6px'),
    fontSize: v('11px'), lineHeight: v('1.5'),
  } } } };
  const vars = { sizing: { 'padding/s': '4px', 'padding/m': '8px', 'radii/m': '6px' }, typography: { m: { size: '11px', lh: '16px' } } };
  const r = compareComponents(code, { c: { paddingVar: { lr: 'padding/m', tb: 'padding/s' }, innerRadiusVar: 'radii/m', fontSizeVar: 'm' } }, vars, cfg, maps());
  const d = Object.fromEntries(r.differ.map((x) => [x.field, x.code]));
  assert.equal(d['padding (left/right)'], '4px');            // the right side is off
  assert.equal(d.radius, '0px');                             // one corner is square
  assert.equal(d['line height'], '16.5px');                  // 1.5 × 11px ≠ 16px
  assert.equal(d['padding (top/bottom)'], undefined);
});

test('components: a page-level line height, a wrapper root and content-only state heights are not compared', () => {
  const code = { components: {
    b: { confidence: 'high', instance: { hasText: true }, props: { fontSize: { value: '11px', confidence: 'verified' }, lineHeight: { value: '20px', inherited: true, rule: 'html, body', confidence: 'single-source' } } },
    w: { confidence: 'high', instance: { hasText: true }, props: { borderTopWidth: { value: '0px' }, borderRightWidth: { value: '0px' }, borderBottomWidth: { value: '0px' }, borderLeftWidth: { value: '0px' }, backgroundColor: { value: 'rgba(0, 0, 0, 0)' }, borderTopLeftRadius: { value: '0px' } },
      states: { 'State=Default': { changed: { height: { value: '49px' } } } } },
  } };
  const r = compareComponents(code, { b: { fontSizeVar: 'm' }, w: { strokeOnDefault: true, variantHeight: { 'State=default': 40 } } }, { typography: { m: { size: '11px', lh: '16px' } } }, cfg, maps());
  assert.equal(r.differ.length, 0, JSON.stringify(r.differ));
  assert.match(r.notComparable.find((n) => n.field === 'stroke').why, /wrapper/);
});

test('components: a stroked design with no visible border, sides Figma names, and state opacity', () => {
  const w = (t, r = '0px', b = '0px', l = '0px') => ({ borderTopWidth: { value: t, rule: '.x' }, borderRightWidth: { value: r }, borderBottomWidth: { value: b }, borderLeftWidth: { value: l }, borderTopColor: { value: 'rgb(0, 0, 0)' }, backgroundColor: { value: 'rgb(255, 255, 255)' } });
  const code = { components: {
    a: { confidence: 'high', instance: { hasText: true }, props: { ...w('0px'), borderTopColor: { value: 'rgba(0, 0, 0, 0)' } } },
    s: { confidence: 'high', instance: { hasText: true }, props: w('0px', '0px', '1px', '0px') },
    o: { confidence: 'high', instance: { hasText: true }, props: { opacity: { value: '1' } }, states: { 'Disabled=true': { changed: { opacity: { value: '0.4', rule: '.o:disabled' } } } } },
  } };
  const structure = { a: { strokeOnDefault: true }, s: { strokeOnDefault: true, strokeSides: 'right' }, o: { variantOpacity: { disabled: 0.24 } } };
  const d = Object.fromEntries(compareComponents(code, structure, {}, cfg, maps()).differ.map((x) => [x.component, `${x.field}: ${x.figma} / ${x.code}`]));
  assert.equal(d.s, 'stroke: border on right / border on bottom');
  assert.equal(d.o, 'opacity (disabled): 0.24 / 0.4');
});

test('components: the extended capture adds width, stroke widths, opacity and text facts', () => {
  const v = (value, extra = {}) => ({ value, confidence: 'verified', rule: '.k', ...extra });
  const code = { components: { k: { confidence: 'high', instance: { hasText: true }, size: { width: 120 },
    props: { width: v('120px'), borderTopWidth: v('1px'), borderRightWidth: v('1px'), borderBottomWidth: v('2px'), borderLeftWidth: v('1px'), borderTopColor: v('rgb(0, 0, 0)'), backgroundColor: v('rgb(255, 255, 255)'), opacity: v('1'), fontSize: v('12px'),
      fontFamily: v('"Inter", sans-serif'), letterSpacing: v('0.6px'), textTransform: v('none'), lineHeight: v('18px') } } } };
  const f = { k: { box: { width: 100, sizing: { h: 'FIXED' } }, stroke: { weights: [1, 1, 1, 1] }, opacity: 0.5,
    text: { fontFamily: 'Inter', letterSpacing: { unit: 'PERCENT', value: 5 }, textCase: 'UPPER', lineHeight: { unit: 'PERCENT', value: 150 } } } };
  const r = compareComponents(code, f, {}, cfg, maps());
  const d = Object.fromEntries(r.differ.map((x) => [x.field, `${x.figma} / ${x.code}`]));
  assert.equal(d.width, '100 / 120');
  assert.equal(d['border bottom width'], '1 / 2px');
  assert.equal(d.opacity, '0.5 / 1');
  assert.equal(d['text case'], 'uppercase / none');
  assert.equal(d['font family'], undefined);           // "Inter" = Inter
  assert.equal(d['letter spacing'], undefined);        // 5% of 12px = 0.6px
  assert.equal(d['line height'], undefined);           // 150% of 12px = 18px
});

test('colours: every mode against the token value, paint opacity included; a variant compares only what it changes', () => {
  const fact = (value, v) => ({ value, var: v, rule: '.chip', at: 'a.css:2', confidence: 'verified' });
  const code = { components: { chip: { confidence: 'high', instance: { hasText: true }, fill: 'direct',
    props: { backgroundColor: fact('rgb(255, 255, 255)', '--local-bg'), color: fact('rgb(0, 0, 0)', '--ink'), paddingTop: fact('4px') },
    colors: { light: { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }, dark: { backgroundColor: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' } },
    states: { 'State=Hover': { changed: { backgroundColor: { value: 'rgb(200, 200, 200)', rule: '.chip:hover', at: 'a.css:9' } },
      colors: { light: { backgroundColor: 'rgb(200, 200, 200)', color: 'rgb(0, 0, 0)' }, dark: { backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgb(255, 255, 255)' } } } } } } };
  const paint = (token, opacity = 1) => ({ token, hex: '#000000', opacity });
  const structure = { chip: { fillStructure: 'direct', colors: { fill: paint('chip/bg/color'), text: paint('ink/color') }, defaultVariant: 'State=Default',
    variants: { 'State=Default': { paddingPx: [4, 8, 4, 8], colors: { fill: paint('chip/bg/color') } }, 'State=Hover': { paddingPx: [4, 8, 4, 8], colors: { fill: paint('chip/hover/color', 0.1) } } } } };
  const vars = { color: { light: { 'chip/bg/color': '#ffffff', 'ink/color': '#000000', 'chip/hover/color': '#c8c8c8' }, dark: { 'chip/bg/color': '#111111', 'ink/color': '#ffffff', 'chip/hover/color': '#ffffff' } } };
  const r = compareComponents(code, structure, vars, cfg, maps());
  const got = r.differ.map((d) => `${d.field}: ${d.figmaValue} vs ${d.code}`);
  assert.deepEqual(got, ['background [dark]: #111111 vs rgb(0, 0, 0)', 'background (State=Hover) [light]: #c8c8c81a vs rgb(200, 200, 200)'], JSON.stringify(r.differ));
  assert.equal(r.differ[1].at, 'a.css:9');                                   // the state's own rule
  // The token's own variable in code is a match by itself (its value per mode is Gate 3's job).
  code.components.chip.props.backgroundColor.var = '--chip-bg';
  assert.equal(compareComponents(code, structure, vars, cfg, maps()).differ.filter((d) => d.field === 'background [dark]').length, 0);
});

test('variants: each Figma axis value is the default, a produced state or a declared one; the rest is listed', async () => {
  const { compareVariants } = await import('../capture-compare.mjs');
  const code = { components: { chip: { states: { 'State=Hover': {} }, statesNotProduced: [{ state: 'State=Focus' }] } } };
  const structure = { chip: { defaultVariant: 'State=Default, Size=M', variants: { 'State=Default, Size=M': {}, 'State=Hover, Size=M': {}, 'State=Focus, Size=M': {}, 'State=Default, Size=L': {} } } };
  const r = compareVariants(code, structure);
  assert.deepEqual(r.missing, [{ component: 'chip', axis: 'size', value: 'l' }]);
  assert.equal(r.built, 4);
});

test('breakpoints: a responsive token against the value measured at that breakpoint width', async () => {
  const { compareBreakpoints } = await import('../capture-compare.mjs');
  const code = { components: { card: { props: { paddingLeft: { rule: '.card', at: 'a.css:3' } }, breakpoints: { Phone: { width: 375, paddingLeft: '8px', columnGap: '8px' }, Desktop: { width: 1024, paddingLeft: '16px', columnGap: '8px' } } } } };
  const structure = { card: { paddingVar: { lr: 'padding/page' }, gapVar: 'gap/m' } };
  const vars = { breakpoints: { Phone: { 'viewport/min-width': '0', 'padding/page': '12px' }, Desktop: { 'viewport/min-width': '1024', 'padding/page': '16px' } } };
  const r = compareBreakpoints(code, structure, vars);
  assert.deepEqual(r.differ.map((d) => `${d.field}: ${d.figmaValue} vs ${d.code}`), ['padding (left) @ Phone (375px): 12px vs 8px']);
  assert.equal(r.match, 1);                                  // gap/m is not responsive: not compared here
});
