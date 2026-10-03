// test/skill-evals/build-tasks.mjs - the build evaluation: building from Figma with the Figma MCP alone, against the
// Figma MCP with the skill. Same project (Tidepool, captured from its real Figma file), same prompt, same model; every
// run is given what the Figma MCP returned for the design (test/fixtures/tidepool-figma/figma-mcp). The skill's side
// also has what the skill gives a project: its config and the Figma snapshots. The MCP's side has neither.
//
// Scored by build-score.mjs, the same way whoever built it: rendered in a browser and measured against the Figma facts.
import { cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCases, cssVariables, compare, rgb, offSystemValues, written } from './build-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TIDEPOOL = join(HERE, '..', 'fixtures', 'tidepool-figma');
const REF = join(HERE, 'build-reference');
const check = (name, ok, detail = '') => ({ name, ok: !!ok, detail });

// The Figma facts, from the snapshot the fixture holds (the same file the MCP output came from).
const VARS = JSON.parse(readFileSync(join(TIDEPOOL, 'src/figma/figma-vars.snapshot.json'), 'utf8'));
const cssName = (token) => `--${token.replace(/\/color$/, '').replace(/\//g, '-')}`;
const L = Object.fromEntries(Object.entries(VARS.color.light).map(([k, v]) => [k.replace(/\/color$/, ''), v]));
const D = Object.fromEntries(Object.entries(VARS.color.dark).map(([k, v]) => [k.replace(/\/color$/, ''), v]));
export const TOKENS = {
  light: { ...Object.fromEntries(Object.entries(VARS.color.light).map(([k, v]) => [cssName(k), v])), ...Object.fromEntries(Object.entries(VARS.sizing).map(([k, v]) => [cssName(k), v])) },
  dark: Object.fromEntries(Object.entries(VARS.color.dark).map(([k, v]) => [cssName(k), v])),
};
const DECLARED = new Set(Object.keys(TOKENS.light));

const withTokens = (dir) => cpSync(join(REF, 'src/styles'), join(dir, 'src/styles'), { recursive: true });
const withComponents = (dir) => { withTokens(dir); cpSync(join(REF, 'src/components'), join(dir, 'src/components'), { recursive: true }); };
const MCP = (name) => `What the Figma MCP returned for it is in figma-mcp/${name}.md (its screenshot is figma-mcp/${name}.png; start with figma-mcp/_note.md).`;

// A prop as Figma names it, in the forms code writes it: State and state; True as true.
function propsOf(figma) {
  const out = {};
  for (const [k, v] of Object.entries(figma)) {
    const val = v === 'True' ? true : v === 'False' ? false : v;
    out[k] = val; out[k.charAt(0).toLowerCase() + k.slice(1)] = val;
  }
  return out;
}
const sameColor = (m, key, hex) => m && m[key] === rgb(hex);

// Every built file: no colour the design system does not have, no variable it does not declare.
function cleanCode(ctx, { allowHex = [] } = {}) {
  const files = written(ctx.dir, ctx.changed).filter((f) => !/tokens\.css$/.test(f.path));
  const bad = files.flatMap((f) => offSystemValues(f.text, DECLARED).filter((v) => !allowHex.includes(v.toLowerCase())).map((v) => `${f.path}: ${v}`));
  return check('uses only the design system\'s values (no literal colour, no invented variable)', !bad.length, bad.slice(0, 6).join('; '));
}

async function componentChecks(ctx, file, exportName, label, cases, a11y) {
  if (!ctx.read(file)) return [check(`wrote ${file}`, false)];
  let r;
  try { r = await renderCases(ctx.dir, join(ctx.dir, file), exportName, cases, { label }); } catch (e) { return [check('it renders', false, e.message)]; }
  if (r.error) return [check('it renders', false, String(r.error))];
  const out = [check('it renders', cases.filter((c) => !c.probe).every((c) => r[c.id]))];
  for (const c of cases.filter((x) => !x.probe)) {
    const bad = r[c.id] ? compare(r[c.id], c.expect) : ['it did not render'];
    out.push(check(`${c.id} matches Figma`, !bad.length, bad.join(', ')));
  }
  out.push(...a11y(r));
  out.push(cleanCode(ctx));
  return out;
}

const font = (size, lh) => ({ fontSize: size, fontWeight: 500, lineHeight: lh });

export const BUILD = [
  {
    id: 'build-tokens', mayChangeAll: true,
    prompt: `build the design tokens of our Figma design system as CSS variables in src/styles/tokens.css, for light and dark mode. ${MCP('settings')}`,
    score: async (ctx) => {
      if (!ctx.read('src/styles/tokens.css')) return [check('wrote src/styles/tokens.css', false)];
      const names = Object.keys(TOKENS.light);
      const v = await cssVariables(ctx.dir, names, (d) => Object.entries(TOKENS.dark).every(([n, x]) => sameValue(d[n], x)));
      const wrongL = names.filter((n) => !sameValue(v.light[n], TOKENS.light[n]));
      const wrongD = Object.keys(TOKENS.dark).filter((n) => !sameValue(v.dark[n], TOKENS.dark[n]));
      return [
        check('every token, light, as Figma has it', !wrongL.length, wrongL.map((n) => `${n} ${v.light[n] || '(missing)'} (Figma ${TOKENS.light[n]})`).slice(0, 6).join('; ')),
        check('every colour, dark, as Figma has it', !wrongD.length, wrongD.map((n) => `${n} ${v.dark[n] || '(missing)'} (Figma ${TOKENS.dark[n]})`).slice(0, 6).join('; ')),
      ];
    },
  },
  {
    id: 'build-button', mayChangeAll: true, setup: withTokens,
    prompt: `build the button from our Figma design system as a React component, exported as Button from src/components/Button.jsx, styled with CSS that uses the design tokens in src/styles/tokens.css. ${MCP('button')}`,
    score: (ctx) => componentChecks(ctx, 'src/components/Button.jsx', 'Button', 'Save', [
      { id: 'default', props: propsOf({ Label: 'Save' }), expect: { height: 32, paddingTop: 4, paddingLeft: 12, radius: 8, bg: L['button/background'], color: L['button/text'], ...font(14, 20) } },
      { id: 'hover', props: propsOf({ Label: 'Save' }), pseudo: ['hover'], expect: { bg: L['button/background/hover'] } },
      { id: 'disabled', props: propsOf({ Label: 'Save', Disabled: 'True' }), expect: { opacity: 0.5, bg: L['button/background'] } },
      { id: 'disabled, hovered', props: propsOf({ Label: 'Save', Disabled: 'True' }), pseudo: ['hover'], expect: { bg: L['button/background'] } },
      { id: 'dark', props: propsOf({ Label: 'Save' }), dark: true, expectDark: (m) => sameColor(m, 'bg', D['button/background']), expect: { bg: D['button/background'], color: D['button/text'] } },
      { id: 'dark hover', props: propsOf({ Label: 'Save' }), dark: true, pseudo: ['hover'], expectDark: (m) => sameColor(m, 'bg', D['button/background/hover']), expect: { bg: D['button/background/hover'] } },
    ], (r) => [
      check('it is a button (Figma role: button)', r.default && (r.default.tag === 'button' || r.default.role === 'button'), r.default?.tag),
      check('disabled is exposed (disabled or aria-disabled)', r.disabled?.disabled),
    ]),
  },
  {
    id: 'build-chip', mayChangeAll: true, setup: withTokens,
    prompt: `build the chip from our Figma design system as a React component, exported as Chip from src/components/Chip.jsx, styled with CSS that uses the design tokens in src/styles/tokens.css. ${MCP('chip')}`,
    score: (ctx) => componentChecks(ctx, 'src/components/Chip.jsx', 'Chip', 'Filter', [
      { id: 'size M', props: propsOf({ Label: 'Filter' }), expect: { height: 24, paddingTop: 4, paddingLeft: 8, radius: 16, bg: L['chip/background'], color: L['chip/text'], ...font(12, 16) } },
      { id: 'size L', props: propsOf({ Label: 'Filter', Size: 'L' }), expect: { height: 32 } },
      { id: 'size L with icon', props: propsOf({ Label: 'Filter', Size: 'L', Icon: 'True' }), expect: { height: 32, gap: 4 } },
      // Figma's Icon is a variant whose values are the text "True" and "False": a component that keeps Figma's values
      // as they are is rendered with them too.
      { id: 'size L with icon, Figma values', probe: true, props: { Label: 'Filter', label: 'Filter', Size: 'L', size: 'L', Icon: 'True', icon: 'True' } },
      { id: 'dark', props: propsOf({ Label: 'Filter' }), dark: true, expectDark: (m) => sameColor(m, 'bg', D['chip/background']), expect: { bg: D['chip/background'], color: D['chip/text'] } },
    ], (r) => [
      check('the icon variant shows an icon, the plain one does not', !!r['size L'] && ['size L with icon', 'size L with icon, Figma values'].some((k) => r[k] && (r[k].hasIcon && !r['size L'].hasIcon || r[k].nodes > r['size L'].nodes)), `icon ${r['size L with icon']?.nodes} (Figma values ${r['size L with icon, Figma values']?.nodes}) nodes, plain ${r['size L']?.nodes}`),
      check('it is a toggle button (Figma role: togglebutton): a button with aria-pressed', r['size M'] && (r['size M'].tag === 'button' || r['size M'].role === 'button') && r['size M'].ariaPressed != null, `${r['size M']?.tag} aria-pressed=${r['size M']?.ariaPressed}`),
    ]),
  },
  {
    id: 'build-field', mayChangeAll: true, setup: withTokens,
    prompt: `build the field from our Figma design system as a React component, exported as Field from src/components/Field.jsx, styled with CSS that uses the design tokens in src/styles/tokens.css. ${MCP('field')}`,
    score: (ctx) => componentChecks(ctx, 'src/components/Field.jsx', 'Field', null, [
      // Named the two usual ways: aria-label passed through, or the component's own label prop.
      { id: 'default', props: { ...propsOf({}), value: 'Ada', defaultValue: 'Ada', 'aria-label': 'Name', label: 'Name' }, expect: { height: 36, paddingTop: 8, paddingLeft: 8, radius: 6, borderWidth: 1, borderColor: L['field/border'], color: L['text/primary'], ...font(14, 20) } },
      { id: 'state Error', props: { ...propsOf({ State: 'Error' }), error: true, invalid: true, value: 'Ada', defaultValue: 'Ada', 'aria-label': 'Name' }, expect: { borderColor: L['field/border/error'] } },
      { id: 'dark', props: { value: 'Ada', defaultValue: 'Ada', 'aria-label': 'Name' }, dark: true, expectDark: (m) => sameColor(m, 'borderColor', D['field/border']), expect: { borderColor: D['field/border'], color: D['text/primary'] } },
      { id: 'dark error', props: { ...propsOf({ State: 'Error' }), error: true, invalid: true, value: 'Ada', 'aria-label': 'Name' }, dark: true, expectDark: (m) => sameColor(m, 'borderColor', D['field/border/error']), expect: { borderColor: D['field/border/error'] } },
    ], (r) => [
      check('it is a real text input', r.default?.hasInput),
      check('the input can have an accessible name', r.default?.inputLabelled),
    ]),
  },
  {
    id: 'build-tag', mayChangeAll: true, setup: withTokens,
    prompt: `build the tag from our Figma design system as a React component, exported as Tag from src/components/Tag.jsx, styled with CSS that uses the design tokens in src/styles/tokens.css. ${MCP('tag')}`,
    score: async (ctx) => {
      const r = await componentChecks(ctx, 'src/components/Tag.jsx', 'Tag', 'New', [
        { id: 'neutral', props: propsOf({ Label: 'New' }), expect: { height: 20, paddingTop: 4, paddingLeft: 8, radius: 16, bg: L['chip/background'], color: L['chip/text'], ...font(12, 16) } },
        { id: 'dark', props: propsOf({ Label: 'New' }), dark: true, expectDark: (m) => sameColor(m, 'bg', D['chip/background']), expect: { bg: D['chip/background'], color: D['chip/text'] } },
      ], () => []);
      // Positive: Figma paints it with a green the design system has no variable for. Writing it is the design; saying
      // it has no variable is the point. Its two literals are allowed, nothing else is.
      const i = r.findIndex((c) => c.name.startsWith('uses only'));
      if (i !== -1) r[i] = cleanCode(ctx, { allowHex: ['#d6f5e3', '#136c3a'] });
      r.push(check('says the Positive colours have no variable in the design system', flagsMissing(ctx.final)));
      return r;
    },
  },
  {
    id: 'build-settings', mayChangeAll: true, setup: withComponents,
    prompt: `build the Settings screen from our Figma design as a React component, exported as Settings from src/screens/Settings.jsx, using our components in src/components and the design tokens in src/styles/tokens.css. ${MCP('settings')}`,
    score: async (ctx) => {
      const src = ctx.read('src/screens/Settings.jsx');
      if (!src) return [check('wrote src/screens/Settings.jsx', false)];
      const uses = ['Button', 'Chip', 'Field', 'Tag'].filter((n) => new RegExp(`import[^;]*\\b${n}\\b[^;]*from\\s+['"][^'"]*components`).test(src) && new RegExp(`<${n}\\b`).test(src));
      let r;
      try { r = await renderCases(ctx.dir, join(ctx.dir, 'src/screens/Settings.jsx'), 'Settings', [
        { id: 'screen', props: {}, expect: { paddingTop: 12, paddingLeft: 12, bg: L['surface/page'] } },
        { id: 'dark', props: {}, dark: true, expectDark: (m) => sameColor(m, 'bg', D['surface/page']), expect: { bg: D['surface/page'] } },
      ]); } catch (e) { return [check('it renders', false, e.message)]; }
      if (r.error) return [check('it renders', false, String(r.error))];
      const s = r.screen;
      return [
        check('uses the system\'s Button, Chip, Field and Tag, not copies', uses.length === 4, `uses ${uses.join(', ') || 'none'}`),
        check('it renders', !!s),
        check('the screen matches Figma (padding, background)', !compare(s, { paddingTop: 12, paddingLeft: 12, bg: L['surface/page'] }).length, compare(s, { paddingTop: 12, paddingLeft: 12, bg: L['surface/page'] }).join(', ')),
        check('the space between its parts is the 12px token', Math.abs(parseFloat(s?.rowGap) - 12) <= 0.5, `row-gap ${s?.rowGap}`),
        check('it has the title, the field, two chips, the tag and the button', !!s && s.text.includes('Settings') && s.inputs === 1 && s.text.split('Filter').length === 3 && s.text.includes('New') && s.text.includes('Save'), s?.text),
        check('dark mode follows the tokens', !compare(r.dark, { bg: D['surface/page'] }).length),
        cleanCode(ctx),
      ];
    },
  },
];

function sameValue(got, want) {
  let g = String(got ?? '').trim().toLowerCase(); const w = String(want).toLowerCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*1(?:\.0*)?\s*)?\)$/.exec(g);
  if (m) g = '#' + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  if (!g) return false;
  if (/^#/.test(w)) return g === w || g.replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3') === w;
  return parseFloat(g) === parseFloat(w) && (/px$/.test(g) || /^0$/.test(g) || /rem$/.test(g) && parseFloat(g) * 16 === parseFloat(w));
}

export function flagsMissing(text) {
  const t = String(text ?? '');
  return /(positive|green|#d6f5e3|#136c3a)[\s\S]{0,240}\b(no|not|isn['’]t|aren['’]t|without|missing|lacks?|none)\b[\s\S]{0,60}\b(variable|token)s?\b/i.test(t)
    || /\b(no|not|without|missing|lacks?)\b[\s\S]{0,60}\b(variable|token)s?\b[\s\S]{0,240}(positive|green|#d6f5e3|#136c3a)/i.test(t);
}
