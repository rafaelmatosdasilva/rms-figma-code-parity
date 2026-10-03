// I62: every UI edit is checked when it is made. What an edit added that the design system does not have goes
// back to the agent with the right name; what it did not add, the app's own components, the platform's own
// attributes, token definitions, comments and data stay silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addedLines, editFindings, editCheck, componentTagIn, normHex, themeSizes } from '../edit-check.mjs';
import { steeringTruth } from '../steering-check.mjs';
import { makeFixture } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = { components: { chip: { props: { Size: { type: 'enum', values: ['M', 'L'], codeName: 'size' } } }, button: { props: {} } } };
const theme = ':root {\n  --text-primary: #1b2433;\n  --chip-text: #1B2433;\n  --chip-background: #e8eef9;\n}\n';
const ctx = { truth: steeringTruth({ catalog, cssVars: ['--text-primary', '--chip-text', '--chip-background'] }), tokenByValue: new Map([['#1b2433', ['--text-primary', '--chip-text']], ['#e8eef9', ['--chip-background']]]) };
const find = (added, opts = {}) => editFindings(added, added.join('\n'), ctx, opts).map((f) => f.text);

test('what an edit added: new lines of an Edit or MultiEdit, lines a Write adds to the committed file', () => {
  assert.deepEqual(addedLines({ tool_name: 'Edit', tool_input: { old_string: 'a\nb', new_string: 'a\nb\nc\n' } }), ['c']);
  assert.deepEqual(addedLines({ tool_name: 'MultiEdit', tool_input: { edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '', new_string: 'z' }] } }), ['y', 'z']);
  assert.deepEqual(addedLines({ tool_name: 'Write', tool_input: { content: 'a\nb\nc' } }, { headText: 'a\nc' }), ['b']);
  assert.deepEqual(addedLines({ tool_name: 'Write', tool_input: { content: 'a\nb' } }), ['a', 'b']);   // a new file
  assert.deepEqual(addedLines({ tool_name: 'Read', tool_input: {} }), []);
  assert.equal(normHex('#ABC'), '#aabbcc');
});

test('flags a colour written by hand, with the token that has it, and one the system does not have', () => {
  assert.deepEqual(find(['.card { color: #1B2433; }'], { sheet: true }), ['#1B2433 is written by hand; use var(--text-primary) (or var(--chip-text))']);
  assert.deepEqual(find(['.card { border-color: #ff00aa; }'], { sheet: true }), ['#ff00aa is not a design-system colour; use one of its colour tokens']);
  assert.deepEqual(find(['<div style={{ backgroundColor: "#e8eef9" }}>']), ['#e8eef9 is written by hand; use var(--chip-background)']);
  assert.deepEqual(find(['<rect fill="#e8eef9" />']), ['#e8eef9 is written by hand; use var(--chip-background)']);
});

test('in the theme file, a colour Figma has nowhere is flagged (a page rule written there)', () => {
  assert.deepEqual(find(['.saved { color: #22c55e; }'], { sheet: true, isTheme: true }), ['#22c55e is not a design-system colour; use one of its colour tokens']);
});

test('silent on colours that are not styling: token definitions, the theme, comments, links, data, a canvas', () => {
  assert.deepEqual(find(['  --brand: #ff00aa;'], { sheet: true }), []);
  assert.deepEqual(find([':root{--a: #ff00aa;--b: #00ff00}'], { sheet: true }), []);
  assert.deepEqual(find(['.card { color: #1b2433; }'], { sheet: true, isTheme: true }), [], 'the theme writes the system\'s own values');
  assert.deepEqual(find(['// matches #ff00aa in dark mode'], { sheet: true }), []);
  assert.deepEqual(find(['<a href="#add">Add</a>', '<Link to="#faded">x</Link>']), []);
  assert.deepEqual(find(["  '100': '#f4ed7c', '101': '#f4ed47',"]), []);
  assert.deepEqual(find(["ctx.fillStyle = '#ffffff';"]), []);
  assert.deepEqual(find(['.card { color: var(--text-primary, #1b2433); }'], { sheet: true }), []);   // a fallback goes through the token
});

test('flags a variable declared nowhere, unless the file declares it', () => {
  assert.deepEqual(find(['.x { color: var(--chip-bg); }'], { sheet: true }), ['var(--chip-bg) is not a declared CSS variable']);
  const added = ['.x { --local: 2px; gap: var(--local); }'];
  assert.deepEqual(editFindings(added, added.join('\n'), ctx, { sheet: true }), []);
});

test('props only on a design-system component tag, never on the HTML element or the app\'s own components', () => {
  assert.deepEqual(find(['<Chip size="md" />']), ['size="md" is not a value this prop takes; write size="M"']);
  assert.deepEqual(find(['<Chip Size="L" />']), ['Size= is not the prop\'s name as the code writes it; write size=']);
  assert.deepEqual(find(['<input size="20" />', '<button size="big">x</button>', '<MyChip size="md" />']), []);
  assert.equal(componentTagIn('<hb-chip size="M">', ['chip']), 'hb-chip');
  assert.equal(componentTagIn('<my-custom-chip>', ['chip']), null);
});

test('a comment that switches a check off goes back with the rules it names (I73); prose about one does not', () => {
  const off = (rules) => `${rules} switches a check off; fix what the check reports, or ask the person first`;
  assert.deepEqual(find(['  // eslint-disable-next-line jsx-a11y/click-events-have-key-events']), [off('eslint-disable-next-line jsx-a11y/click-events-have-key-events')]);
  assert.deepEqual(find(['{/* eslint-disable-next-line react/jsx-key */}']), [off('eslint-disable-next-line react/jsx-key')]);
  assert.deepEqual(find(['// eslint-disable-next-line no-console -- debugging']), [off('eslint-disable-next-line no-console')]);
  assert.deepEqual(find(['/* stylelint-disable declaration-no-important */'], { sheet: true }), [off('stylelint-disable declaration-no-important')]);
  assert.deepEqual(find(['// biome-ignore lint/a11y/useButtonType: the parent sets it']), [off('biome-ignore lint/a11y/useButtonType')]);
  assert.deepEqual(find(['// @ts-ignore the types are wrong', '{/* @ts-expect-error */}', '// @ts-nocheck', '<!-- eslint-disable -->']),
    [off('@ts-ignore'), off('@ts-expect-error'), off('@ts-nocheck'), off('eslint-disable')]);
  assert.deepEqual(find(['// see the eslint-disable docs', 'const rule = "eslint-disable";', '// eslint-disabled on purpose', '/* eslint-enable */']), []);

  const dir = makeFixture({
    'ds-config.json': { paths: { themeCSS: 'src/theme.css' } },
    'src/theme.css': theme,
    'contracts/catalog.json': catalog,
    'src/pages/Filters.jsx': '{/* @ts-expect-error the old size */}\n<Chip size="M" />\n',
  });
  const r = editCheck({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/pages/Filters.jsx'), old_string: '<Chip size="M" />', new_string: '{/* @ts-expect-error the old size */}\n<Chip size="M" />' } }, { root: dir, cfg: { paths: { themeCSS: 'src/theme.css' } }, headOf: () => null });
  assert.match(r, /^rms-design-system-engine checked this edit: 1 thing to fix\.\n/);
  assert.match(r, /Filters\.jsx:1  @ts-expect-error switches a check off/);
  assert.match(r, /\nTake it out and fix what the check reports\. When that cannot be done, ask the person before switching a check off\.$/);
});

test('accessibility where the edit added the line (I74): the static rules with their fix; lines it did not add stay silent', () => {
  const a = { ...ctx, a11y: { styles: () => '' } };
  const run = (full, at, opts) => { const lines = full.split('\n'); return editFindings(at.map((i) => lines[i]), full, a, opts).map((f) => `${f.line}: ${f.text}`); };
  const page = '<button class="old"><Icon name="x" /></button>\n<button onClick={close}><CloseIcon /></button>\n<img src={logo}>\n<div onClick={open}>Open</div>\n<span aria-lable="Close">x</span>\n<button>Save</button>';
  assert.deepEqual(run(page, [1, 2, 3, 4, 5]), [
    '2: a button with only an icon inside and no aria-label, aria-labelledby or title; add aria-label="<what it does>"',
    '3: an image with no alt (use alt="" when it is decorative); add alt="<what it shows>"',
    '4: a clickable <div> with no role and no tabindex: a keyboard cannot reach it (use a <button>)',
    '5: aria-lable is not an ARIA attribute; write aria-label',
  ]);   // the button on line 1 was there before the edit
  // A removed focus outline counts only when no style in the project puts focus back.
  const css = '.chip:focus { outline: none; }';
  assert.deepEqual(run(css, [0], { sheet: true }), ['1: .chip:focus removes the focus outline and no focus style puts one back; add a .chip:focus-visible style that shows where focus is']);
  assert.deepEqual(editFindings([css], css, { ...ctx, a11y: { styles: () => '.chip:focus-visible { box-shadow: 0 0 0 2px var(--focus); }' } }, { sheet: true }), []);
  const vue = '<template><button>Go</button></template>\n<style>\n.go:focus { outline: 0 }\n</style>';
  assert.deepEqual(run(vue, [2], { component: true }), ['3: .go:focus removes the focus outline and no focus style puts one back; add a .go:focus-visible style that shows where focus is']);
  assert.deepEqual(editFindings(['<img src="a.png">'], '<img src="a.png">', ctx), []);   // not asked for (a11yStatic: false)

  const dir = makeFixture({
    'ds-config.json': { paths: { themeCSS: 'src/theme.css' } },
    'src/theme.css': theme,
    'contracts/catalog.json': catalog,
    'src/pages/Filters.jsx': '<button onClick={close}><CloseIcon /></button>\n',
  });
  const edit = { tool_name: 'Write', tool_input: { file_path: join(dir, 'src/pages/Filters.jsx'), content: '<button onClick={close}><CloseIcon /></button>\n' } };
  const r = editCheck(edit, { root: dir, cfg: { paths: { themeCSS: 'src/theme.css' } }, headOf: () => null });
  assert.match(r, /^rms-design-system-engine checked this edit: 1 thing to fix\.\n  Filters\.jsx:1  a button with only an icon inside/);
  assert.match(r, /\nFix it in this file now\.$/);
  assert.equal(editCheck(edit, { root: dir, cfg: { paths: { themeCSS: 'src/theme.css' }, a11yStatic: false }, headOf: () => null }), null);
});

test('a size written by hand (I75): the token with that value, or the nearest; only a kind of size the theme names', () => {
  const sizes = themeSizes(':root {\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 1rem;\n  --radius-md: 6px;\n  --radius-full: 9999px;\n  --font-size-sm: 0.875rem;\n  --spacing: 0.25rem;\n}');
  const s = { ...ctx, truth: steeringTruth({ catalog, cssVars: ['--space-2', '--space-3', '--space-4', '--radius-md', '--radius-full', '--font-size-sm'] }), sizes };
  const run = (lines, opts = { sheet: true }) => editFindings(lines, lines.join('\n'), s, opts).map((f) => f.text);
  assert.deepEqual(run(['.card { padding: 12px 1rem; gap: 10px; border-radius: 6px; font-size: 14px; }']), [
    'padding: 12px is written by hand; use var(--space-3)',
    'padding: 1rem is written by hand; use var(--space-4)',
    'gap: 10px is not a spacing value of the design system; the nearest are var(--space-2) (8px) and var(--space-3) (12px)',
    'border-radius: 6px is written by hand; use var(--radius-md)',
    'font-size: 14px is written by hand; use var(--font-size-sm)',
  ]);
  assert.deepEqual(run(['.pill { border-radius: 9999px; }']), ['border-radius: 9999px is written by hand; use var(--radius-full)']);
  // Left alone: 0, a hairline, a negative, calc(), a pill no token holds, other properties, a token, a token definition, the theme.
  assert.deepEqual(run(['.x { margin: 0 auto; padding: 1px; margin-top: -8px; padding: calc(100% - 12px); border-radius: 999px; width: 12px; line-height: 20px; }', '.y { padding: var(--space-3); }', '  --gap-x: 10px;']), []);
  assert.deepEqual(run(['.card { padding: 10px; }'], { sheet: true, isTheme: true }), []);
  assert.deepEqual(editFindings(['.card { padding: 10px; }'], '.card { padding: 10px; }', { ...ctx, sizes: themeSizes(':root { --radius-md: 6px; }') }, { sheet: true }), []);   // no spacing token, no spacing finding
  // In markup: a style attribute (a bare number is px there) and a style object; an option that is not a style is left alone.
  assert.deepEqual(run(['<div style={{ padding: 12, lineHeight: 1.5 }}>', "const s = { borderRadius: '5px' };", '<Chart options={{ padding: 12 }} />', '<Box sx={{ padding: 2 }}>'], {}), [
    'padding: 12 is written by hand; use var(--space-3)',
    'borderRadius: 5px is not a radius of the design system; the nearest is var(--radius-md) (6px)',
  ]);
});

test('the hook: a UI edit in a parity project, with an opt-out; everything else passes silently', () => {
  const dir = makeFixture({
    'ds-config.json': { paths: { themeCSS: 'src/theme.css' } },
    'src/theme.css': theme,
    'contracts/catalog.json': catalog,
    'src/pages/Filters.jsx': '<Chip size="md" />\n<span style={{ color: "#1b2433" }}>x</span>\n',
    'src/ui.html': '<p style="color: #ff00aa">x</p>\n',
    'src/ui.src.html': '<p>x</p>\n',
    'notes.md': 'color: #ff00aa\n',
  });
  const write = (file) => ({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, file), content: '<Chip size="md" />\n<span style={{ color: "#1b2433" }}>x</span>\n' } });
  const r = editCheck(write('src/pages/Filters.jsx'), { root: dir, cfg: { paths: { themeCSS: 'src/theme.css' } }, headOf: () => null });
  assert.match(r, /2 things it added the system does not have/);
  assert.match(r, /Filters\.jsx:1  size="md" is not a value this prop takes; write size="M"/);
  assert.match(r, /Filters\.jsx:2  #1b2433 is written by hand; use var\(--text-primary\)/);
  assert.match(r, /--query <name>/);
  assert.equal(editCheck(write('src/pages/Filters.jsx'), { root: dir, cfg: { editCheck: false } }), null);
  assert.equal(editCheck(write('src/pages/Filters.jsx'), { root: dir, cfg: { hooks: false } }), null);
  assert.equal(editCheck(write('notes.md'), { root: dir, cfg: {} }), null);                         // not a UI file
  assert.equal(editCheck(write('src/ui.html'), { root: dir, cfg: {}, headOf: () => null }), null);  // built from ui.src.html
  // Nothing added: an edit that only removed lines.
  assert.equal(editCheck({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/pages/Filters.jsx'), old_string: 'a\nb', new_string: 'a' } }, { root: dir, cfg: {} }), null);
  // Through the guard, as Claude Code runs it: the reason goes back to the agent.
  const out = spawnSync(process.execPath, [join(ENGINE, 'guard.mjs')], { input: JSON.stringify(write('src/pages/Filters.jsx')), encoding: 'utf8' });
  assert.equal(out.status, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /size="md" is not a value this prop takes/);
  // No ds-config.json: not a parity project, nothing to say.
  const plain = makeFixture({ 'a.css': '.x{color:#fff}' });
  const none = spawnSync(process.execPath, [join(ENGINE, 'guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: plain, tool_name: 'Write', tool_input: { file_path: join(plain, 'a.css'), content: '.x{color:#fff}' } }), encoding: 'utf8' });
  assert.equal(none.stdout, '');
});

test('a plain element the edit styled as a declared primitive (I42): the component to write, only on added lines', async () => {
  const { primitiveTable } = await import('../primitives.mjs');
  const primitives = primitiveTable({ primitives: [{ component: 'Text', props: { size: 'medium', color: 'secondary' }, when: { font: 'var(--body-medium)', color: 'var(--text-secondary)' } }] });
  const p = { ...ctx, truth: steeringTruth({ catalog, cssVars: ['--body-medium', '--text-secondary'] }), primitives, rules: new Map([['hint', new Map([['font', 'var(--body-medium)'], ['color', 'var(--text-secondary)']])]]) };
  const full = '<span class="hint">old</span>\n<p style="font: var(--body-medium); color: var(--text-secondary)">new</p>\n<span class="hint">new</span>';
  const added = full.split('\n').slice(1);
  assert.deepEqual(editFindings(added, full, p).map((f) => `${f.line}: ${f.text}`), [
    '2: <p> styled by hand is the system\'s <Text size="medium" color="secondary">; use the component',
    '3: <span> styled by hand is the system\'s <Text size="medium" color="secondary">; use the component',
  ]);
  assert.deepEqual(editFindings(added, full, { ...p, primitives: [] }), []);
  assert.deepEqual(editFindings(['.hint { font: var(--body-medium) }'], '.hint { font: var(--body-medium) }', p, { sheet: true }), []);
});
