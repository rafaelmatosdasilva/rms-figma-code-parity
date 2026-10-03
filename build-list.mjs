// build-list.mjs - what is left to build in a project that starts from Figma (build mode, ds-config.json → build: true).
//
// The engine never writes the code. In build mode it says, in order, what Figma has that the code does not yet:
//   • the tokens, first: every Figma variable with no CSS declaration, written out exactly as the theme CSS should
//     declare it (name, value, and the block for each mode), in .design-system-engine-out/handback/tokens-to-build.css,
//     for the agent or a person to copy into the theme. Gate [3] then proves each one.
//   • then the components, each after the ones it nests (a button before the card that holds it).
// A component or token still to build is never a failure; once it is built it is compared as usual.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { inProgressList } from './in-progress.mjs';
import { OUT_DIR } from './names.mjs';

export const isBuildMode = (cfg) => cfg?.build === true;
export const TOKENS_TO_BUILD = `${OUT_DIR}/handback/tokens-to-build.css`;

// The block a mode's declarations go in, from its cssSelector in ds-config.json → figma.modes.
export function modeBlock(cssSelector = 'root') {
  const s = String(cssSelector);
  if (s === 'root') return { open: ':root {', close: '}' };
  if (s === 'dark-media') return { open: '@media (prefers-color-scheme: dark) {\n  :root {', close: '  }\n}', indent: '    ' };
  if (s === 'high-contrast-media') return { open: '@media (prefers-contrast: more) {\n  :root {', close: '  }\n}', indent: '    ' };
  let m = /^class:(.+)$/.exec(s);
  if (m) return { open: `:root.${m[1]} {`, close: '}' };
  m = /^data:([\w-]+)=(.+)$/.exec(s);
  if (m) return { open: `:root[${m[1].startsWith('data-') ? m[1] : `data-${m[1]}`}="${m[2]}"] {`, close: '}' };
  return { open: `${s} {`, close: '}' };
}

// entries: [{ cssVar, value, modeIdx, media }] (modeIdx null = the same in every mode, declared once in :root;
// media = a breakpoint's query, e.g. "(min-width: 768px)"). modes: [{ name, cssSelector }].
// → the CSS text: :root first, then each colour mode's block, then each breakpoint's.
export function tokenCss(entries, modes = [{ name: 'Default', cssSelector: 'root' }]) {
  const groups = new Map();
  const seen = new Set();
  for (const e of entries) {
    if (e.value == null || e.value === '') continue;
    const g = e.media ? `m|${e.media}` : `c|${String(e.modeIdx ?? 0).padStart(3, '0')}`;
    if (seen.has(`${g}|${e.cssVar}`)) continue;
    seen.add(`${g}|${e.cssVar}`);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const out = [];
  for (const g of [...groups.keys()].sort()) {
    let label, b;
    if (g.startsWith('m|')) { label = g.slice(2); b = { open: `@media ${g.slice(2)} {\n  :root {`, close: '  }\n}', indent: '    ' }; }
    else {
      const idx = Number(g.slice(2)), mode = modes[idx] ?? modes[0];
      label = mode?.name ?? 'Default';
      b = modeBlock(idx === 0 ? 'root' : mode?.cssSelector);
    }
    const pad = b.indent ?? '  ';
    out.push(`/* ${label} */`, b.open,
      ...groups.get(g).sort((a, c) => a.cssVar.localeCompare(c.cssVar)).map((e) => `${pad}${e.cssVar}: ${e.value};`), b.close, '');
  }
  return out.join('\n');
}

export function writeTokensToBuild(ROOT, entries, modes, themePath) {
  const file = join(ROOT, TOKENS_TO_BUILD);
  if (!entries.length) { try { if (existsSync(file)) writeFileSync(file, ''); } catch { /* nothing to clear */ } return null; }
  mkdirSync(dirname(file), { recursive: true });
  const n = new Set(entries.map((e) => e.cssVar)).size;
  writeFileSync(file, `/* ${n} token${n === 1 ? '' : 's'} to build: copy into ${themePath}. Generated from the Figma snapshot; the engine never edits the theme itself. */\n\n${tokenCss(entries, modes)}`);
  return { file: TOKENS_TO_BUILD, count: n };
}

// How many tokens the last run listed as to build (0 when none, or not in build mode).
export function tokensToBuildCount(ROOT) {
  try { const m = /^\/\* (\d+) tokens? to build/.exec(readFileSync(join(ROOT, TOKENS_TO_BUILD), 'utf8')); return m ? Number(m[1]) : 0; } catch { return 0; }
}

// names in build order: a component after every component it nests (nesting: { name: [nested names] }).
// Ties keep alphabetical order, so two runs give the same order.
export function buildOrder(names, nesting = {}) {
  const want = new Set(names);
  const done = new Set(), out = [];
  const visit = (n, stack = new Set()) => {
    if (done.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const c of [...(nesting[n] ?? [])].sort()) if (want.has(c) && c !== n) visit(c, stack);
    stack.delete(n);
    done.add(n); out.push(n);
  };
  for (const n of [...want].sort()) visit(n);
  return out;
}

// Build mode: the stylesheets a component was built into (src/components/button.css, and so on), outside the theme and
// the stylesheets ds-config.json already lists. Each holds a rule for the class of a component Figma has. The gates
// look for a component's rules in the theme, so these are recorded as theme files after the token file; otherwise a
// built component would stay to build and go unchecked.
const SKIP_DIRS = /^(node_modules|\.git|dist|build|out|coverage|\.next|\.design-system-engine-out|\.claude|contracts)$/;
export function componentStylesheets(ROOT, cfg, classes) {
  const listed = new Set([cfg.paths?.themeCSS ?? 'src/theme.css', ...(cfg.paths?.pluginCSS ?? [])].flat().map(String));
  const res = classes.filter(Boolean).map((c) => new RegExp(`\\.${String(c).replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`));
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(join(dir, e.name)); continue; }
      if (!/\.css$/i.test(e.name)) continue;
      const rel = relative(ROOT, join(dir, e.name)).split('\\').join('/');
      if (listed.has(rel)) continue;
      let text = '';
      try { text = readFileSync(join(dir, e.name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); } catch { continue; }
      if (res.some((r) => r.test(text))) out.push(rel);
    }
  };
  walk(ROOT);
  return out.sort();
}

// Records the stylesheets componentStylesheets finds in ds-config.json → paths.themeCSS, after the token file (the
// first theme file stays the one the token values are read from). Returns the ones added.
export async function recordComponentStylesheets(ROOT, cfg) {
  if (!isBuildMode(cfg)) return [];
  const { loadLocator } = await import('./component-locator.mjs');
  const read = (p) => { try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch { return {}; } };
  const names = new Set([...Object.keys(read(cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json').components ?? {}),
    ...Object.keys(read(cfg.paths?.compPropsSnapshot ?? 'src/figma-component-props.snapshot.json'))].filter((n) => !n.startsWith('_')));
  const loc = await loadLocator(ROOT, cfg);
  const found = componentStylesheets(ROOT, cfg, [...names].map((n) => loc.classFor(n)));
  if (!found.length) return [];
  const path = join(ROOT, 'ds-config.json');
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  onDisk.paths = { ...(onDisk.paths ?? {}), themeCSS: [...[onDisk.paths?.themeCSS ?? 'src/theme.css'].flat(), ...found] };
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n');
  cfg.paths = { ...(cfg.paths ?? {}), themeCSS: onDisk.paths.themeCSS };
  return found;
}

// The components still to build, in build order.
export async function componentsToBuild(ROOT, cfg) {
  if (!isBuildMode(cfg)) return [];
  const list = (await inProgressList(ROOT, cfg)).filter((x) => x.why === 'to build' && !x.ready).map((x) => x.name);
  let nesting = {};
  try { nesting = JSON.parse(readFileSync(join(ROOT, 'component-composition.snapshot.json'), 'utf8')); } catch { /* no nesting known */ }
  return buildOrder(list, nesting);
}

// The build list's one line for the report.
export function buildLine({ tokens = 0, components = [] } = {}) {
  if (!tokens && !components.length) return null;
  const parts = [];
  if (tokens) parts.push(`${tokens} token${tokens === 1 ? '' : 's'} (${TOKENS_TO_BUILD})`);
  if (components.length) parts.push(`${components.length} component${components.length === 1 ? '' : 's'}: ${components.join(', ')}`);
  return `🧱 TO BUILD  ${parts.join('; ')}. Not failures: built from Figma, then checked.`;
}

// ── The build convention: how a component built from Figma is written, so the engine can check it ──────────
// Without a structure-contract.mjs entry, a component built in build mode is found and compared through one plain
// convention, the one --query prints in its build sheet:
//   • its class: the component's locator class (ds-config.json → componentSelectors, else .componentName);
//   • a variant value other than the default: a modifier class, .button--large (a True boolean: .chip--icon);
//   • an interaction state: its pseudo-class, Hover → :hover, Pressed/Active → :active, Focus → :focus-visible,
//     Disabled → :disabled.
// An entry the project writes in structure-contract.mjs always wins over the derived one.
const kebab = (s) => String(s).replace(/#.*$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const PSEUDO = { hover: ':hover', pressed: ':active', active: ':active', focus: ':focus-visible', focused: ':focus-visible', 'focus-visible': ':focus-visible' };

export function variantSelector(base, prop, value, defaultValue, { guardDisabled = false } = {}) {
  if (String(value) === String(defaultValue)) return base;
  const v = kebab(value), p = kebab(prop);
  if (p === 'disabled' && v === 'true') return `${base}:disabled`;
  if (p === 'state' && v === 'disabled') return `${base}:disabled`;
  if (/^(state|interaction|status)$/.test(p) && PSEUDO[v]) return `${base}${PSEUDO[v]}${guardDisabled && v !== 'focus' && v !== 'focused' && v !== 'focus-visible' ? ':not(:disabled)' : ''}`;
  const cls = base.replace(/^\./, '');
  if (v === 'true') return `${base}.${cls}--${p}`;
  if (v === 'false') return base;
  return `${base}.${cls}--${v}`;
}

// One variant combination ("State=Hover, Disabled=False") → its selector: the modifier classes, then the pseudo-classes.
export function comboSelector(base, variantKey, propertyMap = {}) {
  const classes = [], pseudos = [];
  for (const part of String(variantKey).split(/,\s*/)) {
    const [prop, value] = part.split('=');
    const sel = propertyMap[prop?.trim()]?.[value?.trim()];
    if (!sel || sel === base) continue;
    const rest = sel.slice(base.length);
    const m = /^((?:\.[\w-]+)*)(.*)$/.exec(rest);
    if (m[1]) classes.push(m[1]);
    if (m[2]) pseudos.push(m[2]);
  }
  return base + classes.join('') + pseudos.join('');
}

// { COMPONENT_CSS_SELECTORS, CONTRACT, CSS_HEIGHT_RULES, FIGMA_LAYOUT_TO_CSS, CSS_BASE_RULE_VARS } derived from the
// Figma snapshots for every Figma component. classFor: (name) → its class (the locator's); varOf: (token) → its CSS
// variable (the naming convention). struct: the structure snapshot's components; props: the props snapshot.
// Does Figma's prop=value change a style (height, padding, colours, opacity)? Each variant with it is compared with the
// variant that differs only in that prop (else the default variant). A value that changes only the layers (an icon
// shown) is markup, so it asks for no CSS selector. Unknown variants (no per-variant data) count as styled.
const parts = (key) => Object.fromEntries(String(key).split(/,\s*/).map((p) => p.split('=').map((x) => x.trim())));
const looks = (v = {}) => JSON.stringify([v.h ?? null, v.paddingVar ?? null, v.colors ?? null]);
function styled(s, prop, value) {
  const variants = Object.entries(s.variants ?? {});
  if (!variants.length) return true;
  if (Object.keys(s.variantOpacity ?? {}).some((k) => k === `${prop}=${value}`)) return true;
  const def = s.variants?.[s.defaultVariant];
  const withIt = variants.filter(([k]) => parts(k)[prop] === value);
  if (!withIt.length) return true;
  return withIt.some(([k, v]) => {
    const me = parts(k);
    const sibs = variants.filter(([k2]) => { const o = parts(k2); return o[prop] !== value && Object.keys(me).every((p) => p === prop || o[p] === me[p]); });
    const against = sibs.length ? sibs.map(([, x]) => x) : def ? [def] : [];
    return !against.length || against.some((x) => looks(x) !== looks(v));
  });
}

export function derivedContract(classFor, struct = {}, props = {}, varOf = () => null) {
  const SEL = {}, CONTRACT = {}, HEIGHT = {}, LAYOUT = {}, BASE = [];
  const names = new Set([...Object.keys(struct), ...Object.keys(props)].filter((n) => !n.startsWith('_')));
  for (const name of names) {
    const base = classFor(name);
    if (!base) continue;
    SEL[name] = { main: base };
    const s = struct[name] ?? {};
    const defs = Object.entries(props[name]?.properties ?? {}).filter(([, d]) => d?.type === 'VARIANT' && Array.isArray(d.variantOptions));
    const guardDisabled = defs.some(([k]) => kebab(k) === 'disabled') || defs.some(([, d]) => d.variantOptions.some((o) => kebab(o) === 'disabled'));
    const propertyMap = {};
    for (const [key, d] of defs) {
      const prop = key.replace(/#.*$/, '');
      propertyMap[prop] = Object.fromEntries(d.variantOptions.filter((v) => styled(s, prop, v)).map((v) => [v, variantSelector(base, prop, v, d.defaultValue, { guardDisabled })]));
      if (!Object.keys(propertyMap[prop]).length) delete propertyMap[prop];
    }
    const entry = {};
    for (const k of ['h', 'paddingVar', 'gapVar', 'innerRadiusVar', 'fontSizeVar', 'fontWeightVar', 'strokeOnDefault']) if (s[k] !== undefined) entry[k] = s[k];
    if (s.strokeOnDefault) entry.strokeSides = 'all';
    if (Object.keys(propertyMap).length) entry.propertyMap = propertyMap;
    if (Object.keys(entry).length) CONTRACT[name] = entry;
    if (typeof s.h === 'number') HEIGHT[name] = { selector: base, prop: 'height' };
    for (const t of [s.paddingVar?.tb, s.paddingVar?.lr, s.gapVar, s.innerRadiusVar]) { const v = t && varOf(t); if (v) LAYOUT[t] = v; }
    // Colours: the default variant's fill, text and stroke on the base rule; each other variant's on its selector.
    const PROP = { fill: 'background-color', text: 'color', stroke: 'border-color' };
    const colourRules = (colors, selector, label) => {
      for (const [part, c] of Object.entries(colors ?? {})) {
        const prop = PROP[part], v = c?.token && varOf(c.token);
        if (prop && v) BASE.push({ key: `${name}/${label}/${part}`, selector, prop, expectedVar: v });
      }
    };
    colourRules(s.colors, base, 'default');
    for (const [vk, vv] of Object.entries(s.variants ?? {})) {
      if (vk === s.defaultVariant || !vv?.colors) continue;
      colourRules(vv.colors, comboSelector(base, vk, propertyMap), vk);
    }
  }
  return { COMPONENT_CSS_SELECTORS: SEL, CONTRACT, CSS_HEIGHT_RULES: HEIGHT, FIGMA_LAYOUT_TO_CSS: LAYOUT, CSS_BASE_RULE_VARS: BASE };
}

// The derived contract for a project, read from its snapshots (empty outside build mode).
export function projectDerivedContract(ROOT, cfg, classFor, varOf = () => null) {
  if (!isBuildMode(cfg)) return { COMPONENT_CSS_SELECTORS: {}, CONTRACT: {}, CSS_HEIGHT_RULES: {}, FIGMA_LAYOUT_TO_CSS: {}, CSS_BASE_RULE_VARS: [] };
  const read = (p) => { try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch { return null; } };
  const struct = read(cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json')?.components ?? {};
  const props = read(cfg.paths?.compPropsSnapshot ?? 'src/figma-component-props.snapshot.json') ?? {};
  return derivedContract(classFor, struct, props, varOf);
}

// The markup a role annotation asks for, and its other obligations: one table (role-markup.mjs, I85).
export { roleMarkup } from './role-markup.mjs';
import { roleMarkup, roleSheetLines } from './role-markup.mjs';

// ── The build sheet: what --query prints for a component still to build ────────────────────────────────────────
// Every line is something the engine checks once the component exists, written as the code must write it.
// d: derivedContract(...) for the project; struct/props: the snapshots; nesting: the composition snapshot.
// A component's colours that Figma paints with a raw value instead of a variable: ["background-color #d6f5e3", …].
const COLOUR_PROP = { fill: 'background-color', text: 'color', stroke: 'border-color' };
const rawColours = (colors = {}) => Object.entries(colors ?? {}).filter(([, c]) => c?.hex && !c.token).map(([k, c]) => `${COLOUR_PROP[k] ?? k} ${c.hex}`);

export function buildSheetLines(name, d, { struct = {}, props = {}, nesting = {}, file = null, typography = {} } = {}) {
  const sel = d.COMPONENT_CSS_SELECTORS[name]?.main;
  const c = d.CONTRACT[name] ?? {};
  const s = struct[name] ?? {};
  if (!sel) return [];
  const lines = ['  to build. Write it like this; once it exists every line below is checked:'];
  const vars = Object.fromEntries(Object.entries(d.FIGMA_LAYOUT_TO_CSS));
  const v = (t) => (t && vars[t] ? `var(${vars[t]})` : null);
  const base = [];
  if (typeof c.h === 'number') base.push(`height: ${c.h}px`);
  if (c.paddingVar) { const tb = v(c.paddingVar.tb), lr = v(c.paddingVar.lr); if (tb || lr) base.push(`padding: ${tb ?? '0'} ${lr ?? '0'}`); }
  if (v(c.gapVar)) base.push(`gap: ${v(c.gapVar)}`);
  if (v(c.innerRadiusVar)) base.push(`border-radius: ${v(c.innerRadiusVar)}`);
  for (const a of d.CSS_BASE_RULE_VARS.filter((x) => x.selector === sel && x.key.startsWith(`${name}/`))) base.push(`${a.prop}: var(${a.expectedVar})`);
  if (c.strokeOnDefault && !base.some((b) => b.startsWith('border-color'))) base.push('a border on every side');
  lines.push(`    ${sel} { ${base.join('; ')} }`);
  if (c.fontSizeVar || c.fontWeightVar) {
    const t = typography[c.fontSizeVar] ?? {}, w = typography[c.fontWeightVar] ?? {};
    const vals = [t.size && `font-size ${t.size}`, (w.weight ?? t.weight) && `font-weight ${w.weight ?? t.weight}`, t.lh && `line-height ${t.lh}`].filter(Boolean);
    lines.push(`    text: the "${c.fontSizeVar ?? c.fontWeightVar}" text style${vals.length ? ` (${vals.join(', ')})` : ''}`);
  }
  for (const [prop, map] of Object.entries(c.propertyMap ?? {})) {
    for (const [value, selector] of Object.entries(map)) {
      if (selector === sel) continue;
      const extra = d.CSS_BASE_RULE_VARS.filter((x) => x.selector === selector).map((x) => `${x.prop}: var(${x.expectedVar})`);
      const op = Object.entries(s.variantOpacity ?? {}).find(([k]) => k === `${prop}=${value}`)?.[1];
      if (op != null) extra.push(`opacity: ${op}`);
      lines.push(`    ${prop}=${value} → ${selector}${extra.length ? ` { ${extra.join('; ')} }` : ''}`);
      const raw = rawColours(s.variants?.[`${prop}=${value}`]?.colors);
      if (raw.length) lines.push(`      ${raw.join(', ')}: Figma binds no variable here. Write the value as it is and tell the user it has no variable; never invent one`);
    }
  }
  const rawBase = rawColours(s.colors);
  if (rawBase.length) lines.push(`    ${rawBase.join(', ')} on ${sel}: Figma binds no variable here. Write the value as it is and tell the user it has no variable; never invent one`);
  const role = (props[name]?.annotations ?? []).map((a) => /^role:\s*(.+)$/i.exec(a.label ?? '')?.[1]).find(Boolean);
  if (role) lines.push(`    role: ${role}, so write it as ${roleMarkup(role)}`);
  if (role) for (const o of roleSheetLines(role)) lines.push(`      and ${o}`);
  const nested = (nesting[name] ?? []).filter((n) => n !== name && !/^icon[-/ ]/i.test(n));
  if (nested.length) lines.push(`    uses the system's own ${nested.join(', ')} inside it, never a copy`);
  lines.push(`    the component file${file ? `: ${file}` : ''} names its props exactly as above (Figma's names), or, when the person decides so, contract.authored.json records the code's name`);
  return lines;
}
