// Step 6 of the code capture: component APIs, icons, markup and nesting. Known-answer fixtures
// made up for these tests. The TypeScript case runs when a TypeScript compiler can be resolved
// (TS_FOR_TESTS=<dir with node_modules/typescript>, or one installed next to the engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { resolveComponentFile, textComponentApi, componentSourceFiles, textReader, usedComponents, norm } from '../component-source.mjs';
import { cemComponents, docgenComponents, storybookFiles, codeConnectPairs, mergeApiReadings, createApiReader, loadTypeScript, typescriptComponentApi } from '../component-api.mjs';
import { symbolsIn, iconRefs, iconUsage } from '../icon-source.mjs';
import { fingerprint, markupClassSet } from '../markup-source.mjs';
import { mergeNesting, captureIcons, captureMarkup, captureApis, apiReaderFor, sourceNesting } from '../structure-capture.mjs';
import { captureCode } from '../code-capture.mjs';
import { findChrome } from '../cdp.mjs';

const HAS_CHROME = !!findChrome({ playwright: true }) && typeof WebSocket !== 'undefined';
const TS = loadTypeScript(process.env.TS_FOR_TESTS ?? process.cwd());

// ── Component source ──────────────────────────────────────────────────────────
test('source: the file finder prefers componentFiles, then a declared file, then selector, name, basename', () => {
  const dir = makeFixture({
    'src/Chip.tsx': 'export function Chip({ label, tone = "neutral" }: ChipProps) { return <span className="chip">{label}</span>; }\n',
    'src/Other.tsx': 'export function Other() { return null; }\n',
    'src/Chip.figma.tsx': 'figma.connect(Chip, "https://figma.com/file/x?node-id=1-2", {})\n',
  });
  const files = componentSourceFiles(dir, {});
  assert.ok(!files.some((f) => f.endsWith('.figma.tsx')), 'Code Connect files are not components');
  const read = textReader();
  assert.equal(resolveComponentFile('Chip', { ROOT: dir, files, read, classFor: () => '.chip' }).how, 'selector');
  assert.equal(resolveComponentFile('Chip', { ROOT: dir, cfg: { componentFiles: { Chip: 'src/Other.tsx' } }, files, read }).file, join(dir, 'src/Other.tsx'));
  assert.equal(resolveComponentFile('Chip', { ROOT: dir, files, read, declared: { Chip: { file: join(dir, 'src/Other.tsx'), how: 'storybook' } } }).how, 'storybook');
  assert.equal(resolveComponentFile('Nope', { ROOT: dir, files, read }).how, 'not found');
});

test('source: the text reading keeps props, defaults, union options and slots', () => {
  const text = `type ChipProps = { size?: 'sm' | 'md'; label: string; icon?: React.ReactNode };
export function Chip({ size = 'md', label, icon }: ChipProps) { return children; }`;
  const api = textComponentApi('Chip.tsx', text);
  assert.deepEqual(Object.keys(api.props).sort(), ['icon', 'label', 'size']);
  assert.equal(api.props.size.default, 'md');
  assert.deepEqual(api.props.size.options, ['sm', 'md']);
  assert.deepEqual(api.slots.named, ['icon']);
  assert.equal(api.slots.default, true);
});

test('source: nesting by selector or by tag / import', () => {
  const uni = [{ name: 'Badge', selNorm: norm('.badge') }, { name: 'Icon', selNorm: norm('.icon') }, { name: 'Avatar', selNorm: norm('.avatar') }];
  const used = usedComponents('import { Icon } from "./Icon";\n<div class="badge"><Icon /></div>', uni);
  assert.deepEqual([...used].sort(), ['Badge', 'Icon']);
});

// ── Standard files ────────────────────────────────────────────────────────────
test('api: Custom Elements Manifest attributes, fields, defaults, unions and slots', () => {
  const [c] = cemComponents({ modules: [{ path: 'src/ds-chip.ts', declarations: [{
    kind: 'class', name: 'DsChip', tagName: 'ds-chip', customElement: true,
    attributes: [{ name: 'size', fieldName: 'size', type: { text: "'sm' | 'md'" }, default: "'md'" }],
    members: [{ kind: 'field', name: 'disabled', type: { text: 'boolean' }, default: 'false' }, { kind: 'field', name: '_x', privacy: 'private' }],
    slots: [{ name: '' }, { name: 'icon' }],
  }] }] }, '/p');
  assert.deepEqual(c.names, ['DsChip', 'ds-chip']);
  assert.equal(c.file, '/p/src/ds-chip.ts');
  assert.deepEqual(c.props.size, { options: ['sm', 'md'], default: 'md' });
  assert.deepEqual(c.props.disabled, { type: 'boolean', default: 'false' });
  assert.ok(!c.props._x);
  assert.deepEqual(c.slots, { named: ['icon'], default: true });
});

test('api: react-docgen (CLI shape) and vue-docgen-api output', () => {
  const [r] = docgenComponents({ 'src/Chip.tsx': [{ displayName: 'Chip', props: {
    size: { tsType: { name: 'union', elements: [{ name: 'literal', value: "'sm'" }, { name: 'literal', value: "'md'" }] }, defaultValue: { value: "'md'" } },
    onClick: { tsType: { name: 'signature' } },
  } }] }, '/p');
  assert.equal(r.file, '/p/src/Chip.tsx');
  assert.deepEqual(r.props.size, { options: ['sm', 'md'], default: 'md' });
  const [v] = docgenComponents([{ displayName: 'VChip', props: [{ name: 'tone', type: { name: 'string' }, values: ['info', 'warn'], defaultValue: { value: '"info"' } }], slots: [{ name: 'default' }, { name: 'icon' }] }]);
  assert.deepEqual(v.props.tone, { options: ['info', 'warn'], default: 'info' });
  assert.deepEqual(v.slots, { named: ['icon'], default: true });
});

test('api: Storybook index pairs a component with its file (v7 index.json and v6 stories.json)', () => {
  assert.deepEqual(storybookFiles({ v: 4, entries: { 'c--a': { type: 'story', title: 'Components/Chip', componentPath: './src/Chip.tsx' } } }, '/p'), { Chip: '/p/src/Chip.tsx' });
  assert.deepEqual(storybookFiles({ stories: { a: { kind: 'Chip', title: 'Chip' } } }, '/p'), {});   // no componentPath → no claim
});

test('api: Code Connect gives the component file and the Figma → code prop names (pairing only)', () => {
  const dir = makeFixture({ 'src/Chip.tsx': 'export function Chip() {}' });
  const text = `import { Chip } from './Chip';
figma.connect(Chip, 'https://figma.com/design/k?node-id=12-34', { props: { tone: figma.enum('Tone', { Info: 'info' }), label: figma.string('Label') } });`;
  const [p] = codeConnectPairs(text, join(dir, 'src/Chip.figma.tsx'));
  assert.equal(p.nodeId, '12:34');
  assert.equal(p.file, join(dir, 'src/Chip.tsx'));
  assert.deepEqual(p.propMap, { Tone: 'tone', Label: 'label' });
});

test('api: merge marks agreement verified, one source single-source, a disagreement uncertain', () => {
  const m = mergeApiReadings([
    { source: 'custom-elements', props: { size: { options: ['sm', 'md'], default: 'md' }, tone: { default: 'info' } } },
    { source: 'text', props: { size: { options: ['md', 'sm'] }, tone: { default: 'warn' }, extra: {} }, slots: { named: ['icon'], default: false } },
  ]);
  assert.equal(m.props.size.confidence, 'verified');
  assert.equal(m.props.tone.confidence, 'uncertain');
  assert.deepEqual(m.props.tone.readings, { 'custom-elements': { default: 'info' }, text: { default: 'warn' } });
  assert.equal(m.props.extra.confidence, 'single-source');
  assert.deepEqual(m.slots.named, ['icon']);
});

test('api: the reader joins Code Connect by Figma node id and falls back to text patterns', () => {
  const dir = makeFixture({
    'src/Pill.tsx': "type PillProps = { tone?: 'a' | 'b' };\nexport function Pill({ tone = 'a' }: PillProps) { return null; }\n",
    'src/Pill.figma.tsx': "import { Pill } from './Pill';\nfigma.connect(Pill, 'https://figma.com/design/k?node-id=5-6', { props: { tone: figma.enum('Tone', {}) } });\n",
  });
  const r = createApiReader(dir, {}, { classFor: () => '.pill', nodeIds: { 'Status pill': '5:6' } });
  const a = r.apiFor('Status pill');
  assert.equal(a.how, 'code connect');
  assert.deepEqual(a.codeConnect, { Tone: 'tone' });
  assert.deepEqual(a.props.tone, { readBy: ['text'], default: 'a', options: ['a', 'b'], confidence: 'single-source' });
});

test('api: TypeScript reads the Props type by syntax (unions, booleans, defaults, Vue defineProps)', { skip: TS ? false : 'no TypeScript compiler available' }, () => {
  const tsx = `interface ChipProps { size?: 'sm' | 'md' | 'lg'; disabled?: boolean; label: string }
export const Chip = ({ size = 'md', disabled = false }: ChipProps) => null;`;
  const a = typescriptComponentApi(TS, 'Chip.tsx', tsx, 'Chip');
  assert.deepEqual(a.props.size, { options: ['sm', 'md', 'lg'], default: 'md' });
  assert.deepEqual(a.props.disabled, { type: 'boolean', default: 'false' });
  assert.deepEqual(a.props.label, {});
  const vue = `<script setup lang="ts">
const props = withDefaults(defineProps<{ tone?: 'info' | 'warn'; dense?: boolean }>(), { tone: 'info' });
</script>`;
  const v = typescriptComponentApi(TS, 'Tag.vue', vue, 'Tag');
  assert.deepEqual(v.props.tone, { options: ['info', 'warn'], default: 'info' });
  assert.deepEqual(v.props.dense, { type: 'boolean' });
  assert.equal(typescriptComponentApi(TS, 'X.tsx', 'export const a = 1;', 'X'), null);
});

test('api: frameworkComponents false reads no props and says why', () => {
  const dir = makeFixture({ 'src/a.tsx': 'export function A({ x }) {}' });
  assert.equal(apiReaderFor(dir, { frameworkComponents: false }), null);
  assert.match(captureApis(dir, [{ name: 'A' }], null).note, /frameworkComponents is false/);
});

// ── Icons ─────────────────────────────────────────────────────────────────────
test('icons: symbols with line, viewBox, paths and flags; references with file:line; dynamic prefixes', () => {
  const html = '<svg>\n<symbol id="icon-a" viewBox="0 0 16 16" fill="none"><path d="M1" stroke="none"/></symbol>\n<symbol id="icon-b" viewBox="0 0 24 24"><g transform="rotate(45)"><path d="M2"/><path d="M3"/></g></symbol>\n</svg>\n<use href="#icon-a"/>\n';
  const [a, b] = symbolsIn(html);
  assert.deepEqual({ id: a.id, line: a.line, viewBox: a.viewBox, paths: a.paths, fillNone: a.fillNone, strokeNone: a.strokeNone }, { id: 'icon-a', line: 2, viewBox: '0 0 16 16', paths: ['M1'], fillNone: true, strokeNone: true });
  assert.deepEqual(b.transforms, ['rotate(45)']);
  const dir = makeFixture({ 'app.html': html, 'app.js': "const i = '#icon-arrow-' + dir;\n" });
  assert.deepEqual(iconRefs(dir, ['app.html'], ['icon-a', 'icon-b']), { 'icon-a': ['app.html:5'] });
  assert.deepEqual(iconUsage(dir, ['app.html', 'app.js']).dynamicPrefixes, ['icon-arrow-']);
  const icons = captureIcons(dir, { paths: { pluginCSS: ['app.html'] } });
  assert.deepEqual(icons['icon-b'].usedAt, []);
  assert.deepEqual(icons['icon-a'].definedAt, ['app.html:2']);
});

// ── Markup ────────────────────────────────────────────────────────────────────
test('markup: fingerprint ids, DS classes, icon context and button content (scripts ignored)', () => {
  const html = '<div id="bar" class="toolbar"><button id="go" class="btn x"><svg><use href="#icon-go"/></svg><span class="lbl">Go</span></button></div><script>const s = "<div id=\'fake\'>";</script>';
  const fp = fingerprint(html, new Set(['btn', 'toolbar']));
  assert.deepEqual(fp.ids, ['bar', 'go']);
  assert.deepEqual(fp.components, [{ id: 'bar', classes: ['toolbar'] }, { id: 'go', classes: ['btn'] }]);
  assert.deepEqual(fp.icons, [{ context: '#go', icon: 'icon-go' }]);
  assert.deepEqual(fp.buttonContent, [{ id: 'go', svg: true, spans: ['lbl'], text: 'Go' }]);
});

test('markup: DS classes come from config, else from the saved snapshot, else none', () => {
  const stored = { _updated: 'x', app: { components: [{ id: null, classes: ['btn'] }, { id: 'a', classes: ['chip', 'btn'] }] } };
  assert.deepEqual(markupClassSet({ htmlStructureClasses: ['z'] }, stored), { classes: new Set(['z']), from: 'config' });
  assert.deepEqual(markupClassSet({}, stored), { classes: new Set(['btn', 'chip']), from: 'snapshot' });
  assert.deepEqual(markupClassSet({}, {}), { classes: new Set(), from: 'none' });
  const dir = makeFixture({ 'src/theme.css': ':root{}', 'src/html-structure.snapshot.json': JSON.stringify(stored), 'a.html': '<button class="chip">x</button>' });
  const m = captureMarkup(dir, { paths: { themeCSS: 'src/theme.css', plugins: ['a'], pluginCSS: ['a.html'] } });
  assert.equal(m._classes.from, 'snapshot');
  assert.deepEqual(m.a.components, [{ id: null, classes: ['chip'] }]);
});

// ── Nesting ───────────────────────────────────────────────────────────────────
test('nesting: rendered and source readings merge with confidence', () => {
  const n = mergeNesting(
    { p1: { Card: { instances: 2, contains: { Badge: 2 } } }, p2: { Card: { instances: 1, contains: { Badge: 1, Icon: 1 } } } },
    { Card: new Set(['Badge', 'Avatar']) },
  );
  assert.equal(n.Card.instancesSeen, 3);
  assert.deepEqual(n.Card.contains.Badge, { renderedIn: ['p1', 'p2'], instances: 3, inSource: true, confidence: 'verified', readBy: 'rendered + source' });
  assert.equal(n.Card.contains.Icon.readBy, 'rendered');
  assert.equal(n.Card.contains.Avatar.readBy, 'source');
});

test('nesting: source reading uses the component file the API reader found', () => {
  const dir = makeFixture({ 'src/Card.tsx': "import { Badge } from './Badge';\nexport function Card() { return <div className=\"card\"><Badge /></div>; }\n", 'src/Badge.tsx': 'export function Badge() { return <i className="badge" />; }\n' });
  const reader = apiReaderFor(dir, {}, { classFor: (n) => '.' + n.toLowerCase() });
  const s = sourceNesting([{ name: 'Card' }, { name: 'Badge' }], reader, (n) => '.' + n.toLowerCase());
  assert.deepEqual([...s.Card], ['Badge']);
  assert.deepEqual([...s.Badge], []);
});

test('capture: nesting built by JavaScript is seen in the rendered page', { skip: HAS_CHROME ? false : 'no Chrome available' }, async () => {
  const dir = makeFixture({
    'ds-config.json': '{}',
    'src/theme.css': ':root { --gap: 4px; }\n.card { gap: var(--gap); }\n.badge { color: red; }\n',
    'apps/a/ui.src.html': '<div class="card" id="c"></div>',
    'apps/a/ui.html': '<!doctype html><link rel="stylesheet" href="../../src/theme.css"><div class="card" id="c"></div><script>document.getElementById("c").innerHTML = \'<span class="badge">x</span>\';</script>',
  });
  const cfg = { paths: { themeCSS: 'src/theme.css', plugins: ['a'], pluginCSS: ['apps/a/ui.src.html'] }, componentSelectors: { Card: '.card', Badge: '.badge' }, frameworkComponents: false };
  const { snapshot } = await captureCode(dir, cfg, { force: true });
  assert.deepEqual(snapshot.nesting.Card.contains.Badge.renderedIn, ['a']);
  assert.equal(snapshot._coverage.nesting.rendered, true);
  assert.match(snapshot._coverage.api.note, /frameworkComponents is false/);
});

test('styleguide: the capture builds a private copy from the template, or names the template it found', async () => {
  const { styleguidePlan } = await import('../code-capture.mjs');
  const { generateStyleguide } = await import('../styleguide-gen.mjs');
  const dir = makeFixture({ 'apps/guide/gallery.template.html': '<html><head></head><body><style>/*{{THEME_CSS}}*/</style></body></html>', 'src/theme.css': ':root { --a: 1px; }' });
  const wrong = styleguidePlan(dir, { styleguide: { template: 'apps/styleguide/styleguide.template.html' } });
  assert.equal(wrong.generate, false);
  assert.match(wrong.note, /not found at apps\/styleguide\/styleguide\.template\.html \(found apps\/guide\/gallery\.template\.html/);
  const cfg = { paths: { themeCSS: 'src/theme.css' }, styleguide: { template: 'apps/guide/gallery.template.html', out: 'apps/guide/index.html' } };
  const plan = styleguidePlan(dir, cfg);
  assert.deepEqual(plan, { generate: true, template: 'apps/guide/gallery.template.html', out: '.parity-out/styleguide.html' });
  await generateStyleguide(dir, cfg, { out: plan.out });
  const { readFileSync, existsSync } = await import('node:fs');
  const html = readFileSync(join(dir, plan.out), 'utf8');
  assert.match(html, /<head><base href="file:\/\/.*\/apps\/guide\/">/);
  assert.match(html, /--a: 1px/);
  assert.equal(existsSync(join(dir, 'apps/guide/index.html')), false, 'the project page is never written');
});
