// The engine's default style guide: only what Figma and the code agree on, controls labelled with Figma's names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agreedView, modeAxes, optionEffect, instanceMarkup, componentTokens, agreedTokens } from '../styleguide-data.mjs';
import { fixtureProject } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));

const propsSnap = {
  chip: { properties: { Size: { type: 'VARIANT', defaultValue: 'M', variantOptions: ['M', 'L'] }, Icon: { type: 'VARIANT', defaultValue: 'False', variantOptions: ['False', 'True'] }, 'Label#3:4': { type: 'TEXT', defaultValue: 'Filter' } }, annotations: [{ label: 'Role: togglebutton' }], description: 'A filter.' },
  button: { properties: { Disabled: { type: 'BOOLEAN', defaultValue: false }, Tone: { type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Quiet'] } } },
  field: { properties: { State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Error'] } } },
};
const row = (component, figmaProp, codeProp, status, codeValue = '') => ({ component, figmaProp, codeProp, status, codeValue });

test('a prop both sides agree on is a control with Figma\'s label and the code\'s prop; the rest is only counted', () => {
  const rows = [row('chip', 'Size', 'size', 'match'), row('chip', 'Icon', 'icon', 'match'), row('chip', 'Label', 'label', 'match'), row('chip', 'not in Figma', 'pressed', 'extra'),
    row('button', 'Disabled', 'disabled', 'match'), row('button', 'Tone', 'variant', 'value')];
  const v = agreedView({ propsSnap, rows, classFor: (n) => `.${n}`, cssText: '.chip.chip--l{} .button{}', unbuilt: ['field'] });
  const chip = v.components.find((c) => c.name === 'chip');
  assert.equal(chip.cls, 'chip');
  assert.equal(chip.role, 'togglebutton');
  assert.deepEqual(chip.controls.map((c) => [c.label, c.prop, c.type]), [['Size', 'size', 'VARIANT'], ['Icon', 'icon', 'BOOLEAN'], ['Label', 'label', 'TEXT']]);
  assert.deepEqual(chip.controls[0].options, [{ label: 'M' }, { label: 'L', add: ['chip--l'], attrs: {} }]);   // a class only where the CSS has it
  assert.equal(chip.controls[1].part, 'svg, [class*="icon"]', 'a switch with no class shows or hides the part it names');
  const button = v.components.find((c) => c.name === 'button');
  assert.deepEqual(button.controls, [{ label: 'Disabled', prop: 'disabled', type: 'BOOLEAN', default: false, on: { add: [], attrs: { disabled: '' } } }]);   // Tone differs: not shown
  assert.equal(v.components.some((c) => c.name === 'field'), false, 'a component not built yet is not shown');
  assert.equal(v.notAgreed.differences, 2);   // the chip prop only the code has, the button's other default
  assert.equal(v.notAgreed.line, 'Not shown until agreed, 2 differences between Figma and the code and 1 component not built yet (field). Run the audit to see them and decide each one.');
});

test('a recorded value that moved on one side is not agreed; nothing left says so', () => {
  const rows = [row('button', 'Disabled', 'disabled', 'match')];
  const moved = agreedView({ propsSnap: { button: propsSnap.button }, rows, agreedRecord: { facts: { 'button/height': { figma: '32px', code: '36px' } } } });
  assert.equal(moved.notAgreed.differences, 1);
  const clean = agreedView({ propsSnap: { button: { properties: { Disabled: propsSnap.button.properties.Disabled } } }, rows, agreedRecord: { facts: { 'button/height': { figma: '32px', code: '32px' } } } });
  assert.equal(clean.notAgreed.line, 'Everything Figma and the code have is agreed.');
});

test('--styleguide with no template of the project\'s own builds the engine\'s, from the components that are built', { timeout: 300000 }, () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-sg-');
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/chip.css', 'src/components/Chip.jsx', 'src/components/tag.css', 'src/components/Tag.jsx']) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8')); }
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--styleguide'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Style guide → \.design-system-engine-out\/styleguide\/index\.html {2}\(2 components agreed · the engine's template\)/);
  assert.match(r.stdout, /not built yet \(button, field\)/);
  assert.equal(existsSync(join(dir, 'component-prop-result.json')), false, 'the project is left as it was');
  const html = readFileSync(join(dir, '.design-system-engine-out/styleguide/index.html'), 'utf8');
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'every marker filled');
  assert.match(html, /\.chip\.chip--l/, 'the component\'s own stylesheet is on the page');
  assert.match(html, /--chip-background/, 'and the tokens');
  const data = JSON.parse(html.match(/id="sg-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.components.map((c) => c.name).sort(), ['chip', 'tag']);
  const tag = data.components.find((c) => c.name === 'tag');
  assert.equal(tag.markupFrom, 'jsx', 'no page shows it: drawn from its own React source');
  assert.equal(tag.markup, '<span class="tag">New</span>');
  assert.deepEqual(data.components.find((c) => c.name === 'tag').controls.find((c) => c.label === 'Tone').options, [{ label: 'Neutral' }, { label: 'Positive', add: ['tag--positive'], attrs: {} }]);
  assert.deepEqual(data.tokens.radii.map((t) => t.var), ['--radii-button', '--radii-chip', '--radii-field']);
  assert.deepEqual(data.modes, [{ label: 'Color', values: [{ label: 'Light', value: '' }, { label: 'Dark', value: 'dark' }], attr: 'data-theme' }]);
  assert.match(html, /Living style guide/);
});

test('what an option adds comes from the contract\'s selector: a class, an attribute, or a live state', () => {
  assert.deepEqual(optionEffect('.chip', '.chip.chip--l'), { add: ['chip--l'], attrs: {} });
  assert.deepEqual(optionEffect('.button', '.button:disabled'), { add: [], attrs: { disabled: '' } });
  assert.deepEqual(optionEffect('.tab', '.tab[aria-selected="true"]'), { add: [], attrs: { 'aria-selected': 'true' } });
  assert.deepEqual(optionEffect('.button', '.button:hover'), { live: true });
  assert.deepEqual(optionEffect('.button', '.button'), {});
  const v = agreedView({ propsSnap: { badge: { properties: { State: { type: 'VARIANT', defaultValue: 'neutral', variantOptions: ['neutral', 'positive'] } } } },
    rows: [row('badge', 'State', 'state', 'match')], classFor: () => '.badge', propertyMaps: { badge: { State: { neutral: '.badge.none', positive: '.badge.low' } } } });
  assert.deepEqual(v.components[0].controls[0].options, [{ label: 'neutral', add: ['none'], attrs: {} }, { label: 'positive', add: ['low'], attrs: {} }]);
});

test('the mode axes: colour from the config, size from the sizing collection, nesting only where the CSS nests', () => {
  const vars = { modeVariants: { sizing: { modes: [{ name: 'Desktop', snapshotKey: 'desktop' }, { name: 'Phone', snapshotKey: 'phone' }], vars: { 'padding/m': { kind: 'scalar', values: { desktop: '12px', phone: '16px' } } } } } };
  assert.deepEqual(modeAxes({}, vars), [
    { label: 'Color', values: [{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }], attr: 'data-color', scoped: true },
    { label: 'Size', attr: 'data-size', scoped: true, values: [{ label: 'Desktop', value: '' }, { label: 'Phone', value: 'phone' }] },
  ]);
  assert.deepEqual(modeAxes({ figma: { modes: [{ name: 'Day', cssSelector: 'root' }, { name: 'Night', cssSelector: 'class:night' }] } }), [{ label: 'Color', values: [{ label: 'Day', value: '' }, { label: 'Night', value: 'night' }], classes: true }]);
});

test('a component\'s real markup is the first instance in the project\'s own pages, without ids or handlers', () => {
  const page = '<script>var x = "<button class=\'cta\'>";</script><div id="app"><button id="go" class="cta big" onclick="go()"><svg></svg><span>Save</span></button><button class="cta">Two</button></div>';
  assert.equal(instanceMarkup(page, 'cta'), '<button class="cta big"><svg></svg><span>Save</span></button>');
  assert.equal(instanceMarkup('<label class="field">Name <input class="field__input"></label>', 'field'), '<label class="field">Name <input class="field__input"></label>');
  assert.equal(instanceMarkup('<div class="ctaX"></div>', 'cta'), null);
  assert.deepEqual(componentTokens('.cta { padding: var(--pad-m); color: var(--text) } .cta:hover { color: var(--text-hover) } .ctaX { color: var(--no) }', 'cta').map((t) => t.var), ['--pad-m', '--text', '--text-hover']);
});

test('tokens are shown only when equal to Figma in every mode, grouped like the system names them', () => {
  const check = { passVars: [
    { dimension: 'color', token: 'surface/page/color', cssVar: '--surface-page', mode: 'light', value: '#fff' },
    { dimension: 'color', token: 'surface/page/color', cssVar: '--surface-page', mode: 'dark', value: '#000' },
    { dimension: 'color', token: 'text/primary/color', cssVar: '--text-primary', mode: 'light', value: '#111' },
    { dimension: 'sizing', token: 'gap/s', cssVar: '--gap-s', value: '4px' }, { dimension: 'sizing', token: 'radii/card', cssVar: '--radii-card', value: '8px' },
    { dimension: 'sizing', token: 'stroke/default', cssVar: '--stroke-default', value: '1px' },
    { dimension: 'typography', token: 'm/size', cssVar: '--m-size', value: '14px' }], fail: [{ token: 'x' }] };
  const vars = { color: { light: { 'surface/page/color': '#fff', 'text/primary/color': '#111' }, dark: { 'surface/page/color': '#000', 'text/primary/color': '#eee' } } };
  const t = agreedTokens(check, vars);
  assert.deepEqual(t.colors, [{ group: 'surface', items: [{ figma: 'surface/page', var: '--surface-page', values: { light: '#fff', dark: '#000' } }] }], 'text/primary differs in dark: not shown');
  assert.deepEqual([t.spacing.length, t.radii.length, t.sizing.length], [1, 1, 1]);
  assert.deepEqual(t.typography, [{ scale: 'm', size: { var: '--m-size', value: '14px' } }]);
  assert.equal(t.differences, 1);
});

test('the demo design system: its real markup from its page, and props named differently stay out', { timeout: 300000 }, () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'demo-ds'), 'demo-sg-');
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--styleguide'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const data = JSON.parse(readFileSync(join(dir, '.design-system-engine-out/styleguide/index.html'), 'utf8').match(/id="sg-data">([\s\S]*?)<\/script>/)[1]);
  const button = data.components.find((c) => c.name === 'button');
  assert.equal(button.markupFrom, 'page');
  assert.equal(button.markup, '<button class="tp-button" type="button">Save</button>');
  assert.deepEqual(button.controls, [], 'Disabled is "disabled" in the code: a difference to decide, not a control');
  assert.match(data.notAgreed.line, /differences between Figma and the code/);
});

test('in the browser: no script error, a control changes the real component, the tokens behind it are named', { timeout: 300000 }, async (t) => {
  const { findChrome, launchChrome, connectCDP, openPage, waitForTrue, FILE_PAGE_LOADED } = await import('../cdp.mjs');
  const chromePath = findChrome({ playwright: true });
  if (!chromePath || typeof WebSocket === 'undefined') { t.skip('no Chrome'); return; }
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-sg-');
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/chip.css', 'src/components/Chip.jsx']) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8')); }
  spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--styleguide'], { cwd: dir, encoding: 'utf8' });
  const c = await launchChrome(chromePath);
  try {
    const { send, on, close } = await connectCDP(c.wsUrl);
    const errors = []; on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
    const { sessionId } = await openPage(send, `file://${join(dir, '.design-system-engine-out/styleguide/index.html')}`);
    await waitForTrue(send, sessionId, FILE_PAGE_LOADED);
    const run = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
    assert.equal(await run(`document.querySelectorAll('.pg-preview').length`), 1);
    assert.equal(await run(`document.querySelector('#c-chip .pg-preview .chip').getBoundingClientRect().height`), 24);
    await run(`[...document.querySelectorAll('#c-chip .pg-ctl button')].find((b) => b.textContent === 'L').click()`);
    assert.equal(await run(`document.querySelector('#c-chip .pg-preview .chip').classList.contains('chip--l')`), true);
    assert.match(await run(`document.querySelector('#c-chip .pg-tokens').textContent`), /--chip-background/);
    await run(`document.querySelectorAll('#mode-controls button')[1].click()`);
    assert.equal(await run(`document.documentElement.getAttribute('data-theme')`), 'dark');
    assert.deepEqual(errors, []);
    close();
  } finally { c.kill(); }
});

test('"In use" shows the approved pictures of the system\'s own frames', { timeout: 300000 }, () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-sg-');
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify({ ...cfg, frames: [{ name: 'Settings', nodeId: '5:1' }, { name: 'Missing', nodeId: '9:9' }] }));
  mkdirSync(join(dir, '.design-system-engine-refs'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(dir, '.design-system-engine-refs', '5-1.png'), png);
  spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--styleguide'], { cwd: dir, encoding: 'utf8' });
  const data = JSON.parse(readFileSync(join(dir, '.design-system-engine-out/styleguide/index.html'), 'utf8').match(/id="sg-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.screens.map((x) => x.caption), ['Settings']);
  assert.match(data.screens[0].src, /^data:image\/png;base64,iVBOR/);
});
