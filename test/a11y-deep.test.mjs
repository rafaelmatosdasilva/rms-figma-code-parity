// Stage 4: the deeper accessibility checks. One small page breaks each rule once; the check must
// name each problem, and leave the parts that are fine alone. Browser cases need Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture } from './helpers.mjs';
import { contractSemantics, sameRole, A11Y_GUIDE } from '../a11y-check.mjs';
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
