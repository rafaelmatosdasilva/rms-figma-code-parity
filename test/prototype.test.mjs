// Prototypes: only the design system's own components and options, the engine's neutral layout where the system has
// none, nothing invented, and every gap listed. Screens designed in Figma become starting points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPrototype, pieceCatalog, systemScales, systemFamily, mergeGaps, gapLine } from '../prototype-pieces.mjs';
import { screenToPrototype, layoutHabits, screenCaptureScript } from '../screen-layout.mjs';
import { styleBlocks } from '../styleguide-gen.mjs';
import { fixtureProject } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const TIDEPOOL = join(ENGINE, 'test', 'fixtures', 'tidepool-figma');

const catalog = { components: {
  chip: { props: { Size: { type: 'enum', values: ['M', 'L'] }, Label: { type: 'text' } } },
  button: { props: { Label: { type: 'text' }, Disabled: { type: 'enum', values: ['False', 'True'] } } },
  tag: { props: { Tone: { type: 'enum', values: ['Neutral', 'Positive'] }, Label: { type: 'text' } } },
} };
const view = { components: [
  { name: 'chip', controls: [{ label: 'Size', prop: 'Size' }, { label: 'Label', prop: 'Label' }] },
  { name: 'button', controls: [{ label: 'Label', prop: 'Label' }] },
  { name: 'tag', controls: [{ label: 'Tone', prop: 'Tone' }, { label: 'Label', prop: 'Label' }] },
] };
const scales = { spacing: [{ name: 'gap/s', var: '--gap-s', value: '4px' }, { name: 'padding/m', var: '--padding-m', value: '12px' }], text: [{ name: 'm', size: '14px', weight: '500', lh: '20px' }] };

test('a composition of the system\'s components with the engine\'s layout passes, and the engine\'s layout is a gap', () => {
  const ui = { component: 'Page', props: { padding: 'padding/m', width: 820 }, children: [
    { component: 'Text', props: { text: 'Settings', style: 'm', as: 'h1' } },
    { component: 'Row', props: { gap: 'gap/s', grow: true }, children: [{ component: 'chip', props: { Size: 'L', Label: 'Email' } }, { component: 'button', props: { Label: 'Save' } }] },
  ] };
  const r = checkPrototype(ui, { catalog, view, scales, name: 'settings' });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.gaps.filter((g) => g.kind === 'layout').map((g) => g.need).sort(), ['a Page layout component', 'a Row layout component']);
});

test('an invented component, a wrong option, a typed size or a style the system lacks is an error, never drawn', () => {
  const ui = { component: 'Page', props: { padding: '16px' }, children: [
    { component: 'Toggle' }, { component: 'chip', props: { Size: 'large' } }, { component: 'Text', props: { text: 'x', style: 'xl' } },
  ] };
  const r = checkPrototype(ui, { catalog, view, scales });
  assert.equal(r.ok, false);
  const m = r.findings.filter((f) => f.level === 'error').map((f) => f.message).join('\n');
  assert.match(m, /"Toggle" is not in the catalog.*write a Missing box with the need instead/);
  assert.match(m, /chip\.Size = "large" is not one of M, L/);
  assert.match(m, /Page\.padding = "16px" is not one of none, gap\/s, padding\/m/);
  assert.match(m, /Text\.style = "xl"/);
});

test('a need nothing fits is a Missing box, a stand-in is listed, and both go on the gaps list', () => {
  const ui = { component: 'Stack', children: [
    { component: 'Missing', props: { need: 'a toggle switch', kind: 'component', closest: 'chip' } },
    { component: 'tag', props: { Tone: 'Positive', Label: 'Saved', standInFor: 'a success message' } },
  ] };
  const r = checkPrototype(ui, { catalog, view, scales, name: 'p1' });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(r.gaps.some((g) => g.need === 'a toggle switch' && g.closest === 'chip'));
  assert.ok(r.gaps.some((g) => g.need === 'a success message' && g.used === 'tag'));
  const missingNeed = checkPrototype({ component: 'Missing' }, { catalog, view, scales });
  assert.equal(missingNeed.ok, false, 'a Missing box must say what it stands for');
});

test('a system component with the same name as an engine piece always wins', () => {
  const pieces = pieceCatalog(scales, ['Stack', 'button']);
  assert.ok(!pieces.Stack, 'the system has its own Stack');
  assert.ok(pieces.Row && pieces.Page);
});

test('a prop Figma and the code do not agree on is drawn with its default, and said', () => {
  const r = checkPrototype({ component: 'button', props: { Label: 'Go', Disabled: 'True' } }, { catalog, view, scales });
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((f) => f.level === 'warning' && /button\.Disabled has no part of that name in the code yet: drawn without it/.test(f.message)));
});

test('gaps from every prototype merge by need, the most needed first', () => {
  const merged = mergeGaps({ a: [{ need: 'a toggle', kind: 'component' }, { need: 'a Row layout component', kind: 'layout' }], b: [{ need: 'A toggle', kind: 'component' }] });
  assert.equal(merged[0].need, 'a toggle');
  assert.deepEqual(merged[0].prototypes, ['a', 'b']);
  assert.match(gapLine(merged[0]), /needed in 2 prototypes: a, b/);
});

test('the page takes the system\'s own surface, text colour and font family, never a component\'s', () => {
  const v = { components: [{ name: 'buttonSecondary' }], tokens: { colors: [{ group: 'x', items: [
    { figma: 'buttonSecondary/background/default', var: '--buttonSecondary-background' },
    { figma: 'semantic/surface/elevationLow', var: '--semantic-surface-elevationLow' },
    { figma: 'semantic/content/primary', var: '--semantic-content-primary' },
  ] }] } };
  const sc = systemScales(v, {}, '.a { font: 500 12px/16px Inter, sans-serif } .b { font-family: Inter, sans-serif }');
  assert.equal(sc.surface, '--semantic-surface-elevationLow');
  assert.equal(sc.ink, '--semantic-content-primary');
  assert.equal(systemFamily('.a{font: 500 12px/16px Inter, sans-serif} .b{font: 500 14px/20px Inter, sans-serif} .c{font-family: Georgia}'), 'Inter, sans-serif');
});

test('an app page used as a stylesheet gives only its <style> blocks', () => {
  assert.equal(styleBlocks('<html><style>.a{color:red}</style><body><div>Loading…</div><script>x()</script><style>.b{}</style></body></html>'), '.a{color:red}\n.b{}');
});

// ── Screens to starting points ────────────────────────────────────────────────────────────────────────────────────
const capture = JSON.parse(readFileSync(join(TIDEPOOL, 'src', 'figma', 'figma-screen-layout.snapshot.json'), 'utf8'));
const tpScales = { spacing: [{ name: 'gap/s', var: '--gap-s', value: '4px' }, { name: 'padding/s', var: '--padding-s', value: '8px' }, { name: 'padding/m', var: '--padding-m', value: '12px' }], text: [{ name: 'm', size: '14px', weight: '500', lh: '20px' }, { name: 's', size: '12px', weight: '500', lh: '16px' }] };
const tpCatalog = { components: {
  field: { props: {} }, button: { props: { Label: { type: 'text' }, Disabled: { type: 'enum', values: ['False', 'True'] } } },
  chip: { props: { Size: { type: 'enum', values: ['M', 'L'] }, Icon: { type: 'enum', values: ['False', 'True'] }, Label: { type: 'text' } } },
  tag: { props: { Tone: { type: 'enum', values: ['Neutral', 'Positive'] }, Label: { type: 'text' } } },
} };

test('a designed screen becomes the same arrangement in the system\'s components and the engine\'s pieces', () => {
  const { prototype, gaps } = screenToPrototype(capture.screens[0], { catalog: tpCatalog, scales: tpScales });
  assert.equal(prototype.component, 'Page');
  assert.deepEqual(prototype.props, { gap: 'padding/m', padding: 'padding/m', width: '360' });
  assert.deepEqual(prototype.children.map((c) => c.component), ['Text', 'field', 'Row', 'button']);
  assert.equal(prototype.children[0].props.style, 'm');
  const row = prototype.children[2];
  assert.deepEqual(row.props, { gap: 'padding/s' });
  assert.deepEqual(row.children.map((c) => [c.component, c.props.Size ?? c.props.Tone]), [['chip', 'M'], ['chip', 'L'], ['tag', 'Positive']]);
  assert.deepEqual(prototype.children[3].props, { Label: 'Save', Disabled: 'False' }, 'State is an interaction state, not a prop the catalog lists');
  assert.deepEqual(gaps, []);
  assert.equal(checkPrototype(prototype, { catalog: tpCatalog, view: { components: [] }, scales: tpScales }).ok, true);
});

test('what a screen uses that the system does not own becomes a gap: a local component, a container look, a typed number', () => {
  const screen = { name: 'Home', tree: { kind: 'frame', name: 'Home', w: 800, layout: 'VERTICAL', children: [
    { kind: 'instance', name: 'Shell', component: '.Shell', w: 800, h: 600, layout: 'HORIZONTAL', gap: 13, children: [
      { kind: 'frame', name: 'Card', type: 'FRAME', layout: 'VERTICAL', fill: { var: 'surface/raised' }, radius: 8, fillW: true, children: [{ kind: 'instance', name: 'b', component: 'button', props: { Label: 'Go' } }] },
      { kind: 'instance', name: 'icon', component: 'Icon-search', props: {} },
    ] },
  ] } };
  const { prototype, gaps } = screenToPrototype(screen, { catalog: tpCatalog, scales: tpScales });
  const needs = gaps.map((g) => `${g.kind}: ${g.need}`).join('\n');
  assert.match(needs, /pattern: Shell as a system template/);
  assert.match(needs, /pattern: a container component like "Card" \(fill surface\/raised, corner 8px\)/);
  assert.match(needs, /token: a spacing token for 13px/);
  const shell = prototype.children[0];
  assert.equal(shell.component, 'Row');
  assert.equal(shell.children[0].props.grow, true, 'a Fill child grows along its parent');
  assert.equal(shell.children[1].component, 'Missing');
  assert.equal(shell.children[1].props.kind, 'icon');
});

test('a system component\'s slots keep what the screen put in them', () => {
  const cat = { components: { ...tpCatalog.components, panel: { props: {} } } };
  const screen = { name: 'S', tree: { kind: 'frame', name: 'S', layout: 'HORIZONTAL', children: [
    { kind: 'instance', name: 'panel', component: 'panel', layout: 'VERTICAL', children: [
      { kind: 'frame', name: 'Head', type: 'SLOT', layout: 'VERTICAL', gap: 4, gapVar: 'gap/s', children: [{ kind: 'instance', component: 'tag', props: { Label: 'New' } }] },
    ] },
  ] } };
  const { prototype } = screenToPrototype(screen, { catalog: cat, scales: tpScales });
  const panel = prototype.children[0];
  assert.equal(panel.component, 'panel');
  assert.equal(panel.children[0].component, 'Stack');
  assert.equal(panel.children[0].props.gap, 'gap/s');
  assert.equal(panel.children[0].children[0].component, 'tag');
});

test('across screens: the spacing habits and the structures that repeat', () => {
  const a = { name: 'A', prototype: { component: 'Page', props: { padding: 'padding/m' }, children: [{ component: 'Row', props: { gap: 'gap/s' }, children: [{ component: 'button' }] }] } };
  const b = { name: 'B', prototype: { component: 'Page', props: { padding: 'padding/m' }, children: [{ component: 'Row', props: { gap: 'gap/s' }, children: [{ component: 'button' }] }] } };
  const h = layoutHabits([a, b]);
  assert.deepEqual(h.pagePadding, ['padding/m']);
  assert.deepEqual(h.gaps, [{ name: 'gap/s', n: 2 }]);
  assert.deepEqual(h.repeated, [{ structure: 'Row(button)', screens: ['A', 'B'] }]);
});

test('the screen capture only reads: no create, set or remove call in it', () => {
  const js = screenCaptureScript(['1:2']);
  assert.match(js, /const SCREEN_IDS = \["1:2"\]/);
  assert.doesNotMatch(js, /\.create[A-Z]|\.remove\(|setBoundVariable|\b(n|node)\.set\(|appendChild|\.resize\(|\.characters *=[^=]|\.name *=[^=]|\.fills *=[^=]|setCurrentPage/);
});

// ── End to end on a built Tidepool ─────────────────────────────────────────────────────────────────────────────────
function builtTidepool(prefix) {
  const dir = fixtureProject(TIDEPOOL, prefix);
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/button.css', 'src/components/Button.jsx', 'src/components/chip.css', 'src/components/Chip.jsx', 'src/components/field.css', 'src/components/Field.jsx', 'src/components/tag.css', 'src/components/Tag.jsx']) {
    mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8'));
  }
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 300000 });

test('--prototype draws a valid composition with the components\' own markup and lists its gaps; an invalid one is not drawn', { timeout: 600000 }, () => {
  const dir = builtTidepool('tp-proto-');
  mkdirSync(join(dir, 'prototypes'), { recursive: true });
  writeFileSync(join(dir, 'prototypes', 'notify.json'), JSON.stringify({ component: 'Page', props: { padding: 'padding/m' }, children: [
    { component: 'chip', props: { Label: 'Email', Size: 'L' } },
    { component: 'tag', props: { Label: 'Saved', Tone: 'Positive', standInFor: 'a message confirming the save' } },
    { component: 'Missing', props: { need: 'a toggle switch' } },
  ] }));
  let r = run(dir, '--prototype', 'prototypes/notify.json');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /✅ drawn: \.design-system-engine-out\/prototypes\/notify\.html/);
  assert.match(r.stdout, /component: a message confirming the save; the prototype uses tag meanwhile/);
  assert.match(r.stdout, /component: a toggle switch/);
  const page = readFileSync(join(dir, '.design-system-engine-out', 'prototypes', 'notify.html'), 'utf8');
  assert.match(page, /"markup":"\\u003cbutton class=\\"chip\\" type=\\"button\\">/, 'the chip is drawn from its own JSX');
  assert.match(page, /\.chip\.chip--l|\.chip--l/, 'its CSS is on the page');
  assert.match(page, /"add":\["chip--l"\]/, 'Size=L applies the class the code has');
  const gaps = JSON.parse(readFileSync(join(dir, '.design-system-engine-out', 'prototypes', 'gaps.json'), 'utf8'));
  assert.ok(gaps.merged.some((g) => g.need === 'a toggle switch'));

  writeFileSync(join(dir, 'prototypes', 'bad.json'), JSON.stringify({ component: 'Page', children: [{ component: 'Toggle' }] }));
  r = run(dir, '--prototype', 'prototypes/bad.json');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ 1 error\(s\): nothing drawn/);
  assert.ok(!existsSync(join(dir, '.design-system-engine-out', 'prototypes', 'bad.html')));
});

test('--prototype --from-screens turns each designed screen into a drawn starting point', { timeout: 600000 }, () => {
  const dir = builtTidepool('tp-screens-');
  const r = run(dir, '--prototype', '--from-screens', 'src/figma/figma-screen-layout.snapshot.json');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /✅ Settings → prototypes\/settings\.json · drawn/);
  assert.match(r.stdout, /page padding: padding\/m/);
  const start = JSON.parse(readFileSync(join(dir, 'prototypes', 'settings.json'), 'utf8'));
  assert.deepEqual(start.prototype.children.map((c) => c.component), ['Text', 'field', 'Row', 'button']);
  // A designer's edit is never overwritten without --force.
  writeFileSync(join(dir, 'prototypes', 'settings.json'), JSON.stringify({ prototype: { component: 'Page', children: [] } }));
  const again = run(dir, '--prototype', '--from-screens', 'src/figma/figma-screen-layout.snapshot.json');
  assert.match(again.stdout, /kept as it was; --force replaces it/);
});

// ── Asking for a prototype in words ──────────────────────────────────────────────────────────────────────────────
test('a prototype request routes to the prototype recipe and its catalog, in English and Portuguese', async () => {
  const { route } = await import('../route.mjs');
  const s = { components: ['button', 'chip', 'field', 'tag'], build: true };
  for (const p of ['prototype a notification settings page with our components', 'mock up a checkout screen', 'faz um protótipo do ecrã de perfil', 'create a wireframe for the login']) {
    const r = route(p, s);
    assert.equal(r.recipe, 'prototype', p);
    assert.deepEqual(r.run, ['rms-design-system-engine --prototype --catalog'], p);
  }
  assert.equal(route('how do I prototype with the engine?', s).run.length, 0, 'a how-to question runs nothing');
  assert.deepEqual(route('are our prototype pages consistent?', s).run, ['rms-design-system-engine --prototype --consistency']);
  assert.deepEqual(route('prototype a settings page that matches the others', s).run, ['rms-design-system-engine --prototype --catalog'], 'making a page reads the catalog, which holds the product\'s arrangement');
  assert.notEqual(route('change the prototype frame in figma to 8px', s).recipe, 'prototype');
});

test('while prototyping, an edit outside prototypes/ asks first; the composition itself passes', async () => {
  const { judge } = await import('../guard.mjs');
  const ask = (file) => judge({ tool_name: 'Write', tool_input: { file_path: file } }, { userText: 'prototype a settings page with our components' });
  assert.equal(ask('prototypes/settings.json'), null);
  assert.equal(ask('src/components/Toggle.jsx')?.decision, 'ask');
  assert.match(ask('src/styles/tokens.css').reason, /made only of the design system's components/);
});

test('the reply owes the gaps of the prototype just drawn, once', async () => {
  const { prototypeGapsOwed } = await import('../guard.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'proto-owed-'));
  mkdirSync(join(root, '.design-system-engine-out', 'prototypes'), { recursive: true });
  const write = () => writeFileSync(join(root, '.design-system-engine-out', 'prototypes', 'last.json'), JSON.stringify({ at: new Date().toISOString(), pending: true, gaps: [{ need: 'a toggle switch for each channel', kind: 'component', line: 'component: a toggle switch for each channel' }, { need: 'a Row layout component', kind: 'layout', line: 'layout: a Row layout component' }] }));
  write();
  const owed = prototypeGapsOwed(root, 'Here is your prototype. The system has no toggle switch for each channel.');
  assert.deepEqual(owed.map((g) => g.need), ['a Row layout component']);
  assert.deepEqual(prototypeGapsOwed(root, ''), [], 'checked once only');
  write();
  assert.deepEqual(prototypeGapsOwed(root, 'It needs a toggle switch per channel and a row layout component.'), []);
});

test('a page that differs from the product\'s other pages owes that too, named as a difference', async () => {
  const { stopCheck } = await import('../guard.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'proto-differs-'));
  mkdirSync(join(root, '.design-system-engine-out', 'prototypes'), { recursive: true });
  writeFileSync(join(root, '.design-system-engine-out', 'prototypes', 'last.json'), JSON.stringify({ at: new Date().toISOString(), pending: true, gaps: [{ need: 'page padding padding/m', kind: 'consistency', line: "page padding: padding/s here, padding/m on the product's other pages (settings)" }] }));
  const reason = stopCheck({ last_assistant_message: 'The prototype is drawn.' }, { root, cfg: {} });
  assert.match(reason, /where the prototype differs from the product's other pages/);
  assert.match(reason, /- page padding: padding\/s here, padding\/m on the product's other pages \(settings\)/);
});

test('--prototype --catalog lists the system\'s components, the engine\'s pieces with their tokens, and the format', { timeout: 600000 }, () => {
  const dir = builtTidepool('tp-catalog-');
  const r = run(dir, '--prototype', '--catalog');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /chip\s+Size=M\|L/);
  assert.match(r.stdout, /Stack\s+gap=none\|gap\/s\|padding\/xs\|padding\/s\|padding\/m/);
  assert.match(r.stdout, /Text\s+text=<text>\s+style=m\|s/);
  assert.match(r.stdout, /NEXT: write prototypes\/<name>\.json with only the parts above/);
});
