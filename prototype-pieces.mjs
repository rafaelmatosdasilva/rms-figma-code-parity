// prototype-pieces.mjs - what a prototype may be made of, and the check that holds it to that.
//
// A prototype is a composition (the format --check-ui reads): the design system's own components with their own
// options, nothing else. Claude never writes styles, so nothing can be invented. Where the system has no piece for
// arrangement, the engine lends a few neutral ones: Page, Stack, Row, Columns, and Text for headings and copy. They
// carry no colour, border or font of their own; their spacing can only be one of the system's spacing tokens and their
// text one of its text styles. A system component with the same name always wins, and the engine's pieces are listed
// as layout the system lacks. A need nothing fits is a Missing box with the need written on it, and a component used
// for a need it does not quite meet carries `standInFor`; both go on the gaps list for the design team.
//
// Pure: no I/O. prototype.mjs is the command.
import { checkUi } from './ui-catalog.mjs';
import { ruledOut, requestFindings } from './prototype-context.mjs';

export const PIECES = ['Page', 'Stack', 'Row', 'Columns', 'Text', 'Missing'];
export const GAP_KINDS = ['component', 'option', 'token', 'icon', 'layout', 'pattern'];

// The system's scales a piece may use: spacing tokens ({ figma, var, value }) and text styles ({ name, size, weight, lh }).
// The family the system's own text is set in: its text styles' when Figma names one, else the one its component CSS
// uses most (`font-family`, or the family at the end of a `font` shorthand).
export function systemFamily(cssText = '') {
  const count = new Map();
  for (const m of String(cssText).matchAll(/font-family\s*:\s*([^;}]+)/g)) { const f = m[1].trim(); if (!/^var\(/.test(f)) count.set(f, (count.get(f) ?? 0) + 1); }
  for (const m of String(cssText).matchAll(/(?<![\w-])font\s*:[^;}]*?(?<![\w.])[\d.]+(?:px|rem|em|%)(?:\s*\/\s*[\d.]+(?:px|rem|em|%)?)?\s+([^;}]+)/g)) { const f = m[1].trim(); if (!/^var\(/.test(f)) count.set(f, (count.get(f) ?? 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function systemScales(view = {}, figmaVars = {}, cssText = '') {
  const spacing = (view.tokens?.spacing ?? []).map((t) => ({ name: t.figma, var: t.var, value: t.value }));
  const text = Object.entries(figmaVars.typography ?? {}).map(([name, t]) => ({ name, size: t.size, weight: t.weight, lh: t.lh, family: t.family }));
  // The page's own colours, when the system names them: its page surface and its primary text.
  // A component's own colour (buttonSecondary/background) is never the page's: only system-wide names count.
  const own = new Set((view.components ?? []).map((c) => String(c.name).toLowerCase().replace(/^[._]+/, '')));
  const colours = (view.tokens?.colors ?? []).flatMap((g) => g.items).filter((t) => !own.has(String(t.figma).split('/')[0].toLowerCase()));
  const best = (list, score) => list.map((t) => [t, score(t.figma.toLowerCase())]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const surface = best(colours, (n) => (/(surface|background|\bbg\b|canvas)/.test(n) ? 2 : 0) && ((/surface/.test(n) ? 2 : 0) + (/(page|canvas|app)/.test(n) ? 3 : 0) + (/(base|default|low)/.test(n) ? 1 : 0) + 1));
  const ink = best(colours, (n) => (/(^|\/)(text|content|foreground|ink)\//.test(n) ? 1 : 0) && ((/primary|default|base/.test(n) ? 2 : 0) + 1));
  return { spacing, text, surface: surface?.var ?? null, ink: ink?.var ?? null, family: text.find((t) => t.family)?.family ?? systemFamily(cssText) };
}

// The engine's pieces as catalog entries, so one checker reads them with the system's components. A piece whose name
// the system already uses is left out: the system's own wins.
export function pieceCatalog(scales, systemNames = []) {
  const taken = new Set(systemNames.map((n) => n.toLowerCase()));
  const space = scales.spacing.map((t) => t.name);
  const spacing = space.length ? { type: 'enum', values: ['none', ...space] } : { type: 'enum', values: ['none'] };
  const defs = {
    Page: { description: 'The engine\'s page: the system\'s page surface and text colour, its children one under another; width is the screen\'s, in px.', props: { padding: spacing, gap: spacing, align: { type: 'enum', values: ['start', 'center', 'end', 'stretch'] }, width: { type: 'text' } } },
    Stack: { description: 'The engine\'s vertical arrangement; grow takes the room its parent leaves.', props: { gap: spacing, padding: spacing, align: { type: 'enum', values: ['start', 'center', 'end', 'stretch'] }, grow: { type: 'boolean' } } },
    Row: { description: 'The engine\'s horizontal arrangement; grow takes the room its parent leaves.', props: { gap: spacing, padding: spacing, align: { type: 'enum', values: ['start', 'center', 'end', 'stretch', 'baseline'] }, justify: { type: 'enum', values: ['start', 'center', 'end', 'between'] }, wrap: { type: 'boolean' }, grow: { type: 'boolean' } } },
    Columns: { description: 'The engine\'s equal columns.', props: { count: { type: 'enum', values: ['2', '3', '4'] }, gap: spacing, grow: { type: 'boolean' } } },
    Text: { description: 'Copy in one of the system\'s text styles.', props: { text: { type: 'text' }, style: { type: 'enum', values: scales.text.map((t) => t.name) }, as: { type: 'enum', values: ['h1', 'h2', 'h3', 'p', 'span'] } } },
    Missing: { description: 'A need the system has nothing for: a labelled empty box, and a line on the gaps list.', props: { need: { type: 'text' }, kind: { type: 'enum', values: GAP_KINDS }, closest: { type: 'text' } } },
  };
  if (!scales.text.length) delete defs.Text.props.style;
  return Object.fromEntries(Object.entries(defs).filter(([n]) => !taken.has(n.toLowerCase())).map(([n, d]) => [n, { ...d, engine: true }]));
}

// The nodes of a composition as one flat list, whatever its form (nested or A2UI), with each node's props together.
const RESERVED = new Set(['id', 'component', 'children', 'child', 'props', 'type']);
export function nodesOf(ui) {
  const out = [];
  let n = 0;
  if (Array.isArray(ui?.components)) {
    for (const c of ui.components) out.push({ id: c.id, component: c.component, props: { ...Object.fromEntries(Object.entries(c).filter(([k]) => !RESERVED.has(k))), ...(c.props ?? {}) }, children: c.children ?? [] });
    return { root: ui.root ?? out[0]?.id ?? null, nodes: out };
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return null;
    const id = node.id ?? `node-${++n}`;
    const kids = (Array.isArray(node.children) ? node.children : []).map(walk).filter(Boolean);
    out.push({ id, component: node.component, props: { ...Object.fromEntries(Object.entries(node).filter(([k]) => !RESERVED.has(k))), ...(node.props ?? {}) }, children: kids });
    return id;
  };
  return { root: walk(ui), nodes: out };
}

// A copy of the composition without `standInFor` (a note for the gaps list, not a prop the component takes).
function withoutNotes(ui) {
  // A column count may be written as a number; the catalog lists it as text.
  const strip = (o) => {
    const { standInFor, purpose, ...rest } = o;
    if (typeof rest.width === 'number') rest.width = String(rest.width);
    if (rest.props && typeof rest.props.width === 'number') rest.props = { ...rest.props, width: String(rest.props.width) };
    if (rest.props && typeof rest.props === 'object') { const { standInFor: s2, purpose: p2, ...p } = rest.props; rest.props = p; if (typeof p.count === 'number') p.count = String(p.count); }
    if (typeof rest.count === 'number') rest.count = String(rest.count);
    return rest;
  };
  if (Array.isArray(ui?.components)) return { ...ui, components: ui.components.map(strip) };
  const walk = (node) => (node && typeof node === 'object' ? { ...strip(node), ...(Array.isArray(node.children) ? { children: node.children.map(walk) } : {}) } : node);
  return walk(ui);
}

// catalog: contracts/catalog.json · view: the style guide's agreed view (what can be drawn) · scales: systemScales().
// Returns { ok, findings, counts, gaps, drawable: { name: component view }, pieces } (findings as checkUi's).
// limits: the guidelines' "at most n <component> per screen" ([{ component, max, per, sentence, from }]).
// breakpoints: the system's screen widths ([{ name, px }]); a Page.width that is none of them is a warning.
// context: prototype-context's view of the documentation, for the uses it rules out.
// request: what the person asked for (the prompt hook keeps it), held against the composition.
export function checkPrototype(ui, { catalog = { components: {} }, view = { components: [] }, scales = { spacing: [], text: [] }, name = 'prototype', declared = [], limits = [], breakpoints = [], context = null, request = null } = {}) {
  const systemNames = Object.keys(catalog.components ?? {});
  const pieces = pieceCatalog(scales, systemNames);
  const r = checkUi(withoutNotes(ui), { ...catalog, components: { ...catalog.components, ...pieces } });
  // A component the catalog does not have is never made up: it is a Missing box with the need written on it.
  const findings = r.findings.map((f) => (f.rule === 1 && f.level === 'error' && pieces.Missing ? { ...f, message: `${f.message}; if the system has nothing for it, write a Missing box with the need instead` } : f));
  const drawable = Object.fromEntries((view.components ?? []).map((c) => [c.name, c]));
  const gaps = [];
  const { nodes } = nodesOf(ui);
  const used = {};
  for (const node of nodes) {
    const p = node.props ?? {};
    if (node.component === 'Missing' && pieces.Missing) {
      gaps.push({ need: String(p.need ?? 'unnamed need'), kind: p.kind ?? 'component', closest: p.closest ?? null, used: null, prototype: name, node: node.id });
      if (!p.need) findings.push({ rule: 2, level: 'error', id: node.id, message: 'a Missing box must say the need it stands for (need)' });
      continue;
    }
    if (node.component === 'Page' && pieces.Page && p.width != null && !/^\d{2,4}$/.test(String(p.width))) findings.push({ rule: 2, level: 'error', id: node.id, message: `Page.width is the screen's width in px (like "820"), not ${JSON.stringify(p.width)}` });
    // A stand-in is a gap whatever stands in, the engine's own Text included.
    if (pieces[node.component] && p.standInFor) gaps.push({ need: String(p.standInFor), kind: 'component', closest: null, used: `the engine's ${node.component}`, prototype: name, node: node.id });
    if (pieces[node.component]) { if (node.component !== 'Text') (used[node.component] ??= []).push(node.id); continue; }
    if (p.standInFor) gaps.push({ need: String(p.standInFor), kind: 'component', closest: node.component, used: node.component, prototype: name, node: node.id });
    // A use the component's documentation rules out: never as a stand-in; as a label, worth a look.
    if (context?.components?.[node.component]) {
      for (const r of ruledOut(context.components[node.component], p.standInFor ?? '', node.component)) findings.push({ rule: null, source: 'the team\'s documentation', level: 'error', id: node.id, message: `${node.component} is not for "${p.standInFor}": "${r.sentence}". Show "${p.standInFor}" as a Missing box instead` });
      const label = [p.Label, p.label, p.text].find((v) => typeof v === 'string' && v.trim());
      if (!p.standInFor && label) for (const r of ruledOut(context.components[node.component], label, node.component)) findings.push({ rule: null, source: 'the team\'s documentation', level: 'warning', id: node.id, message: `${node.component} "${label}": its documentation says "${r.sentence}"; check this use, and use a Missing box if it is ruled out` });
    }
    if (!catalog.components?.[node.component]) continue;   // checkUi already said so
    // A component the team has retired is never put in a new screen: its replacement is.
    const def = catalog.components[node.component];
    if (/^(deprecated|removed|obsolete)$/i.test(def.status ?? '')) findings.push({ rule: 1, level: 'error', id: node.id, message: `${node.component} is ${def.status}${def.useInstead?.length ? `: use ${def.useInstead.join(' or ')} instead` : ': the team retired it, so it is not used in a new screen'}` });
    const v = drawable[node.component];
    if (!v) {
      gaps.push({ need: `${node.component} built in code`, kind: 'component', closest: null, used: null, prototype: name, node: node.id, note: 'in Figma, not built in the code yet: drawn as a labelled box' });
      continue;
    }
    // A prop Figma and the code do not agree on yet is drawn with its default, never guessed.
    const agreed = new Set((v.controls ?? []).flatMap((c) => [c.label, c.prop]));
    const optDefs = catalog.components[node.component]?.props ?? {};
    for (const k of Object.keys(p)) {
      if (k === 'standInFor' || k === 'purpose' || agreed.has(k)) continue;
      // A text or on/off option the code has no prop for is drawn on the part its name points to (prototype page).
      if (['text', 'boolean'].includes(optDefs[k]?.type) && drawnByName(k, optDefs[k], v.markup)) continue;
      if (optDefs[k]?.type === 'boolean' && (p[k] === true || /^true$/i.test(String(p[k])))) continue;   // shown, as it is drawn
      if (['text', 'boolean'].includes(optDefs[k]?.type) && !v.markup) continue;   // no markup: drawn as its text, nothing else to hide
      const said = `${node.component}.${k}`;
      if (findings.some((f) => f.said === said)) continue;
      findings.push({ rule: null, source: 'the code', level: 'warning', id: node.id, said, message: `${said} has no part of that name in the code yet: drawn without it` });
    }
  }
  // The team's written limits: a component used more often than its guidelines allow.
  const count = new Map();
  for (const node of nodes) count.set(node.component, (count.get(node.component) ?? 0) + 1);
  for (const l of limits) {
    const n = count.get(l.component) ?? 0;
    if (n > l.max) findings.push({ rule: null, source: 'the team\'s guidelines', level: 'error', id: null, message: `${n} ${l.component} on this ${l.per}, and the guidelines allow ${l.max}: "${l.sentence}" (${l.from}). Keep ${l.max === 1 ? 'the main one' : `${l.max}`}; for the rest use what the guidelines name, or a Missing box when the system lacks it` });
  }
  if (context && request) findings.push(...requestFindings(context, request, nodes));
  const root = nodes.find((n) => n.component === 'Page');
  const w = root?.props?.width != null ? Number(root.props.width) : null;
  if (w && breakpoints.length && !breakpoints.some((b) => Math.abs(b.px - w) < 1)) findings.push({ rule: null, source: 'the system\'s screen widths', level: 'warning', id: root.id, message: `Page.width ${w} is none of the system's screen widths: ${breakpoints.map((b) => `${b.name} (${b.px})`).join(', ')}` });
  // Gaps written beside the composition (a screen's starting point carries what its screen used that the system lacks).
  for (const g of declared) if (g?.need) gaps.push({ need: String(g.need), kind: GAP_KINDS.includes(g.kind) ? g.kind : 'component', closest: g.closest ?? null, used: g.used ?? null, prototype: name, node: null, ...(g.note ? { note: g.note } : {}) });
  // The engine's layout pieces stand in for layout components the system does not have.
  for (const [piece, ids] of Object.entries(used)) gaps.push({ need: `a ${piece} layout component`, kind: 'layout', closest: null, used: `the engine's ${piece}`, prototype: name, node: ids.join(', '), count: ids.length });
  const errors = findings.filter((f) => f.level === 'error').length;
  return { ok: errors === 0, findings, counts: { components: r.counts.components, errors, warnings: findings.length - errors }, gaps, drawable, pieces: Object.keys(pieces) };
}

// Whether the prototype page can draw an option by its name (the same reading the page does): a class in the
// component's markup that the name points to (TitleContent → a class saying title), the Figma default text in it, or
// the component's own text for a label.
export function drawnByName(prop, def = {}, markup = '') {
  const m = String(markup ?? '');
  if (!m) return false;
  const word = String(prop).replace(/^show[\s_-]*/i, '').replace(/[\s_-]*content$/i, '').replace(/[\s_-]+/g, '').toLowerCase();
  const tokens = [...m.matchAll(/class="([^"]*)"/g)].flatMap((x) => x[1].toLowerCase().split(/[\s_-]+/));
  if (word && tokens.some((c) => c === word || (c.length >= 4 && word.startsWith(c)) || (word.length >= 4 && c.startsWith(word)))) return true;
  if (word === 'icon' && /<svg\b/i.test(m)) return true;
  if (def.type === 'text' && ['label', 'title', 'text'].includes(word)) return true;
  if (def.type === 'text' && typeof def.default === 'string' && def.default.trim() && new RegExp(`>\\s*${def.default.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`, 'i').test(m)) return true;
  return false;
}

// The gaps of every prototype so far, merged by need: what the design team sees, the most needed first.
export function mergeGaps(byPrototype = {}) {
  const merged = new Map();
  for (const [proto, list] of Object.entries(byPrototype)) {
    for (const g of list ?? []) {
      const key = `${g.kind}|${String(g.need).toLowerCase()}`;
      if (!merged.has(key)) merged.set(key, { need: g.need, kind: g.kind, closest: g.closest ?? null, used: g.used ?? null, note: g.note ?? null, prototypes: [] });
      const m = merged.get(key);
      if (!m.prototypes.includes(proto)) m.prototypes.push(proto);
      if (!m.closest && g.closest) m.closest = g.closest;
    }
  }
  return [...merged.values()].sort((a, b) => b.prototypes.length - a.prototypes.length || (a.kind === 'layout') - (b.kind === 'layout'));
}

// One line per gap, for the summary and the reply.
export function gapLine(g) {
  const where = g.prototypes ? ` (needed in ${g.prototypes.length} prototype${g.prototypes.length === 1 ? '' : 's'}: ${g.prototypes.join(', ')})` : '';
  const instead = g.used ? `; the prototype uses ${g.used} meanwhile` : g.closest ? `; closest in the system: ${g.closest}` : '';
  return `${g.kind}: ${g.need}${instead}${g.note ? ` (${g.note})` : ''}${where}`;
}
