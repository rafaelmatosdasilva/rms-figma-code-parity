// Stage 4: the deeper accessibility checks. One small page breaks each rule once; the check must
// name each problem, and leave the parts that are fine alone. Browser cases need Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture, runGate } from './helpers.mjs';
import { contractSemantics, sameRole, A11Y_GUIDE, groupSame, a11yItemLine } from '../a11y-check.mjs';
import { stateContrastFindings, tokenContrastFindings } from '../contrast-check.mjs';
import { deriveContrastPairs } from '../pair-derive.mjs';
import { findChrome } from '../cdp.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome({ playwright: true });
const HAS_CHROME = !!CHROME && typeof WebSocket !== 'undefined';

test('semantics: the contract names a role by element or aria, and Chrome role names are matched', () => {
  const dir = makeFixture({ 'contract.authored.json': { components: { Chip: { semantics: { element: 'button' } }, Menu: { semantics: { element: 'div', aria: { role: 'menu' } } }, Pic: { semantics: { element: 'img' } } } } });
  assert.deepEqual(contractSemantics(dir), { Chip: 'button', Menu: 'menu', Pic: 'img' });
  assert.equal(sameRole('image', 'img'), true);
  assert.equal(sameRole('generic', 'button'), false);
  for (const k of ['target', 'tabtrap', 'tabindex', 'escape', 'motion', 'forcedfocus', 'spacing', 'reflow', 'semantics']) assert.ok(A11Y_GUIDE[k]?.fix, k);
});

test('token contrast: see-through text is blended, disabled pairs and see-through backgrounds are left out', () => {
  const r = tokenContrastFindings([{ text: 't', bg: 'b' }, { text: 'x', bg: 'glass' }], (n) => ({ t: '#00000040', b: '#ffffff', x: '#000000', glass: '#ffffff80' }[n]));
  assert.equal(r.checked, 1);
  assert.equal(r.findings[0].ratio < 4.5, true);            // 25% black on white is faint, not 21:1
  const names = ['card/text/disabled/color', 'card/background/disabled/color', 'card/border/color', 'card/divider/color', 'card/background/color'];
  assert.deepEqual(deriveContrastPairs(names), []);                                  // borders are opt-in
  const pairs = deriveContrastPairs(names, { boundaries: true });
  assert.deepEqual(pairs.map((p) => p.name), ['card/border/color on card/background/color']);   // never the divider
  assert.equal(pairs[0].large, true);                      // a border needs 3:1
});

test('state contrast: every mode and every produced state, disabled and pageless cases exempt', () => {
  const code = { components: {
    chip: { instance: { hasText: true }, props: { fontSize: { value: '12px' } }, colors: { light: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)' }, dark: { color: 'rgb(90, 90, 90)', backgroundColor: 'rgb(60, 60, 60)' } },
      states: { 'State=Hover': { produced: 'forced :hover', changed: { color: { value: 'rgb(200, 200, 200)' } } }, 'State=Disabled': { produced: 'class .disabled', changed: { color: { value: 'rgb(230, 230, 230)' } } }, 'State=Selected': { produced: 'found an element already in this state (app)', changed: { color: { value: 'rgb(250, 250, 250)' } } } } },
    swatch: { instance: { hasText: false }, colors: { light: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(0, 0, 0)' } } },
  } };
  const r = stateContrastFindings(code);
  assert.deepEqual(r.findings.map((f) => `${f.component}|${f.state}|${f.mode}`), ['chip|default|dark', 'chip|State=Hover|light']);
});

test('page: target size, a positive tabindex, Escape, reduced motion, forced colours, text spacing, semantics', { skip: HAS_CHROME ? false : 'no Chrome available' }, () => {
  const page = `<!doctype html><html><head><style>
    body { font: 14px sans-serif; }
    .tiny { width: 16px; height: 16px; padding: 0; margin: 0; border: 0; }
    .big { width: 40px; height: 40px; }
    .spin { transition: transform 300ms; }
    .shadow:focus { outline: none; box-shadow: 0 0 0 3px #0055ff; }
    .box { height: 18px; overflow: hidden; width: 120px; line-height: 18px; }
    .chip { display: inline-block; }
  </style></head><body>
    <button class="tiny" aria-label="a">a</button><button class="tiny" aria-label="b">b</button>
    <button class="big" tabindex="3">Jump</button>
    <button class="spin">Spin</button>
    <button class="shadow">Shadow focus</button>
    <div class="box">Fits now</div>
    <div class="chip">Chip that is not a button</div>
    <div role="dialog" aria-label="d"><button>Inside</button></div>
  </body></html>`;
  const dir = makeFixture({ 'page.html': page, 'contract.authored.json': { components: { Chip: { semantics: { element: 'button' } } } }, 'ds-config.json': { componentSelectors: { Chip: '.chip' } } });
  let out = '';
  try { out = execFileSync(process.execPath, [join(ENGINE, 'a11y-check.mjs'), '--url', pathToFileURL(join(dir, 'page.html')).href, '--json'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, CHROME_PATH: CHROME } }); }
  catch (e) { out = e.stdout ?? ''; }
  const d = JSON.parse(out.slice(out.indexOf('{')));
  const kinds = (k) => d.issues.filter((i) => i.issue === k).map((i) => i.selector);
  assert.equal(kinds('target').length, 2, out);                               // both 16×16 buttons, 16px apart
  assert.ok(kinds('tabindex').some((s) => s.startsWith('button')), out);
  assert.ok(kinds('escape').length === 1, out);
  assert.ok(kinds('motion').some((s) => /spin/.test(s)), out);
  assert.ok(kinds('forcedfocus').some((s) => /button/.test(s)), out);           // a shadow-only focus ring
  assert.ok(kinds('spacing').some((s) => /box/.test(s)), out);
  assert.deepEqual(d.issues.filter((i) => i.issue === 'semantics').map((i) => [i.rendered, i.contract]), [['generic', 'button']], out);
});

test('tints: same-colour token pairs are not comparable; a see-through background is blended over its backdrop', async () => {
  const { backdropOf } = await import('../component-capture.mjs');
  const t = tokenContrastFindings([{ text: 'l', bg: 'b', name: 'tag label on tag bg' }], (n) => ({ l: '#c20000', b: '#c20000' }[n]));
  assert.deepEqual([t.checked, t.findings.length, t.sameColour.map((x) => x.name)], [0, 0, ['tag label on tag bg']]);
  assert.equal(backdropOf(['rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']), 'rgb(128, 128, 128)');
  assert.equal(backdropOf([]), null);
  const code = { components: { tag: { instance: { hasText: true }, props: { fontSize: { value: '12px' } },
    colors: { light: { color: 'rgb(194, 0, 0)', backgroundColor: 'color(srgb 0.76 0 0 / 0.12)', backdrop: 'rgb(255, 255, 255)' }, dark: { color: 'rgb(194, 0, 0)', backgroundColor: 'rgba(194, 0, 0, 0.12)' } } } } };
  const r = stateContrastFindings(code);
  assert.equal(r.checked, 1);                                   // dark has no backdrop: skipped, not guessed
  assert.equal(r.findings.length, 0);                           // red text on a 12% red tint over white passes
});

test('the same element failing the same way in many places is one finding with a count', () => {
  const f = (text) => ({ kind: 'contrast', desc: 'button in .seg', theme: 'Dark', ratio: 2.02, threshold: 4.5, text });
  const g = groupSame([f('a'), f('b'), f('c'), f('d'), { ...f('e'), ratio: 3 }]);
  assert.equal(g.length, 2);
  assert.equal(g[0].places, 4);
  assert.match(a11yItemLine('contrast', g[0]), /"a", "b", "c".*in 4 places/);
  assert.equal(g[1].places, 1);
});

test('keyboard, zoom, focus hidden or thin, and Figma annotations', { skip: HAS_CHROME ? false : 'no Chrome available' }, () => {
  const page = `<!doctype html><html><head><style>
    body { font: 14px sans-serif; margin: 0; }
    header { position: fixed; top: 0; left: 0; right: 0; height: 120px; background: #fff; z-index: 9; }
    .under { position: absolute; top: 20px; left: 10px; }
    main { margin-top: 140px; }
    .zbox { width: 50vw; height: 18px; overflow: hidden; line-height: 18px; }
    .thin:focus { outline: 1px solid #000; }
    .fake, .good { display: inline-block; padding: 8px; }
  </style></head><body>
    <header>Sticky</header><button class="under">Under the header</button>
    <main>
      <div role="button" tabindex="0" class="fake">Fake</div>
      <div role="button" tabindex="0" class="good" onkeydown="if (event.key === 'Enter' || event.key === ' ') this.click()">Good</div>
      <div role="radiogroup" class="rg" aria-label="r"><div role="radio" tabindex="0" aria-checked="true">A</div><div role="radio" tabindex="-1" aria-checked="false">B</div></div>
      <div class="zbox">A sentence long enough to fit on one line at full width but not at double zoom</div>
      <button class="thin">Thin ring</button>
      <div class="chip">Chip</div>
    </main>
  </body></html>`;
  const dir = makeFixture({ 'page.html': page, 'figma-component-props.snapshot.json': { chip: { nodeId: '1:2', annotations: [{ label: 'Role: button' }] } }, 'ds-config.json': { componentSelectors: { chip: '.chip' } } });
  let out = '';
  try { out = execFileSync(process.execPath, [join(ENGINE, 'a11y-check.mjs'), '--url', pathToFileURL(join(dir, 'page.html')).href, '--json'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, CHROME_PATH: CHROME } }); }
  catch (e) { out = e.stdout ?? ''; }
  const d = JSON.parse(out.slice(out.indexOf('{')));
  const kinds = (k) => d.issues.filter((i) => i.issue === k).map((i) => i.selector);
  assert.ok(kinds('activate').includes('div.fake [role=button] (Enter)'), out);
  assert.ok(!kinds('activate').some((x) => /good/.test(x)), out);            // handles the keys
  assert.equal(kinds('arrows').length, 1, out);
  assert.ok(kinds('obscured').some((s) => /under/.test(s)), out);
  assert.ok(kinds('zoom').some((s) => /zbox/.test(s)), out);
  assert.deepEqual(kinds('focusthin'), ['button'], out);                     // not the browser's own ring
  assert.deepEqual(kinds('annotation'), ['chip: Figma says role "button", it renders as "generic"'], out);
});

test('annotations: role, name, heading level and alt text are read from the note; other notes stay notes', async () => {
  const { annotationFacts, annotationMismatches, axeIntact, fileFromTgz } = await import('../a11y-check.mjs');
  assert.deepEqual(annotationFacts([{ label: 'Role: button. aria-label: Close dialog' }]), { role: 'button', name: 'Close dialog' });
  assert.deepEqual(annotationFacts([{ label: 'Heading level 2' }]), { level: 2, role: 'heading' });
  assert.deepEqual(annotationFacts([{ label: 'Alt text: Sales chart' }]), { name: 'Sales chart', role: 'img' });
  assert.deepEqual(annotationFacts([{ label: 'Icon can change depending on the feature' }]), {});
  assert.deepEqual(annotationMismatches({ level: 2, role: 'heading' }, { role: 'heading', level: 3 }), ['Figma says heading level 2, it renders as level 3']);
  // axe is only ever run when it matches the pinned hash.
  assert.equal(axeIntact('axe.run = () => {}'), false);
  const { gzipSync } = await import('node:zlib');
  const header = Buffer.alloc(512); header.write('package/axe.min.js'); header.write('00000000005\0', 124);
  const tgz = gzipSync(Buffer.concat([header, Buffer.from('hello'.padEnd(512, '\0')), Buffer.alloc(1024)]));
  assert.equal(fileFromTgz(tgz, 'package/axe.min.js'), 'hello');
});

test('annotations in Portuguese, composite roles, notes on inner layers; verifiable notes need no Gate 10g entry', async () => {
  const { annotationFacts, annotationMismatches, annotationFactsFor } = await import('../a11y-check.mjs');
  assert.deepEqual(annotationFacts([{ label: 'Papel: botão. Rótulo: Fechar diálogo' }]), { role: 'button', name: 'Fechar diálogo' });
  assert.deepEqual(annotationFacts([{ label: 'Título nível 2' }]), { level: 2, role: 'heading' });
  assert.deepEqual(annotationFacts([{ label: 'Texto alternativo: Gráfico de vendas' }]), { name: 'Gráfico de vendas', role: 'img' });
  assert.deepEqual(annotationFacts([{ label: 'role:togglebutton' }]), { role: 'button', pressed: true });
  assert.deepEqual(annotationFacts([{ label: 'Papel: caixa de seleção' }]), { role: 'checkbox' });
  assert.deepEqual(annotationMismatches({ role: 'button', pressed: true }, { role: 'button' }), ['Figma says it is a toggle button, it has no aria-pressed']);
  assert.deepEqual(annotationMismatches({ role: 'button', pressed: true }, { role: 'button', pressed: 'false' }), []);
  const dir = makeFixture({ 'figma-component-props.snapshot.json': { chip: { nodeId: '1:2', annotations: [{ label: 'O ícone muda conforme a funcionalidade' }], layerAnnotations: [{ layer: 'Label', annotations: [{ label: 'Rótulo: Remover filtro' }] }] } } });
  assert.deepEqual(annotationFactsFor(dir), { chip: { facts: {}, layers: [{ layer: 'Label', facts: { name: 'Remover filtro' } }] } });
});

test('Gate 10g: a note the accessibility check verifies passes without a contract entry; prose still needs one', () => {
  const r = runGate('structure-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css', snapshotStructure: 's.json', pluginCSS: ['app.css'], compPropsSnapshot: 'props.json' } },
    's.json': { components: { chip: {} } },
    'app.css': '.chip {}',
    'theme.css': ':root {}',
    'structure-contract.mjs': "export const CONTRACT = { chip: {} };\nexport const COMPONENT_CSS_SELECTORS = { chip: { main: '.chip' } };\nexport const FIGMA_LAYOUT_TO_CSS = {};",
    'props.json': { chip: { nodeId: '1:2', properties: {}, annotations: [{ label: 'Papel: botão' }, { label: 'Only on wide screens' }] } },
  });
  assert.match(r.out, /"Papel: botão" is checked by the accessibility check|1\/2 Figma annotation/, r.out);
  assert.match(r.out, /annotation "Only on wide screens" not acknowledged/, r.out);
});

test('annotations in the browser: a toggle button without aria-pressed, and a note on an inner layer', { skip: HAS_CHROME ? false : 'no Chrome available' }, () => {
  const page = `<!doctype html><html><body>
    <button class="fav" aria-label="Favorito"><span class="lbl" aria-label="Salvar">★</span></button>
  </body></html>`;
  const dir = makeFixture({
    'page.html': page,
    'figma-component-props.snapshot.json': { fav: { nodeId: '1:2', annotations: [{ label: 'role:togglebutton' }], layerAnnotations: [{ layer: 'Icon', annotations: [{ label: 'Rótulo: Favoritar' }] }, { layer: 'Badge', annotations: [{ label: 'Role: status' }] }] } },
    'structure-contract.mjs': "export const CONTRACT = { fav: { children: [{ name: 'Icon', cssSelector: '.fav .lbl' }] } };",
    'ds-config.json': { componentSelectors: { fav: '.fav' } },
  });
  let out = '';
  try { out = execFileSync(process.execPath, [join(ENGINE, 'a11y-check.mjs'), '--url', pathToFileURL(join(dir, 'page.html')).href, '--json'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, CHROME_PATH: CHROME } }); }
  catch (e) { out = e.stdout ?? ''; }
  const d = JSON.parse(out.slice(out.indexOf('{')));
  const got = d.issues.filter((i) => i.issue === 'annotation').map((i) => i.selector);
  assert.ok(got.includes('fav: Figma says it is a toggle button, it has no aria-pressed'), out);
  assert.ok(got.some((x) => /^fav › Icon: Figma says its name is "Favoritar", it is announced as "Salvar"/.test(x)), out);
  assert.ok(got.some((x) => /^fav › Badge: not checked, the contract has no part named "Badge"/.test(x)), out);
});
