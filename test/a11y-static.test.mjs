// I34: accessibility checks that need no browser. What they find, and the look-alikes they leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markupFindings, cssFindings, styleOnly, staticA11y } from '../a11y-static.mjs';
import { makeFixture } from './helpers.mjs';

const kinds = (xs) => xs.map((x) => [x.line, x.kind]);

test('a control with no accessible name', () => {
  assert.deepEqual(kinds(markupFindings('<button class="x"><svg viewBox="0 0 1 1"/></button>')), [[1, 'name']]);
  assert.deepEqual(kinds(markupFindings('<button aria-label="Close"><svg/></button>')), []);
  assert.deepEqual(kinds(markupFindings('<button type="button"><span aria-hidden="true"></span><span>Save</span></button>')), []);
  assert.deepEqual(kinds(markupFindings('<button onClick={f}>{label}</button>')), []);           // text from a prop
  assert.deepEqual(kinds(markupFindings('<button {...props}><Icon /></button>')), []);           // attributes from outside
  assert.deepEqual(kinds(markupFindings('<button><slot></slot></button>')), []);
  assert.deepEqual(kinds(markupFindings('<button id="go"><span id="frame-name"></span></button>')), []);   // filled by a script
  assert.deepEqual(kinds(markupFindings('<img src="a.png">\n<img src="b.png" alt="">')), [[1, 'name']]);
  assert.deepEqual(kinds(markupFindings('<input type="text">\n<label>Name <input type="text"></label>\n<input id="q"><input type="hidden">')), [[1, 'name']]);
});

test('keyboard and aria mistakes', () => {
  assert.deepEqual(kinds(markupFindings('<a tabindex="3" href="#">x</a>\n<div tabIndex={0}>ok</div>')), [[1, 'keyboard']]);
  assert.deepEqual(kinds(markupFindings('<div onClick={go}>Open</div>\n<div role="button" tabIndex={0} onClick={go}>Open</div>')), [[1, 'keyboard']]);
  assert.deepEqual(kinds(markupFindings('<div @click="go">x</div>')), [[1, 'keyboard']]);
  assert.deepEqual(kinds(markupFindings('<span aria-lable="x" aria-label="y" aria-pressed="false"></span>')), [[1, 'aria']]);
});

test('links, image alts, hidden focusable elements, the page language and zoom', () => {
  assert.deepEqual(kinds(markupFindings('<a href="/x"><svg/></a>\n<a href="/y">Home</a>\n<a href="/z"><img alt="Home" src="h.png"></a>\n<a name="top"></a>')), [[1, 'name']]);
  assert.deepEqual(kinds(markupFindings('<a href="/x" aria-label="Close"><svg/></a>\n<a :href="u">{{ label }}</a>')), []);
  assert.deepEqual(kinds(markupFindings('<button><img src="x.svg" alt="Close"></button>\n<button><svg><title>Close</title></svg></button>')), []);   // named inside
  assert.deepEqual(kinds(markupFindings('<img src="a.png" alt="hero-banner.png">\n<img src="b.png" alt="A harbour at dawn">')), [[1, 'name']]);
  assert.deepEqual(kinds(markupFindings('<button aria-hidden="true">x</button>\n<span aria-hidden="true">x</span>\n<a href="#" aria-hidden="true" tabindex="-1">x</a>\n<div aria-hidden={true} tabIndex={0}>x</div>')), [[1, 'aria'], [4, 'aria']]);
  assert.deepEqual(kinds(markupFindings('<!doctype html>\n<html>\n<p>set it on <html> in prose</p>')), [[2, 'language']]);
  assert.deepEqual(kinds(markupFindings('<!doctype html><html lang="en">\n<p>a <html> in prose is not a page</p>')), []);
  assert.deepEqual(kinds(markupFindings('<meta name="viewport" content="width=device-width, user-scalable=no">\n<meta name="viewport" content="width=device-width, maximum-scale=5">')), [[1, 'zoom']]);
});

test('a page has one main heading (I79); an app shell its scripts fill and a component are not pages', () => {
  const page = (body) => `<!doctype html>\n<html lang="en">\n<body>\n${body}\n</body>\n</html>`;
  assert.deepEqual(kinds(markupFindings(page('<main><button>Save</button></main>'))), [[2, 'heading']]);
  assert.deepEqual(kinds(markupFindings(page('<h1>Orders</h1>\n<h1>Again</h1>'))), [[5, 'heading']]);
  assert.match(markupFindings(page('<h1>Orders</h1>\n<h1>Again</h1>'))[0].desc, /2 main headings/);
  assert.deepEqual(kinds(markupFindings(page('<h1 class="sr-only">Orders</h1><p>x</p>'))), []);
  assert.deepEqual(kinds(markupFindings(page('<div role="heading" aria-level="1">Orders</div>'))), []);
  assert.deepEqual(kinds(markupFindings(page('<div id="root"></div>\n<script type="module" src="/main.js"></script>'))), []);   // an app shell
  assert.deepEqual(kinds(markupFindings(page('<nav>Home</nav>\n{% block content %}{% endblock %}'))), []);                        // a template: its content comes from elsewhere
  assert.deepEqual(kinds(markupFindings('<button>Save</button>')), []);                                                          // a component
  assert.equal(markupFindings(page('<p>x</p>'))[0].fix, 'add one <h1> that names the page (it can be visually hidden)');
});

test('an animation needs a reduced-motion alternative somewhere in the project', () => {
  const run = (files) => staticA11y(makeFixture(files)).findings.filter((f) => f.kind === 'motion').map((f) => `${f.file}:${f.line}`);
  assert.deepEqual(run({ 'a.css': '.x { animation: none; }\n.m {\n  animation: pop 0.2s both;\n}' }), ['a.css:3']);
  assert.deepEqual(run({ 'a.css': '.m { animation: pop 0.2s; }', 'b.css': '@media (prefers-reduced-motion: reduce) { .m { animation: none; } }' }), []);
  assert.deepEqual(run({ 'a.css': '.m { animation: pop 0.2s; }', 'm.js': "matchMedia('(prefers-reduced-motion: reduce)')" }), []);
  assert.deepEqual(run({ 'a.css': '.m { transition: opacity 0.2s; }' }), []);   // a transition is not an animation
});

test('a removed focus outline must be put back somewhere', () => {
  assert.deepEqual(kinds(cssFindings('.btn { outline: none; }')), [[1, 'focus']]);
  assert.deepEqual(kinds(cssFindings('.btn { outline: none; }\n.btn:focus-visible { box-shadow: 0 0 0 2px blue; }')), []);
  assert.deepEqual(kinds(cssFindings('.btn:focus { outline: 0; box-shadow: 0 0 0 2px blue; }')), []);   // replaced in the same rule
  assert.deepEqual(kinds(cssFindings('.field__input { outline: 0; }\n.field:focus-within { border-color: blue; }')), []);   // shown on the field
  assert.deepEqual(kinds(cssFindings('/* .x { outline: none } */\n.y { outline-offset: 2px; }')), []);
  assert.deepEqual(kinds(cssFindings('.b:hover { outline: none; }\n.b:disabled:hover { outline: none; }')), []);   // not focus
  assert.deepEqual(kinds(cssFindings('.searchInput { outline: 0; }\n.searchBox:not(.ro):focus-within { border-color: blue; }')), []);
  assert.deepEqual(kinds(cssFindings('.menu { outline: 0; }\n.card:focus-within { border-color: blue; }')), [[1, 'focus']]);   // an unrelated wrapper
  assert.deepEqual(kinds(cssFindings('.a { outline: none; }', '.a { outline: none; }\n.a:focus-visible { outline: 2px solid; }')), []);   // put back in another file
  assert.deepEqual(kinds(cssFindings('@media (min-width: 1px) {\n  .b { outline: none; }\n}')), [[2, 'focus']]);
});

test('a component file keeps its own line numbers', () => {
  const vue = '<template>\n<div/>\n</template>\n<style>\n.c { outline: none; }\n</style>\n';
  assert.deepEqual(kinds(cssFindings(styleOnly(vue))), [[5, 'focus']]);
});

test('the whole project: files found on their own, build output and dependencies skipped', () => {
  const dir = makeFixture({
    'src/Icon.jsx': 'export const X = () => <button><svg/></button>;',
    'src/theme.css': '.btn { outline: none; }',
    'node_modules/pkg/a.html': '<img src="x">',
    'dist/app.html': '<img src="x">',
  });
  const r = staticA11y(dir);
  assert.deepEqual(r.findings.map((f) => [f.file, f.kind]).sort(), [['src/Icon.jsx', 'name'], ['src/theme.css', 'focus']]);
});

test('a name written after a spread replaces the one the caller passes; before it, or falling back, it does not', () => {
  const after = 'export function Field({ label, ...inputProps }) {\n  return (\n    <input\n      type="text"\n      {...inputProps}\n      onChange={(e) => change(e)}\n      aria-label={label}\n    />\n  );\n}';
  const f = markupFindings(after).filter((x) => /after \{\.\.\.inputProps\}/.test(x.desc));
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 3);
  assert.match(f[0].desc, /aria-label=\{label\} after \{\.\.\.inputProps\} replaces the aria-label the caller passes/);
  assert.match(f[0].fix, /put aria-label before the spread/);
  for (const ok of ['<input aria-label={label} {...inputProps} />', '<input {...rest} aria-label={label ?? rest["aria-label"]} />', '<input {...rest} aria-label="Search" />'])
    assert.deepEqual(markupFindings(ok).filter((x) => /after \{\.\.\./.test(x.desc)), [], ok);
});
