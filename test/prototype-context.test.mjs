// What the team wrote about its system, and its product's page decisions, put in front of a prototype.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contextFrom, purposeLines, ruleLines, usesAgainstPurpose, sectionsOf, limitsFrom, requestFocus, focusLines, breakpointsOf, neverOf, ruledOut } from '../prototype-context.mjs';
import { pageFacts, deriveConventions, consistencyFindings, consistencyLine } from '../product-conventions.mjs';
import { checkPrototype } from '../prototype-pieces.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');

const catalog = { components: {
  button: { description: 'The main action on a screen.', props: { Label: { type: 'text' } } },
  field: { description: 'A one-line text input.', props: {}, whenNotToUse: 'an on/off choice', useInstead: ['chip'] },
  badge: { description: 'Old status label.', props: {}, status: 'deprecated', useInstead: ['tag'] },
} };
const intent = {
  components: {
    button: { design: { description: 'x', annotations: [{ label: 'Role: button' }, 'Keep the label to one verb'] }, code: { note: null, cssComment: 'Primary only' }, guidelines: 'One per screen.' },
    field: { design: { annotations: [] }, code: {}, guidelines: 'Only for typing text.' },
  },
  guidelines: { general: 'Every page opens with one heading.', _sources: ['guidelines.md'] },
  templates: { authored: 'Settings pages: heading, sections, actions at the end.' },
  pages: { authored: '' },
};

test('the context gathers each component\'s purpose, role, notes, when not to use it and its guidelines, and the team\'s rules', () => {
  const ctx = contextFrom(catalog, intent);
  assert.equal(ctx.components.button.purpose, 'The main action on a screen.', 'the catalog\'s description first');
  assert.equal(ctx.components.button.role, 'button');
  assert.deepEqual(ctx.components.button.notes, ['Keep the label to one verb', 'Primary only']);
  assert.equal(ctx.components.button.guidelines, 'One per screen.');
  assert.equal(ctx.components.field.notFor, 'an on/off choice');
  assert.deepEqual(ctx.components.field.useInstead, ['chip']);
  assert.equal(ctx.components.badge.status, 'deprecated');
  assert.deepEqual(ctx.rules.map((r) => r.title), ['guidelines', 'templates (design intent)'], 'an empty layer says nothing');
  const lines = purposeLines(ctx, ['button', 'field', 'badge']).join('\n');
  assert.match(lines, /button {2}The main action on a screen\. Role button\./);
  assert.match(lines, /not for an on\/off choice; use chip/);
  assert.match(lines, /guidelines Only for typing text\./);
  assert.match(lines, /badge {3}Old status label\. \[deprecated: use tag\]/);
  assert.match(ruleLines(ctx).join('\n'), /templates \(design intent\): Settings pages: heading, sections, actions at the end\./);
});

test('after drawing, each component used is shown beside what the prototype uses it for', () => {
  const ctx = contextFrom(catalog, intent);
  const uses = usesAgainstPurpose(ctx, [
    { component: 'button', props: { Label: 'Save' } }, { component: 'button', props: { Label: 'Cancel' } },
    { component: 'field', props: { standInFor: 'an on/off switch' } }, { component: 'Row', props: {} },
  ]);
  assert.deepEqual(uses.map((u) => u.component), ['button', 'field']);
  assert.deepEqual(uses[0].uses, ['Save', 'Cancel']);
  assert.match(uses[0].rule, /Guidelines: One per screen\./, 'two buttons beside "one per screen"');
  assert.match(uses[1].rule, /Not for an on\/off choice/);
});

test('a retired component is never put in a new prototype: its replacement is named', () => {
  const r = checkPrototype({ component: 'Page', children: [{ component: 'badge' }] }, { catalog, view: { components: [{ name: 'badge', controls: [] }] }, scales: { spacing: [], text: [] } });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.level === 'error' && /badge is deprecated: use tag instead/.test(f.message)));
});

const page = (padding, heading, extra = []) => ({ component: 'Page', props: { padding, gap: 'padding/m' }, children: [{ component: 'Text', props: { text: 'T', style: heading, as: 'h1' } }, ...extra, { component: 'Row', props: { justify: 'end' }, children: [{ component: 'button', props: { Label: 'Save' } }] }] });

test('page facts: the frame, the heading, where the actions sit, and the answer to each missing need', () => {
  const f = pageFacts(page('padding/m', 'm', [{ component: 'chip', props: { standInFor: 'on/off switch for email' } }, { component: 'Missing', props: { need: 'an illustration' } }]), { actionNames: ['button'] });
  assert.deepEqual(f.page, { padding: 'padding/m', gap: 'padding/m', width: null, align: null });
  assert.deepEqual(f.heading, { style: 'm', as: 'h1' });
  assert.deepEqual(f.actions, { at: 'end', justify: 'end' });
  assert.deepEqual(f.needs, [{ need: 'on/off switch for email', answer: 'chip as a stand-in' }, { need: 'an illustration', answer: 'a Missing box' }]);
});

test('conventions: two pages, or one designed screen, set a decision; a tie sets none; the team\'s file wins', () => {
  const A = ['button'];
  const two = { a: pageFacts(page('padding/m', 'm'), { actionNames: A }), b: pageFacts(page('padding/m', 'm'), { actionNames: A }) };
  assert.equal(deriveConventions(two).page.padding.value, 'padding/m');
  const one = { a: pageFacts(page('padding/m', 'm'), { actionNames: A }) };
  assert.equal(deriveConventions(one).page.padding, undefined, 'one page made in a chat is not yet a convention');
  assert.equal(deriveConventions({ a: { ...one.a, designed: true } }).page.padding.value, 'padding/m', 'a screen a designer made is');
  const tie = { a: pageFacts(page('padding/m', 'm'), { actionNames: A }), b: pageFacts(page('padding/s', 'm'), { actionNames: A }) };
  assert.equal(deriveConventions(tie).page.padding, undefined);
  const authored = deriveConventions(two, { page: { padding: 'padding/s' }, needs: { 'on/off switch': 'a Missing box' } });
  assert.equal(authored.page.padding.value, 'padding/s');
  assert.equal(authored.page.padding.authored, true);
  assert.equal(authored.needs[0].answer, 'a Missing box');
});

test('a page that decides differently from the others is told each difference, with the pages it differs from', () => {
  const A = ['button'];
  const others = {
    settings: { ...pageFacts(page('padding/m', 'm', [{ component: 'Missing', props: { need: 'a toggle switch' } }]), { actionNames: A }), designed: true },
  };
  const here = pageFacts(page('padding/s', 's', [{ component: 'chip', props: { standInFor: 'switch to toggle push' } }]), { actionNames: A });
  const d = consistencyFindings(here, deriveConventions(others));
  const lines = d.map(consistencyLine);
  assert.ok(lines.includes('page padding: padding/s here, padding/m on the product\'s other pages (settings)'), lines.join('\n'));
  assert.ok(lines.includes('page heading style: s here, m on the product\'s other pages (settings)'));
  assert.ok(lines.some((l) => /the answer to "a toggle switch": chip as a stand-in here, a Missing box/.test(l)), 'the same need, answered another way');
  assert.deepEqual(consistencyFindings(pageFacts(page('padding/m', 'm'), { actionNames: A }), deriveConventions(others)), [], 'a page that matches has nothing to change');
});

test('guidelines: every section is kept with its file; one named after a component goes with it, the rest are the product\'s rules', () => {
  const sections = sectionsOf('Every page opens with one heading.\n\n## button\nOne button per screen, for its main action.\n\n## Forms\nPut the Save action at the end.').map((x) => ({ ...x, file: 'guidelines/notion-style.md' }));
  const ctx = contextFrom(catalog, null, sections);
  assert.equal(ctx.components.button.guidelines, 'One button per screen, for its main action.');
  assert.deepEqual(ctx.rules.map((r) => [r.title, r.file]), [['guidelines', 'guidelines/notion-style.md'], ['Forms', 'guidelines/notion-style.md']]);
  assert.deepEqual(ctx.limits.map((l) => [l.component, l.max, l.per]), [['button', 1, 'screen']]);
});

test('limits are read only from a plain sentence: "one button per screen", "at most two fields on a page"; not "one primary button"', () => {
  const comps = { button: { guidelines: null }, field: { guidelines: null } };
  const rules = (t) => [{ title: 'x', text: t }];
  assert.deepEqual(limitsFrom(comps, rules('Use at most two fields on a page.'), ['button', 'field']).map((l) => [l.component, l.max]), [['field', 2]]);
  assert.deepEqual(limitsFrom(comps, rules('Show one primary button per screen.'), ['button', 'field']), [], 'a word between the number and the name: not read as a limit');
  assert.deepEqual(limitsFrom({ button: { guidelines: 'One per screen. Short labels.' } }, [], ['button']).map((l) => l.max), [1], 'in the component\'s own section, "one per screen" is about it');
});

test('a composition with more of a component than the guidelines allow is not drawn; a width that is no breakpoint is a warning', () => {
  const ctx = contextFrom(catalog, null, sectionsOf('## button\nOne button per screen.'));
  const ui = { component: 'Page', props: { width: '500' }, children: [{ component: 'button', props: { Label: 'Delete' } }, { component: 'button', props: { Label: 'Cancel' } }] };
  const r = checkPrototype(ui, { catalog, view: { components: [{ name: 'button', controls: [{ label: 'Label' }] }] }, scales: { spacing: [], text: [] }, limits: ctx.limits, breakpoints: breakpointsOf({ breakpoints: { mobile: '360px', desktop: 1280 } }) });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.level === 'error' && /2 button on this screen, and the guidelines allow 1: "One button per screen\." \(guidelines, button\)/.test(f.message)));
  assert.ok(r.findings.some((f) => f.level === 'warning' && /Page\.width 500 is none of the system's screen widths: mobile \(360\), desktop \(1280\)/.test(f.message)));
});

test('the request against everything known: the guidelines\' opening and the sections it touches, the components its words point to, the closest page', () => {
  const ctx = contextFrom({ components: { ...catalog.components, chip: { description: 'A filter people switch on and off.', props: {} } } }, null,
    sectionsOf('Every page opens with one heading.\n\n## Forms\nSettings save when Save is pressed, never on change.\n\n## Empty states\nNo illustration yet.'));
  const f = requestFocus(ctx, 'prototype a notification settings page with a switch for email and a Save button', [
    { name: 'settings', label: 'Settings (designed in Figma)', text: 'Settings Filter New Save', designed: true, file: null },
    { name: 'search', label: 'search', text: 'Search', designed: false, file: 'prototypes/search.json' },
  ]);
  assert.deepEqual(f.sections.map((x) => x.title), ['guidelines', 'Forms'], 'the opening always, then Forms (settings, save); not Empty states');
  assert.deepEqual(f.components.map((c) => c.name).sort(), ['button', 'chip']);
  assert.ok(f.components.find((c) => c.name === 'chip').matched.includes('switch'));
  assert.equal(f.pages[0].name, 'settings');
  const lines = focusLines(f).join('\n');
  assert.match(lines, /FOR THIS REQUEST {2}"prototype a notification settings page/);
  assert.match(lines, /start from: Settings \(designed in Figma\)/);
  assert.match(lines, /Forms: Settings save when Save is pressed, never on change\./);
});

test('a prototype request made with the command is kept for the catalog', async () => {
  const { routePrompt } = await import('../guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'proto-request-'));
  cpSync(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), root, { recursive: true });
  routePrompt({ prompt: '/rms-design-system-engine prototype a settings page with our components' }, { root, cfg: {} });
  const r = JSON.parse(readFileSync(join(root, '.design-system-engine-out', 'prototypes', 'request.json'), 'utf8'));
  assert.equal(r.text, 'prototype a settings page with our components');
});

test('a "never" in the documentation rules a use out by the words after it, not by the whole sentence', () => {
  const chip = { never: neverOf('Filters a list. People turn it on and off; it never submits anything.') };
  assert.deepEqual(ruledOut(chip, 'on/off switch for email', 'chip'), [], 'turning on and off is what a chip is for');
  assert.equal(ruledOut(chip, 'submit the form', 'chip').length, 1);
  const tag = { never: neverOf('A status that does not change. Never a message that comes and goes, like a confirmation or an error: Tidepool has no toast yet.', 'a message that disappears') };
  assert.deepEqual(ruledOut(tag, 'confirmation message', 'tag').map((r) => r.words), [['confirmation', 'message'], ['message']]);
  assert.deepEqual(ruledOut(tag, 'New', 'tag'), []);
});

test('the request: a component its documentation rules out is named as ruled out, never as one its words point to; as a stand-in it is an error', () => {
  const cat = { components: { ...catalog.components, tag: { description: 'A small status label.', props: { Label: { type: 'text' } } } } };
  const ctx = contextFrom(cat, null, sectionsOf('## tag\nA status that does not change. Never a message that comes and goes, like a confirmation: there is no toast yet.'));
  const f = requestFocus(ctx, 'an account page with a Save button and a message confirming the save', []);
  assert.ok(!f.components.some((c) => c.name === 'tag'), 'not pointed to by the sentence that rules it out');
  assert.deepEqual(f.ruledOut.map((r) => [r.name, r.words]), [['tag', ['message']]]);
  assert.match(focusLines(f).join('\n'), /ruled out by the documentation for "message": tag, "Never a message that comes and goes, like a confirmation: there is no toast yet\."/);
  const ui = { component: 'Page', children: [{ component: 'tag', props: { Label: 'Saved', standInFor: 'confirmation message' } }] };
  const r = checkPrototype(ui, { catalog: cat, view: { components: [{ name: 'tag', controls: [{ label: 'Label' }] }] }, scales: { spacing: [], text: [] }, context: ctx });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((x) => x.level === 'error' && /tag is not for "confirmation message": "Never a message that comes and goes/.test(x.message)));
});

test('a stand-in made of the engine\'s own Text is still a gap', () => {
  const r = checkPrototype({ component: 'Page', children: [{ component: 'Text', props: { text: 'Changes saved', style: 's' }, standInFor: 'a confirmation that goes away' }] }, { catalog, view: { components: [] }, scales: { spacing: [], text: [{ name: 's', size: '12px', lh: '16px', weight: '500' }] } });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(r.gaps.some((g) => g.need === 'a confirmation that goes away' && g.used === "the engine's Text"));
});

// ── End to end on a built Tidepool with written guidelines ────────────────────────────────────────────────────────
test('the catalog shows what each component is for and the product\'s pages; a drawn prototype is held to both', { timeout: 600000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-context-'));
  cpSync(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), dir, { recursive: true });
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  cpSync(join(ref, 'src', 'styles'), join(dir, 'src', 'styles'), { recursive: true });
  cpSync(join(ref, 'src', 'components'), join(dir, 'src', 'components'), { recursive: true });
  writeFileSync(join(dir, 'guidelines.md'), 'Every page opens with one heading.\n\n## field\nOnly for typing text. Never as an on/off control.\n');
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify({ ...cfg, guidelines: { sources: ['guidelines.md'] } }, null, 2));
  const run = (...args) => spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 300000 });
  assert.equal(run('--prototype', '--from-screens', 'src/figma/figma-screen-layout.snapshot.json').status, 0);

  const cat = run('--prototype', '--catalog');
  assert.equal(cat.status, 0, cat.stdout);
  assert.match(cat.stdout, /field +A one-line text input\. Role textbox\.\n +guidelines Only for typing text\. Never as an on\/off control\./);
  assert.match(cat.stdout, /guidelines \(guidelines\.md\): Every page opens with one heading\./);
  assert.match(cat.stdout, /Read from:\n(.*\n)*  • Figma: 1 designed screen \(src\/figma\/figma-screen-layout\.snapshot\.json\)\n(.*\n)*  • guidelines: guidelines\.md \(committed\)/);
  assert.match(cat.stdout, /page padding padding\/m \(settings\)/, 'the designed screen sets the product\'s frame');
  assert.ok(!existsSync(join(dir, 'src', 'styles', 'design-intent.json')), 'reading the intent writes nothing into the project');

  mkdirSync(join(dir, 'prototypes'), { recursive: true });
  writeFileSync(join(dir, 'prototypes', 'notify.json'), JSON.stringify({ component: 'Page', props: { padding: 'padding/s', gap: 'padding/m', width: '360' }, children: [
    { component: 'Text', props: { text: 'Notifications', style: 'm', as: 'h1' } },
    { component: 'field', props: {} },
    { component: 'button', props: { Label: 'Save' } },
  ] }));
  const r = run('--prototype', 'prototypes/notify.json');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /📓 WHAT THE DOCUMENTATION SAYS ABOUT WHAT THIS PROTOTYPE USES\n.*field: A one-line text input\. Role textbox\. Guidelines: Only for typing text\./);
  assert.match(r.stdout, /• button \(used for "Save"\): The main action on a screen\./);
  assert.match(r.stdout, /📐 DIFFERENT FROM THE PRODUCT'S OTHER PAGES {2}1\n {3}• page padding: padding\/s here, padding\/m on the product's other pages \(settings\)/);
  const last = JSON.parse(readFileSync(join(dir, '.design-system-engine-out', 'prototypes', 'last.json'), 'utf8'));
  assert.ok(last.gaps.some((g) => g.kind === 'consistency' && /page padding/.test(g.line)), 'the reply owes the difference');

  const c = run('--prototype', '--consistency');
  assert.equal(c.status, 0);
  assert.match(c.stdout, /⚠️ {2}notify\n {6}• page padding: padding\/s here, padding\/m/);
  assert.match(c.stdout, /✅ settings: the same as the others/);
});

test('without importing anything, the designed screens set the product\'s pages and the request picks the closest one', { timeout: 600000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-focus-'));
  cpSync(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), dir, { recursive: true });
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  cpSync(join(ref, 'src', 'styles'), join(dir, 'src', 'styles'), { recursive: true });
  cpSync(join(ref, 'src', 'components'), join(dir, 'src', 'components'), { recursive: true });
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--prototype', '--catalog', '--for', 'a notification settings page with a Save button'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 300000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /FOR THIS REQUEST {2}"a notification settings page with a Save button"\n {2}start from: Settings \(designed in Figma; rms-design-system-engine --prototype --from-screens brings it into prototypes\/\)/);
  assert.match(r.stdout, /components its words point to: button/);
  assert.match(r.stdout, /page padding padding\/m \(settings\)/);
  assert.ok(!existsSync(join(dir, 'prototypes')), 'nothing written into the project');
});

test('the frame: containers a designed page holds at the top (a bar, a panel) are the product\'s; content is not', () => {
  const ia = { component: 'Page', children: [{ component: 'actionBar', children: [{ component: 'input' }] }, { component: 'Row', children: [{ component: 'panel', children: [{ component: 'listItem' }] }, { component: 'Stack', children: [] }] }, { component: 'button' }] };
  const f = pageFacts(ia);
  assert.deepEqual(f.frame, ['actionBar', 'panel'], 'the button and the list item are content');
  const conv = deriveConventions({ ia: { ...f, designed: true } });
  assert.deepEqual(conv.frame.map((c) => c.component), ['actionBar', 'panel']);
  const here = pageFacts({ component: 'Page', children: [{ component: 'Row', children: [{ component: 'panel', children: [{ component: 'listItem' }] }] }] });
  assert.deepEqual(consistencyFindings(here, conv).map(consistencyLine), ["the page's frame: no actionBar here, actionBar on the product's other pages (ia)"]);
});

test('an option the code has no prop for is drawn on the part its name points to; the check says so only when there is none', async () => {
  const { drawnByName } = await import('../prototype-pieces.mjs');
  const markup = '<div class="listItem"><span class="listItem-title">x</span><span class="listItem-description">y</span></div>';
  assert.equal(drawnByName('TitleContent', { type: 'text', default: 'Title' }, markup), true);
  assert.equal(drawnByName('Show Description', { type: 'boolean' }, markup), true);
  assert.equal(drawnByName('label-content', { type: 'text', default: 'label' }, '<button class="b"><svg></svg></button>'), true, 'a label goes where the component\'s text is');
  assert.equal(drawnByName('number content', { type: 'text', default: '1' }, '<div class="dividerSection">x</div>'), false);
});

test('a request word many components\' notes share (the product\'s name) points to none of them', () => {
  const comps = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((n) => [n, { description: `Part ${n} of Atlas.`, props: {} }]));
  comps.emptyState = { description: 'Centred icon, title and description when there is nothing to show.', props: {} };
  const f = requestFocus(contextFrom({ components: comps }, null, []), 'a Saved views screen for Atlas with an empty state', []);
  assert.deepEqual(f.components.map((c) => c.name), ['emptyState']);
});

test('the request: a component it names that the prototype leaves out is owed; one the documentation rules out for it is an error unless its purpose says otherwise', async () => {
  const { requestFindings } = await import('../prototype-context.mjs');
  const cat = { components: { emptyState: { description: 'Shown when a list has nothing.', props: {} }, listItem: { description: 'A row.', props: {} }, tag: { description: 'A small status label.', props: {} } } };
  const ctx = contextFrom(cat, null, sectionsOf('## tag\nA status that does not change. Never a message that comes and goes, like a confirmation.'));
  const asked = requestFindings(ctx, 'a Saved views screen: a list of saved views and an empty state for when there are none', [{ component: 'listItem', props: {} }]);
  assert.deepEqual(asked.map((f) => [f.level, f.kind]), [['warning', 'request']]);
  assert.match(asked[0].message, /the request asks for empty state and the system has emptyState, which is not in the prototype/);
  const out = requestFindings(ctx, 'an account page and a message confirming the save', [{ id: 't', component: 'tag', props: { Label: 'Changes saved' } }]);
  assert.ok(out.some((f) => f.level === 'error' && /tag is ruled out for "message" in this request/.test(f.message)));
  assert.deepEqual(requestFindings(ctx, 'an account page and a message confirming the save', [{ id: 't', component: 'tag', props: { Label: 'Beta', purpose: 'marks the page as beta' } }]), [], 'another purpose, not ruled out');
  assert.equal(requestFindings(ctx, 'an account page and a message confirming the save', [{ id: 't', component: 'tag', props: { purpose: 'the confirmation message' } }]).length, 1, 'a purpose the documentation rules out too');
  const r = checkPrototype({ component: 'Page', children: [{ component: 'tag', props: { purpose: 'marks the page as beta' } }] }, { catalog: cat, view: { components: [{ name: 'tag', controls: [] }] }, scales: { spacing: [], text: [] }, context: ctx, request: 'a message confirming the save' });
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test('build mode: a text colour set on the component\'s text part counts; none at all fails the structure gate', { timeout: 600000 }, () => {
  const make = (fieldCss) => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-textpart-'));
    cpSync(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), dir, { recursive: true });
    const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
    cpSync(join(ref, 'src', 'styles'), join(dir, 'src', 'styles'), { recursive: true });
    cpSync(join(ref, 'src', 'components'), join(dir, 'src', 'components'), { recursive: true });
    if (fieldCss) writeFileSync(join(dir, 'src', 'components', 'field.css'), fieldCss);
    return spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--component', 'field'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DESIGN_SYSTEM_ENGINE_NO_FETCH: '1' }, timeout: 300000 }).stdout;
  };
  assert.doesNotMatch(make(null), /"color" not set in "\.field"/, 'the reference sets it on .field__input');
  const none = readFileSync(join(ENGINE, 'test', 'skill-evals', 'build-reference', 'src', 'components', 'field.css'), 'utf8').replace(/ color: var\(--text-primary\);/, '');
  assert.match(make(none), /field\/default\/text: "color" not set in "\.field"/);
});
