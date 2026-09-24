// code-capture.mjs + css-source.mjs — the code side captured once, like Figma. Known-answer
// fixtures: every fact below is known in advance, so the capture must reproduce it exactly.
// Browser cases run when a Chrome/Chromium is available (CHROME_PATH or a Playwright install).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';
import { captureCode, modeSwitch } from '../code-capture.mjs';
import { loadCssSources, rootTokens, walkCss, resolveVars, canonValue, blankComments } from '../css-source.mjs';
import { findChrome } from '../cdp.mjs';

const HAS_CHROME = !!findChrome({ playwright: true }) && typeof WebSocket !== 'undefined';
const browserTest = (name, fn) => test(name, { skip: HAS_CHROME ? false : 'no Chrome available' }, fn);
const LIGHT_DARK = [{ name: 'Light', snapshotKey: 'light', cssSelector: 'root' }, { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' }];
const fact = (snap, name, mode) => snap.tokens[name]?.modes?.[mode];

// ── Static reading (no browser) ────────────────────────────────────────────────
test('static: follows @import, keeps file and line, reads every :root block (not just the first)', () => {
  const dir = makeFixture({
    'css/base.css': '@import "palette.css";\n:root {\n  --surface: var(--grey-100);\n}\n:root { --gap-s: 8px; }\n',
    'css/palette.css': '/* palette */\n:root { --grey-100: #F5F5F5; }\n',
  });
  const { files } = loadCssSources(dir, ['css/base.css']);
  assert.deepEqual(files.map((f) => f.file), ['css/palette.css', 'css/base.css']);   // import applied first
  const vars = rootTokens(files, LIGHT_DARK[0]);
  assert.equal(vars.get('--gap-s').value, '8px');                                     // the second :root block
  assert.equal(`${vars.get('--surface').file}:${vars.get('--surface').line}`, 'css/base.css:3');
  assert.deepEqual(resolveVars('var(--surface)', vars), { value: '#F5F5F5', chain: ['--surface', '--grey-100'], unresolved: [] });
});

test('static: modes follow the real cascade, including the trap where a later :root beats an earlier dark block', () => {
  const css = blankComments(`
    @media (prefers-color-scheme: dark) { :root { --text: #fff; --bg: #000; } }
    :root { --text: #111; }
    :root { --bg: #fafafa; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; } }
    :root.hc, [data-contrast="more"] { --text: #000; }
    @layer base { :root { --ring: 2px !important; } }
    :root { --ring: 1px; }`);
  const src = [{ file: 't.css', text: css }];
  const dark = rootTokens(src, LIGHT_DARK[1]);
  assert.equal(dark.get('--text').value, '#111');     // the later :root wins in dark too (same specificity)
  assert.equal(dark.get('--bg').value, '#0a0a0a');    // the later dark block wins
  assert.equal(rootTokens(src, { cssSelector: 'class:hc' }).get('--text').value, '#000');
  assert.equal(rootTokens(src, { cssSelector: 'data:contrast=more' }).get('--text').value, '#000');
  assert.equal(rootTokens(src, LIGHT_DARK[0]).get('--ring').value, '2px');   // !important beats order
});

test('static: the parser handles nesting, strings and ";" inside url()', () => {
  const rules = walkCss(blankComments('.card { color: red; &:hover { color: blue; } --icon: url(data:image/png;base64,AA); .title { gap: 4px } }'), 'c.css');
  assert.deepEqual(rules.map((r) => r.selectors[0]), ['.card', '.card:hover', '.card .title']);
  assert.deepEqual(rules[0].decls.map((d) => `${d.prop}=${d.value}`), ['color=red', '--icon=url(data:image/png;base64,AA)']);
});

test('canonValue: a minifier\'s spelling equals the source\'s', () => {
  assert.equal(canonValue('rgba(0,0,0,.1)'), canonValue('rgba(0, 0, 0, 0.1)'));
  assert.equal(canonValue('.28s'), canonValue('0.28s'));
  assert.equal(canonValue('#FFFFFF'), '#ffffff');
  assert.notEqual(canonValue('#000000'), canonValue('#000'));   // hex digits are never reinterpreted
});

test('modeSwitch: every mode kind maps to a browser switch, and an unknown condition is refused honestly', () => {
  assert.equal(modeSwitch({ cssSelector: 'dark-media' }).media[0].value, 'dark');
  assert.match(modeSwitch({ cssSelector: 'class:dark' }).apply, /classList\.add\("dark"\)/);
  assert.match(modeSwitch({ cssSelector: 'data:theme=dim' }).apply, /setAttribute\("data-theme", "dim"\)/);
  assert.equal(modeSwitch({ cssSelector: 'media:(min-width: 768px)' }).viewport, 768);
  assert.ok(modeSwitch({ cssSelector: 'media:(orientation: portrait)' }).unsupported);
});

test('capture without a browser: every token is single-source and says why', async () => {
  const dir = makeFixture({
    'ds-config.json': { paths: { themeCSS: 'theme.css' }, figma: { modes: LIGHT_DARK }, codeReading: { browser: 'off' } },
    'theme.css': ':root { --a: 1px; } @media (prefers-color-scheme: dark) { :root { --a: 2px; } }',
  });
  const cfg = JSON.parse((await import('node:fs')).readFileSync(`${dir}/ds-config.json`, 'utf8'));
  const { snapshot } = await captureCode(dir, cfg);
  assert.deepEqual(fact(snapshot, '--a', 'dark'), { value: '2px', confidence: 'single-source', readBy: 'static', why: 'browser reading switched off' });
  assert.deepEqual(snapshot._coverage.byConfidence, { verified: 0, 'single-source': 2, uncertain: 0 });
});

test('capture is cached by content, and recaptures when a file changes', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = makeFixture({ 'theme.css': ':root { --a: 1px; }' });
  const cfg = { paths: { themeCSS: 'theme.css' }, figma: { modes: [LIGHT_DARK[0]] }, codeReading: { browser: 'off' } };
  assert.equal((await captureCode(dir, cfg)).cached, false);
  assert.equal((await captureCode(dir, cfg)).cached, true);
  writeFileSync(`${dir}/theme.css`, ':root { --a: 2px; }');
  const again = await captureCode(dir, cfg);
  assert.equal(again.cached, false);
  assert.equal(fact(again.snapshot, '--a', 'light').value, '2px');
});

// ── Browser reading ──────────────────────────────────────────────────────────────
browserTest('browser + static agree on a plain theme: verified, with alias chain and declaration line', async () => {
  const dir = makeFixture({
    'theme.css': '@import "palette.css";\n:root { --text: var(--ink); }\n@media (prefers-color-scheme: dark) { :root { --text: var(--paper); } }\n',
    'palette.css': ':root { --ink: #111111; --paper: #fafafa; }\n',
  });
  const { snapshot } = await captureCode(dir, { paths: { themeCSS: 'theme.css' }, figma: { modes: LIGHT_DARK } }, { force: true });
  assert.deepEqual(fact(snapshot, '--text', 'light'), { value: '#111111', confidence: 'verified', alias: ['--ink'] });
  assert.equal(fact(snapshot, '--text', 'dark').value, '#fafafa');
  assert.equal(snapshot.tokens['--text'].declaredAt, 'theme.css:2');
});

browserTest('browser reading switches class, data-attribute and media modes, three modes at once', async () => {
  const modes = [
    { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
    { name: 'Dim', snapshotKey: 'dim', cssSelector: 'data:theme=dim' },
    { name: 'Compact', snapshotKey: 'compact', cssSelector: 'class:compact' },
  ];
  const dir = makeFixture({ 'theme.css': ':root { --bg: #fff; --pad: 8px; } [data-theme="dim"] { --bg: #333; } :root.compact { --pad: 4px; }' });
  const { snapshot } = await captureCode(dir, { paths: { themeCSS: 'theme.css' }, figma: { modes } }, { force: true });
  assert.equal(fact(snapshot, '--bg', 'dim').value, '#333');
  assert.equal(fact(snapshot, '--pad', 'compact').value, '4px');
  assert.equal(fact(snapshot, '--pad', 'dim').value, '8px');
  assert.equal(snapshot._coverage.byConfidence.uncertain, 0);
});

browserTest('a reading the two sides disagree on is uncertain, never a design finding', async () => {
  // Static reading treats @supports as always true; the browser knows this condition is false.
  const dir = makeFixture({ 'theme.css': ':root { --w: 1px; } @supports (display: no-such-value) { :root { --w: 9px; } }' });
  const { snapshot } = await captureCode(dir, { paths: { themeCSS: 'theme.css' }, figma: { modes: [LIGHT_DARK[0]] } }, { force: true });
  assert.deepEqual(fact(snapshot, '--w', 'light'), { value: '1px', confidence: 'uncertain', readings: { browser: '1px', static: '9px' } });
});

browserTest('tokens injected at runtime by a page script are seen, and an app changing a DS token is recorded', async () => {
  const dir = makeFixture({
    'theme.css': ':root { --accent: #0066ff; }',
    'app/ui.html': '<!doctype html><html><head><style>:root{--accent:#ff0066}</style></head><body><script>const s=document.createElement("style");s.textContent=":root{--runtime-token:3px}";document.head.appendChild(s);</script></body></html>',
  });
  const cfg = { paths: { themeCSS: 'theme.css', plugins: ['app'], pluginCSS: ['app/ui.src.html'] }, figma: { modes: [LIGHT_DARK[0]] } };
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  assert.deepEqual(snapshot.appTokens['--runtime-token'], { app: { light: '3px' } });
  assert.deepEqual(snapshot.tokens['--accent'].overriddenBy, { app: { light: '#ff0066' } });
});

// ── Components (browser) ─────────────────────────────────────────────────────────
import { partFor, winningDecl, stateRecipe } from '../component-capture.mjs';

test('partFor: the right slot of a shorthand for each side', () => {
  assert.equal(partFor('padding', 'var(--a) var(--b)', 'paddingRight'), 'var(--b)');
  assert.equal(partFor('padding', '1px 2px 3px', 'paddingLeft'), '2px');
  assert.equal(partFor('gap', '4px 8px', 'columnGap'), '8px');
  assert.equal(partFor('border', '1.5px solid var(--line)', 'borderTopWidth'), '1.5px');
  assert.equal(partFor('border', '1.5px solid var(--line)', 'borderTopColor'), 'var(--line)');
  assert.equal(partFor('border', 'none', 'borderTopWidth'), '0px');
  assert.equal(partFor('background', 'none', 'backgroundColor'), 'transparent');
});

test('winningDecl: !important beats order, inline beats rules, implicit longhands are ignored', () => {
  const rule = (sel, props) => ({ rule: { selectorList: { text: sel }, style: { cssProperties: props } } });
  const m = [rule('.a', [{ name: 'color', value: 'red', important: true }]), rule('.b', [{ name: 'color', value: 'blue' }, { name: 'padding-top', value: '', implicit: true }])];
  assert.equal(winningDecl(m, null, 'color').value, 'red');
  assert.equal(winningDecl([rule('.b', [{ name: 'color', value: 'blue' }])], { cssProperties: [{ name: 'color', value: 'green' }] }, 'color').value, 'green');
  assert.equal(winningDecl(m, null, 'paddingTop'), null);
});

test('stateRecipe: pseudo-classes are forced, classes and attributes applied, other elements refused', () => {
  assert.deepEqual(stateRecipe('.btn', '.btn:hover').force, ['hover']);
  assert.deepEqual(stateRecipe('.btn', '.btn.selected').classes, ['selected']);
  assert.deepEqual(stateRecipe('.field', '.field--disabled').classes, ['field--disabled']);   // BEM modifier
  assert.equal(stateRecipe('.btn', '.btn:disabled').disabled, true);
  assert.deepEqual(stateRecipe('.tab', '.tab[aria-selected="true"]').attrs, [['aria-selected', 'true']]);
  assert.ok(stateRecipe('.row', '.row .label').error);
  assert.ok(stateRecipe('.radio', '.choice.done').error);
});

function componentProject() {
  const theme = [
    ':root { --pad-s: 8px; --pad-m: 12px; --ink: #111111; --line: #cccccc; --accent: #0055ff; --h: 32px; }',
    '.chip { padding: var(--pad-s) var(--pad-m); color: var(--ink); border: 1.5px solid var(--line); height: var(--h); }',
    '.chip:hover { color: var(--accent); }',
    '.chip.selected { color: var(--accent); }',
    '.field { padding: 4px; }',
    '.field--disabled { padding: 2px; }',
    '.toolbar .chip { padding-left: 2px; }',
    '.tag { min-height: 40px; height: 20px; }',
    '.pop { display: none; padding: 6px; }',
    '.row { gap: 8px; display: flex; }',
    '.row-item { padding: 3px; }',
    '.choice.done { color: var(--accent); }',
  ].join('\n');
  const page = `<!doctype html><html><head><link rel="stylesheet" href="../theme.css"><style>body{color:#222222;font-size:13px}</style></head><body>
    <div class="chip">Plain</div>
    <div class="toolbar"><div class="chip special" id="c2">Special</div></div>
    <div class="tag">Tag</div>
    <div class="pop">Hidden</div>
    <div class="field">Field</div>
    <div class="choice done">Done</div>
  </body></html>`;
  const contract = `export const CONTRACT = {
    chip: { propertyMap: { State: { Default: '.chip', Hover: '.chip:hover', Selected: '.chip.selected' } } },
    field: { propertyMap: { Disabled: { true: '.field--disabled' } } },
    choice: { propertyMap: { State: { Done: '.choice.done' } } },
    row: { children: [{ name: 'Item', cssSelector: '.row-item' }] },
  };
  export const COMPONENT_CSS_SELECTORS = { choice: { main: '.choice-box' } };`;
  const dir = makeFixture({
    'theme.css': theme, 'app/ui.html': page, 'structure-contract.mjs': contract,
    'struct.json': { components: { chip: {}, tag: {}, pop: {}, field: {}, row: {}, choice: {} } },
  });
  const cfg = { paths: { themeCSS: 'theme.css', plugins: ['app'], pluginCSS: ['app/ui.src.html'], snapshotStructure: 'struct.json' }, figma: { modes: [LIGHT_DARK[0]] }, componentSelectors: { tagAlias: '.tag' } };
  return { dir, cfg };
}

browserTest('components: measured where they render, traced to token and source line, and checked against the CSS', async () => {
  const { dir, cfg } = componentProject();
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  const chip = snapshot.components.chip;
  assert.equal(chip.instance.how, 'found');                                   // the plain instance, not the toolbar usage
  assert.deepEqual(
    { v: chip.props.paddingRight.value, var: chip.props.paddingRight.var, at: chip.props.paddingRight.at, c: chip.props.paddingRight.confidence },
    { v: '12px', var: '--pad-m', at: 'theme.css:2', c: 'verified' });
  // A 1.5px border is the code's fact; browsers draw it 1px.
  assert.deepEqual([chip.props.borderTopWidth.value, chip.props.borderTopWidth.drawn], ['1.5px', '1px']);
  assert.equal(chip.props.color.value, 'rgb(17, 17, 17)');
  // States: forced :hover and an applied class, each traced to its own rule.
  assert.equal(chip.states['State=Hover'].produced, 'forced :hover');
  assert.equal(chip.states['State=Hover'].changed.color.var, '--accent');
  assert.equal(chip.states['State=Selected'].produced, 'class .selected');
  // BEM modifier state.
  assert.equal(snapshot.components.field.states['Disabled=true'].changed.paddingTop.value, '2px');
});

browserTest('components: min-height beats height, display:none is not measured, two names can share an element', async () => {
  const { dir, cfg } = componentProject();
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  const tag = snapshot.components.tag.props.height;
  assert.equal(tag.value, '40px');
  assert.equal(tag.note, 'min-height wins over the declared height');
  assert.equal(tag.confidence, 'verified');
  assert.equal(snapshot.components.pop.props.paddingTop.confidence, 'not-read');
  assert.equal(snapshot.components.tagAlias.props.height.value, '40px');         // same element, second name
});

browserTest('components: a usage with extra classes is copied without them; a bare element gets its contract children and no invented height', async () => {
  const { dir, cfg } = componentProject();
  const page = (await import('node:fs')).readFileSync(`${dir}/app/ui.html`, 'utf8').replace('<div class="chip">Plain</div>', '');
  (await import('node:fs')).writeFileSync(`${dir}/app/ui.html`, page);
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  const chip = snapshot.components.chip;
  assert.equal(chip.instance.how, 'isolated-copy');
  assert.deepEqual(chip.instance.usageExtrasRemoved, ['.special', '#c2']);
  assert.equal(chip.props.paddingLeft.value, '12px');                            // not the toolbar's 2px
  const row = snapshot.components.row;
  assert.equal(row.instance.how, 'bare');
  assert.equal(row.props.columnGap.value, '8px');
  assert.equal(row.props.height.confidence, 'not-read');
});

browserTest('components: a state the instance cannot be put in is measured on an element already in it', async () => {
  const { dir, cfg } = componentProject();
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  const done = snapshot.components.choice.states['State=Done'];
  assert.match(done.produced, /found an element already in this state/);
  assert.equal(done.colors.light.color, 'rgb(0, 85, 255)');
});

test('components without a browser: the base rule is read statically, single-source', async () => {
  const { dir, cfg } = componentProject();
  const { snapshot } = await captureCode(dir, { ...cfg, codeReading: { browser: 'off' } }, { force: true });
  assert.deepEqual(snapshot.components.chip.props.paddingRight, { value: '12px', var: '--pad-m', at: 'theme.css:2', confidence: 'single-source', readBy: 'static', why: 'browser reading switched off' });
});

browserTest('components: when the built page and the source disagree, the value is uncertain, never a design fact', async () => {
  const { dir, cfg } = componentProject();
  // A stale build: the page carries its own copy of the rule with a different value.
  const fs = await import('node:fs');
  const page = fs.readFileSync(`${dir}/app/ui.html`, 'utf8').replace('<style>', '<style>.chip{padding-left:20px}');
  fs.writeFileSync(`${dir}/app/ui.html`, page);
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  const f = snapshot.components.chip.props.paddingLeft;
  assert.equal(f.value, '20px');
  assert.equal(f.confidence, 'uncertain');
  assert.deepEqual([f.readings.browser, f.readings.static], ['20px', '12px']);
  // Values the two readings agree on stay verified.
  assert.equal(snapshot.components.chip.props.paddingTop.confidence, 'verified');
});
