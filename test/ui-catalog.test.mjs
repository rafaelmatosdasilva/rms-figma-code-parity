// ui-catalog.mjs + ui-check.mjs: the component catalog for UI generators, and the checker for what
// they generate. Made-up components.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, catalogTable, checkUi } from '../ui-catalog.mjs';
import { makeFixture } from './helpers.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const built = [
  { name: 'Card', contract: { description: 'A surface.', props: [{ name: 'Elevated', type: 'boolean', default: false }], relationships: { composesWith: ['Badge'], neverCombineWith: ['Card'] } } },
  { name: 'Badge', contract: { description: 'A label.', props: [{ name: 'State', type: 'enum', options: ['default', 'hover'] }, { name: 'Tone', type: 'enum', options: ['info', 'warn'], default: 'info', bindings: { code: { attribute: 'tone' } } }, { name: 'Text', type: 'text' }] } },
  { name: 'OldChip', contract: { description: 'Old.', props: [], status: { state: 'deprecated' }, useInstead: ['Badge'] } },
];
const code = { api: { Card: { props: { elevated: {} } } }, nesting: { Card: { contains: { Button: { renderedIn: ['app'] } } } } };
const catalog = buildCatalog(built, { code, selectorFor: (n) => '.' + n.toLowerCase() });

test('catalog: props with values and code names, children, status; interaction states left out', () => {
  assert.deepEqual(catalog.components.Badge.props, { Tone: { type: 'enum', values: ['info', 'warn'], default: 'info', codeName: 'tone' }, Text: { type: 'text' } });
  assert.deepEqual(catalog.components.Card.props.Elevated, { type: 'boolean', default: false, codeName: 'elevated' });
  assert.deepEqual(catalog.components.Card.children, ['Badge']);   // Button is not a catalog component
  assert.equal(catalog.components.Card.selector, '.card');
  assert.equal(catalog.components.OldChip.status, 'deprecated');
});

test('catalog: the llms.txt table aligns one component per line', () => {
  const t = catalogTable(catalog).split('\n');
  assert.equal(t[0], '```');
  assert.match(t[2], /^Card\s+Elevated=true\|false\s+contains Badge$/);
  assert.match(t[3], /^Badge\s+Tone=info\|warn  Text=text$/);
  assert.match(t[4], /^OldChip\s+-\s+\[deprecated → Badge\]$/);
});

test('check: a valid flat (A2UI style) surface passes', () => {
  const r = checkUi({ root: 'c', components: [{ id: 'c', component: 'Card', Elevated: true, children: ['b'] }, { id: 'b', component: 'Badge', tone: 'warn', Text: 'Hi' }] }, catalog);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.counts, { components: 2, errors: 0, warnings: 0 });
});

test('check: every rule break is named, nothing is repaired or added', () => {
  const ui = { root: 'c', components: [
    { id: 'c', component: 'Card', Elevated: 'yes', children: ['b', 'x', 'c2'] },
    { id: 'b', component: 'Badge', Tone: 'purple', size: 'l' },
    { id: 'b', component: 'Badge' },
    { id: 'c2', component: 'Card' },
    { id: 'z', component: 'Cards' },
    { id: 'o', component: 'OldChip' },
  ] };
  const before = JSON.stringify(ui);
  const r = checkUi(ui, catalog);
  const msgs = r.findings.map((f) => `${f.rule}:${f.level}:${f.message}`);
  assert.ok(msgs.includes('3:error:Card.Elevated must be true or false, not "yes"'));
  assert.ok(msgs.includes('2:error:Badge.Tone = "purple" is not one of info, warn'));
  assert.ok(msgs.includes('2:error:Badge has no prop "size"'));
  assert.ok(msgs.includes('4:error:id "b" is used more than once'));
  assert.ok(msgs.includes('4:error:child "x" does not exist'));
  assert.ok(msgs.includes('5:error:Card must never contain Card'));
  assert.ok(msgs.includes('1:error:"Cards" is not in the catalog (did you mean Card?)'));
  assert.ok(msgs.includes('1:warning:OldChip is deprecated: use Badge'));
  assert.ok(msgs.includes('4:warning:"z" is not attached to the tree'));
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(ui), before, 'the input is never changed');
});

test('check: nested trees, a missing root and a cycle', () => {
  assert.equal(checkUi({ component: 'Card', children: [{ component: 'Badge', props: { Tone: 'info' } }] }, catalog).ok, true);
  const r = checkUi({ root: 'a', components: [{ id: 'a', component: 'Card', children: ['b'] }, { id: 'b', component: 'Badge', children: ['a'] }] }, catalog);
  assert.ok(r.findings.some((f) => /inside itself/.test(f.message)));
  assert.ok(checkUi({ root: 'nope', components: [] }, catalog).findings.some((f) => /root "nope"/.test(f.message)));
});

test('ui-check command: reads contracts/catalog.json, prints findings, writes the log, exits 1 on errors', () => {
  const dir = makeFixture({ 'contracts/catalog.json': JSON.stringify(catalog), 'gen.json': JSON.stringify({ component: 'Badge', props: { Tone: 'nope' } }) });
  let out, code = 0;
  try { out = execFileSync('node', [join(ENGINE, 'ui-check.mjs'), 'gen.json'], { cwd: dir, encoding: 'utf8' }); }
  catch (e) { out = e.stdout; code = e.status; }
  assert.equal(code, 1);
  assert.match(out, /❌ 1 error\(s\) · 0 warning\(s\)/);
  assert.match(out, /Badge\.Tone = "nope" is not one of info, warn  \(rule 2:/);
  assert.equal(JSON.parse(execFileSync('cat', [join(dir, '.parity-out/ui-check.json')], { encoding: 'utf8' })).counts.errors, 1);
});
