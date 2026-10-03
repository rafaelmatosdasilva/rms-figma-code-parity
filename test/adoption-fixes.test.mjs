// The causes behind the misses of the 2026-10 evaluations, each made deterministic so the model does not decide it:
// the first fix on a tie, the file a page name refers to, the role Figma's annotation asks for, and the sentence owed
// when a colour has no variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { burndownLines } from '../run-diff.mjs';
import { buildSummary } from '../next-step.mjs';
import { route, pagesNamed, rawColoursOf } from '../route.mjs';
import { roleWord, roleMarkupFindings } from '../role-markup.mjs';
import { sayKind } from '../guard.mjs';
import { fixtureProject } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));

test('a burndown tie is said, and the summary names what to fix first', () => {
  const lines = burndownLines({ rows: [{ name: 'button', open: 5, was: null }, { name: 'chip', open: 5, was: null }], loose: 0, done: [] });
  assert.match(lines[1], /next up: button \(tied with chip at 5; a tie goes in name order\)/);
  const s = buildSummary({ verdict: 'fail', gates: [], burndown: lines, next: 'NEXT: x' });
  assert.match(s, /Fix first: button \(tied with chip at 5/);
});

test('a page named in a request is the file whose path holds that word', () => {
  const pages = ['apps/gallery/ui.html', 'apps/settings/ui.html', 'src/components/Button.jsx'];
  assert.deepEqual(pagesNamed('add a small green "Saved" confirmation next to the Save button on the gallery page', pages, ['button', 'chip']), ['apps/gallery/ui.html']);
  assert.deepEqual(pagesNamed('add a button to the page', pages, ['button']), []);
  const r = route('add a small green "Saved" confirmation next to the Save button on the gallery page', { components: ['button', 'chip'], pages });
  assert.ok(r.notes.some((n) => /The file the request names is apps\/gallery\/ui\.html/.test(n)), r.notes.join('\n'));
});

test('the role Figma annotates is read in the markup: a <div> toggle fails, a button with aria-pressed passes', () => {
  assert.equal(roleWord([{ label: 'Role: togglebutton' }]), 'togglebutton');
  assert.deepEqual(roleMarkupFindings('return <div className="chip">{label}</div>', 'togglebutton'), ['a <button> (or role="button")', 'aria-pressed, written even when it is false']);
  assert.deepEqual(roleMarkupFindings('return <button type="button" aria-pressed={on}>{label}</button>', 'togglebutton'), []);
  assert.deepEqual(roleMarkupFindings('return <Button pressed={on}>{label}</Button>', 'togglebutton'), [], 'composed from the system\'s own component: left to the browser check');
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-role-');
  mkdirSync(join(dir, 'src/components'), { recursive: true });
  writeFileSync(join(dir, 'src/components/Chip.jsx'), 'export function Chip({ Size = "M", Icon = "False", Label = "Filter" }) {\n  return <div className="chip">{Label}</div>;\n}\n');
  writeFileSync(join(dir, 'src/components/chip.css'), '.chip { height: 24px; }\n');
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--component', 'chip', '--only', '15'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(r.stdout, /chip: Figma's annotation says role togglebutton; the code needs a <button> \(or role="button"\) and aria-pressed/);
});

test('building a component Figma paints with a colour that has no variable: the person is told, in the reply', () => {
  const struct = JSON.parse(readFileSync(join(ENGINE, 'test/fixtures/tidepool-figma/src/figma/figma-structure.snapshot.json'), 'utf8')).components;
  const raw = rawColoursOf(struct);
  assert.deepEqual(raw.tag, ['Tone=Positive #d6f5e3, #136c3a']);
  const r = route('build the tag from our Figma design system as a React component', { components: Object.keys(struct), rawColours: raw, build: true });
  assert.equal(r.recipe, 'build-from-figma');
  assert.equal(sayKind(r.say[0]), 'noVariable', r.say.join('\n'));
  assert.equal(route('build the button from our Figma design system', { components: Object.keys(struct), rawColours: raw, build: true }).say.length, 0);
});

test('a reply that asks the person for a secret goes back once, whatever the route; a design token is not a secret', async () => {
  const { stopCheck, asksForSecret, rememberSay } = await import('../guard.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'secret-'));
  assert.equal(asksForSecret('Once you provide the token, I can complete setting up the guidelines from that URL.'), true);
  assert.equal(asksForSecret('Give me a hex/token to use, or confirm a green is fine.'), false);
  assert.equal(asksForSecret('Put GITLAB_TOKEN in the project\'s .env, never paste it here.'), false);
  const back = stopCheck({ session_id: 's', last_assistant_message: 'Saved the link. Once you provide the token, I can finish.' }, { root });
  assert.match(back ?? '', /asks the person for a secret in the chat[\s\S]*\.env/);
  assert.equal(stopCheck({ session_id: 's', stop_hook_active: true, last_assistant_message: 'Once you provide the token, I can finish.' }, { root }), null, 'once only');
  assert.equal(stopCheck({ session_id: 's', last_assistant_message: 'Saved the link; the page could not be read yet.' }, { root }), null);
  // With an owed line too, both go back in one message.
  rememberSay(root, { session_id: 's', prompt_id: 'p' }, ['Figma paints tag (Tone=Positive #d6f5e3) with colours that have no variable: the code writes them as Figma has them, and the design system has no token for them yet.']);
  const both = stopCheck({ session_id: 's', prompt_id: 'p', last_assistant_message: 'Built the tag. Please provide the token so I can refresh.' }, { root });
  assert.match(both ?? '', /leaves out .*colours the design system has no variable for, and asks the person for a secret/);
});

test('before the agent finishes, a value the system does not have that an edit left in a changed file goes back once', async () => {
  const { stopCheck } = await import('../guard.mjs');
  const { execFileSync } = await import('node:child_process');
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'demo-ds'), 'left-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  try { git('rev-parse', '--git-dir'); } catch { git('init', '-q'); }
  git('add', '-A'); try { git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'); } catch { /* the fixture is committed already */ }
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  assert.equal(stopCheck({ session_id: 's', last_assistant_message: 'Done.' }, { root: dir, cfg }), null, 'nothing changed');
  const page = join(dir, 'apps/gallery/ui.html');
  writeFileSync(page, readFileSync(page, 'utf8').replace('</body>', '<span style="color: #2d8659">Saved</span>\n</body>'));
  const back = stopCheck({ session_id: 's', last_assistant_message: 'The system has no green. Which colour should I use?' }, { root: dir, cfg });
  assert.match(back ?? '', /files you changed still hold[\s\S]*apps\/gallery\/ui\.html[\s\S]*#2d8659 is not a design-system colour[\s\S]*leave it out and tell the person/);
  assert.equal(stopCheck({ session_id: 's', stop_hook_active: true, last_assistant_message: 'x' }, { root: dir, cfg }), null, 'once only');
});

test('an owed line gets a second hand-back when the first went to something else, and no more', async () => {
  const { stopCheck, rememberSay } = await import('../guard.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'twice-'));
  const line = 'Figma paints tag (Tone=Positive #d6f5e3) with colours that have no variable: the code writes them as Figma has them, and the design system has no token for them yet.';
  rememberSay(root, { session_id: 's', prompt_id: 'p' }, [line]);
  const ev = (active) => ({ session_id: 's', prompt_id: 'p', stop_hook_active: active, last_assistant_message: 'Built the tag.' });
  assert.match(stopCheck(ev(false), { root }) ?? '', /leaves out/);
  assert.match(stopCheck(ev(true), { root }) ?? '', /leaves out/, 'a second time, still owed');
  assert.equal(stopCheck(ev(true), { root }), null, 'never a third');
});

test('a path that holds "figma" is not "in Figma": the Settings build prompt routes to build-from-figma', () => {
  const p = 'build the Settings screen from our Figma design as a React component, exported as Settings from src/screens/Settings.jsx, using our components in src/components. What the Figma MCP returned for it is in figma-mcp/settings.md.';
  assert.equal(route(p, { components: ['button', 'chip', 'field', 'tag'], build: true }).recipe, 'build-from-figma');
  assert.notEqual(route('change the chip radius in figma to 8', { components: ['chip'] }).recipe, 'build-from-figma');
});

test('in build mode a measured difference fails, and Figma leads; renderedParityStrict false keeps it advisory', { timeout: 300000 }, () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-measured-');
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/tag.css', 'src/components/Tag.jsx']) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8')); }
  writeFileSync(join(dir, 'src/components/tag.css'), readFileSync(join(dir, 'src/components/tag.css'), 'utf8').replace('12px/16px', '12px/20px'));
  const run = () => spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--component', 'tag'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ tag line height: Figma .*\(16px\), rendered 20px .*→ set 16px/);
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify({ ...cfg, renderedParityStrict: false }, null, 2));
  r = run();
  assert.match(r.stdout, /⚠️ +MEASURED 1 .*advisory/);
});

test('a role is checked when every Figma prop is a state: a field with no real input fails', () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-field-');
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/field.css', 'src/components/Field.jsx']) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8')); }
  const gate = () => spawnSync(process.execPath, [join(ENGINE, 'component-prop-check.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(gate().status, 0, gate().stdout);
  writeFileSync(join(dir, 'src/components/Field.jsx'), readFileSync(join(dir, 'src/components/Field.jsx'), 'utf8').replace(/<input[^>]*>/, '<div className="field-value">{value}</div>'));
  const r = gate();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /field: Figma's annotation says role textbox; the code needs an <input> or <textarea>/);
});

test('a React component is drawn as the JSX it returns: its element, its children, its default text', async () => {
  const { jsxMarkup, propDefaults } = await import('../jsx-markup.mjs');
  const tag = 'export function Tag({ Tone = "Neutral", Label = "New" }) {\n  return (\n    <span className={`tag ${Tone === "Positive" ? "tag--positive" : ""}`}>\n      {Label}\n    </span>\n  );\n}';
  assert.equal(jsxMarkup(tag, '.tag'), '<span class="tag">New</span>');
  const field = 'export function Field({ state = "Default", placeholder = "Ada", ...props }) {\n  const fieldClass = `field ${state === "Error" ? "field--error" : ""}`;\n  return (\n    <div className={fieldClass}>\n      <input type="text" placeholder={placeholder} aria-invalid={state === "Error"} {...props} />\n    </div>\n  );\n}';
  assert.equal(jsxMarkup(field, 'field'), '<div class="field"><input type="text"></div>');
  // A helper defined above the component is not the component; another component's tag is left out.
  const chip = 'function ChipIcon() {\n  return (<svg className="chip__icon" />);\n}\nexport function Chip({ Label = "Filter" }) {\n  return (\n    <button type="button" className={["chip", x && "chip--l"].filter(Boolean).join(" ")} onClick={go}>\n      <ChipIcon />\n      <span className="chip__label">{Label}</span>\n    </button>\n  );\n}';
  assert.equal(jsxMarkup(chip, 'chip'), '<button class="chip" type="button"><span class="chip__label">Filter</span></button>');
  assert.deepEqual(propDefaults('export const Badge = ({ tone = "neutral", count = 3, on = false }) => <span />'), { tone: 'neutral', count: '3', on: 'false' });
  assert.equal(jsxMarkup('export const x = 1;', 'x'), null);
});

test('a height the rule already sets but the drawn box does not keep says why: inline, or padding outside a content box', { timeout: 300000 }, () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-why-');
  const ref = join(ENGINE, 'test', 'skill-evals', 'build-reference');
  for (const p of ['src/styles/tokens.css', 'src/components/tag.css', 'src/components/Tag.jsx', 'src/components/field.css', 'src/components/Field.jsx']) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), readFileSync(join(ref, p), 'utf8')); }
  // The tag drops its display (a <span>, so inline); the field drops its box-sizing.
  writeFileSync(join(dir, 'src/components/tag.css'), readFileSync(join(dir, 'src/components/tag.css'), 'utf8').replace('display: inline-flex; box-sizing: border-box; ', 'box-sizing: border-box; '));
  writeFileSync(join(dir, 'src/components/field.css'), readFileSync(join(dir, 'src/components/field.css'), 'utf8').replace('box-sizing: border-box; ', ''));
  const run = (c) => spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--component', c], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  let r = run('tag');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /tag height: Figma 20, rendered \d+ .*→ the rule sets 20px, but the element is inline and ignores a height: give it display: inline-flex \(or block\)/);
  r = run('field');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /field height: Figma 36, rendered \d+ .*→ the rule sets 36px, but padding and border add to it: set box-sizing: border-box/);
});

test('the code names recorded for Figma names are the person\'s decision: an edit of contract.authored.json asks', async () => {
  const { judge } = await import('../guard.mjs');
  const edit = (f, t = 'Edit') => ({ tool_name: t, tool_input: { file_path: f } });
  assert.equal(judge(edit('/p/contract.authored.json'), { userText: 'build the chip from our Figma design system' })?.decision, 'ask');
  assert.match(judge(edit('/p/contract.authored.json'), { userText: 'build the tag' }).reason, /records which code name stands for each Figma name/);
  assert.equal(judge(edit('/p/contract.authored.json'), { userText: 'record that the code calls the Figma prop State "variant"' }), null);
  assert.equal(judge(edit('/p/docs/contract.json', 'Write'), { cfg: { contracts: { authored: 'docs/contract.json' } }, userText: 'fix the chip' })?.decision, 'ask');
  assert.equal(judge({ tool_name: 'Bash', tool_input: { command: 'echo {} > contract.authored.json' } }, { userText: 'build the tag' })?.decision, 'ask');
  assert.equal(judge(edit('/p/contract.authored.json'))?.decision, 'ask', 'no transcript: it asks, as the other decision files do');
});

test('a role is a set of obligations: the element first, then what it owes; a name the source cannot hold is owed, never invented (I85)', async () => {
  const { roleObligations, roleMarkupFindings, roleSheetLines, roleMarkup } = await import('../role-markup.mjs');
  // An icon-only toggle: a button with aria-pressed, and no name of its own.
  assert.deepEqual(roleObligations('return <button type="button" aria-pressed={on}><svg /></button>', 'togglebutton'), { missing: [], owed: ['a spoken name (its text, or aria-label when it shows only an icon)'] });
  assert.match(roleMarkupFindings('return <button type="button" aria-pressed={on}><svg /></button>', 'togglebutton')[0], /owed: Figma's annotation or the person says what/);
  // Named by its text, by a prop after another child, by aria-label, or by whoever uses it through {...rest}.
  for (const named of ['<button aria-pressed={on}>Filter</button>', '<button aria-pressed={on}>{icon && <Icon />}{Label}</button>', '<button aria-pressed={on} aria-label={label}><svg /></button>', '<button aria-pressed={on} {...rest}><svg /></button>'])
    assert.deepEqual(roleObligations(`return ${named}`, 'togglebutton').owed, [], named);
  // A wrong element fails on its element, not on what it owes.
  assert.deepEqual(roleObligations('return <div className="chip"><svg /></div>', 'togglebutton'), { missing: ['a <button> (or role="button")', 'aria-pressed, written even when it is false'], owed: [] });
  assert.deepEqual(roleObligations('return <button onClick={go}>More</button>', 'disclosure').missing, ['aria-expanded, written even when it is false', 'aria-controls naming the panel']);
  assert.deepEqual(roleObligations('return <input type="text" />', 'textfield').owed, ['a label (a <label>, aria-label or aria-labelledby)'], 'another word for the same role');
  assert.equal(roleMarkup('iconbutton'), 'a <button type="button">');
  assert.deepEqual(roleSheetLines('textbox'), ['a label (a <label>, aria-label or aria-labelledby)', 'an error message, while it shows, linked to the field with aria-describedby (and aria-invalid="true")']);
});

test('the build sheet lists every obligation of the role Figma annotates', () => {
  const dir = fixtureProject(join(ENGINE, 'test', 'fixtures', 'tidepool-figma'), 'tp-roles-');
  const r = spawnSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--query', 'field'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(r.stdout, /role: textbox, so write it as an <input> or <textarea> with a label\n\s+and a label \(a <label>, aria-label or aria-labelledby\)\n\s+and an error message, while it shows, linked to the field with aria-describedby/);
});
