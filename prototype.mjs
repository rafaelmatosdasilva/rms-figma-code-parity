// prototype.mjs - draw a prototype from the design system's own components, and list what the system lacks.
// Run from project root:  rms-design-system-engine --prototype <composition.json> [--json]
//
// The composition is the format --check-ui reads (a nested { component, props, children } tree or an A2UI-style flat
// list). It may only use the catalog's components with their own options, plus the engine's neutral layout pieces
// (prototype-pieces.mjs). It is checked first; a composition with errors is not drawn. A valid one is drawn with the
// components' own markup and CSS, in every mode the system has, as one page under .design-system-engine-out/prototypes/.
// What the system lacks (a Missing box, a stand-in, the engine's layout, a component not built yet) goes on the gaps
// list, kept for every prototype in prototypes/gaps.json, the most needed first.
//
// Exit 0 = drawn. Exit 1 = the composition breaks a rule (nothing drawn). Exit 2 = no input, no catalog.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES, catalogTable } from './ui-catalog.mjs';
import { checkPrototype, systemScales, nodesOf, mergeGaps, gapLine, pieceCatalog } from './prototype-pieces.mjs';
import { OUT_DIR, SKILL as CLI, envVar } from './names.mjs';
import { loadContext, purposeLines, ruleLines, usesAgainstPurpose, requestFocus, focusLines, cut } from './prototype-context.mjs';
import { pageFacts, deriveConventions, consistencyFindings, consistencyLine } from './product-conventions.mjs';

const ENGINE = dirname(fileURLToPath(import.meta.url));
export const PROTOTYPE_TEMPLATE = join(ENGINE, 'templates', 'prototype.template.html');

// The nested tree the page draws, from either form.
export function treeOf(ui) {
  const { root, nodes } = nodesOf(ui);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const build = (id) => { const n = byId.get(id); return n ? { component: n.component, props: n.props, children: (n.children ?? []).map((k) => build(typeof k === 'object' ? k.id : k)).filter(Boolean) } : null; };
  return build(root);
}

// The page itself: the engine's template filled with the system's CSS, its icons and the prototype.
// catalog: each component's text and on/off options, drawn by the part their name points to when the code has no prop
// of that name.
export function prototypePage({ name, tree, parts, scales, gaps, note = '', catalog = { components: {} } }) {
  const opts = (n, type) => Object.fromEntries(Object.entries(catalog.components?.[n]?.props ?? {}).filter(([, e]) => e.type === type).map(([k, e]) => [k, typeof e.default === 'string' ? e.default : '']));
  const drawable = Object.fromEntries((parts.view.components ?? []).map((c) => [c.name, { name: c.name, cls: c.cls, role: c.role, markup: c.markup, controls: c.controls, textProps: opts(c.name, 'text'), boolProps: opts(c.name, 'boolean') }]));
  const data = { name, tree, components: drawable, scales, modes: parts.view.modes ?? [], pieces: ['Page', 'Stack', 'Row', 'Columns', 'Text', 'Missing'].filter((p) => !drawable[p]), gaps, note };
  return readFileSync(PROTOTYPE_TEMPLATE, 'utf8')
    .split('/*{{THEME_CSS}}*/').join(parts.themeCSS ?? '')
    .split('/*{{COMPONENT_CSS}}*/').join(parts.componentCSS ?? '')
    .split('<!--{{ICON_SHEET}}-->').join(parts.iconSheet ?? '')
    .split('/*{{PROTOTYPE}}*/').join(JSON.stringify(data).replace(/</g, '\\u003c'));
}

// What every drawing needs once: the catalog, the system's parts (CSS, drawable components, modes) and its scales.
async function systemFor(ROOT, cfg) {
  const contractsDir = resolve(ROOT, cfg.contracts?.out ?? 'contracts');
  // No catalog yet: the audit writes it, so run it once instead of handing that step to the agent.
  if (!existsSync(join(contractsDir, 'catalog.json')) && existsSync(join(ROOT, 'ds-config.json')) && envVar(process.env, 'QUERY_NO_AUDIT') !== '1') {
    spawnSync(process.execPath, [join(ENGINE, 'audit.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 600000 });
  }
  if (!existsSync(join(contractsDir, 'catalog.json'))) return null;
  const catalog = JSON.parse(readFileSync(join(contractsDir, 'catalog.json'), 'utf8'));
  const { generateStyleguide } = await import('./styleguide-gen.mjs');
  const parts = await generateStyleguide(ROOT, cfg, { partsOnly: true, names: Object.keys(catalog.components ?? {}) });
  let figmaVars = {};
  try { figmaVars = JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json'), 'utf8')); } catch { /* no text styles */ }
  const scales = systemScales(parts.view, figmaVars, `${parts.themeCSS ?? ''}\n${parts.componentCSS ?? ''}`);
  // What the team wrote about each component and its product (descriptions, annotations, notes, guidelines, layers).
  const context = await loadContext(ROOT, cfg, catalog, { fetchLinks: envVar(process.env, 'NO_FETCH') !== '1' });
  const actionNames = Object.entries(context.components).filter(([, k]) => /^button$/i.test(k.role ?? '') || /\b(main )?action\b/i.test(k.purpose ?? '')).map(([n]) => n);
  // The screens designers made, read as compositions (a screen already in prototypes/ is read from there instead).
  let designed = [];
  if (context.screens.length) {
    const { screenToPrototype } = await import('./screen-layout.mjs');
    designed = context.screens.map((sc) => { try { return { name: slug(sc.name), label: sc.name, id: sc.id, prototype: screenToPrototype(sc, { catalog, scales }).prototype }; } catch { return null; } }).filter(Boolean);
  }
  return { catalog, parts, scales, context, actionNames, designed };
}

// The texts a composition shows (headings, labels, stand-ins), to match it with a request.
const textsOf = (tree) => { const out = []; const walk = (n) => { if (!n) return; const p = n.props ?? {}; for (const k of ['text', 'Label', 'label', 'need', 'standInFor']) if (typeof p[k] === 'string') out.push(p[k]); (n.children ?? []).forEach(walk); }; walk(tree); return out.join(' '); };

// The request the prototype is for: --for "<text>", or what the person asked in the last hour (the prompt hook keeps it).
function requestOf(ROOT, args) {
  const at = args.indexOf('--for');
  if (at >= 0 && args[at + 1]) return args[at + 1];
  try { const r = JSON.parse(readFileSync(join(ROOT, OUT_DIR, 'prototypes', 'request.json'), 'utf8')); if (Date.now() - Date.parse(r.at) < 3600 * 1000) return r.text; } catch { /* none */ }
  return null;
}

// The product's other pages: every prototype in prototypes/ but the one named, as page facts, and what the team wrote
// in prototypes/conventions.json.
export function productPages(ROOT, sys, except = null) {
  const dir = join(ROOT, 'prototypes');
  const pages = {};
  let authored = {};
  try { authored = JSON.parse(readFileSync(join(dir, 'conventions.json'), 'utf8')); } catch { /* none written */ }
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'conventions.json'); } catch { /* no prototypes yet */ }
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    if (name === except) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      // A starting point read from a designed screen carries the designer's decisions.
      const tree = treeOf(raw?.prototype ?? raw);
      pages[name] = { ...pageFacts(tree, { actionNames: sys.actionNames }), designed: /^Starting point read from the screen/.test(raw?.$note ?? ''), label: name, text: textsOf(tree), file: `prototypes/${f}` };
    } catch { /* not a composition */ }
  }
  // A screen designed in Figma and not brought into prototypes/ yet still says how the product's pages look.
  for (const d of sys.designed ?? []) {
    if (pages[d.name] || d.name === except) continue;
    const tree = treeOf(d.prototype);
    pages[d.name] = { ...pageFacts(tree, { actionNames: sys.actionNames }), designed: true, label: `${d.label} (designed in Figma; ${CLI} --prototype --from-screens brings it into prototypes/)`, text: textsOf(tree), file: null };
  }
  return { pages, authored };
}

// Check one prototype and, when it holds, draw it and keep its gaps. raw is the composition, or { prototype, gaps }.
function drawOne(ROOT, name, raw, sys) {
  const ui = raw?.prototype ?? raw;
  const declared = Array.isArray(raw?.gaps) ? raw.gaps : [];
  const r = checkPrototype(ui, { catalog: sys.catalog, view: sys.parts.view, scales: sys.scales, name, declared, limits: sys.context.limits, breakpoints: sys.context.breakpoints, context: sys.context, request: sys.request ?? requestOf(ROOT, []) });
  // The same decisions as the product's other pages (frame, heading, actions, the answer to each missing need).
  const { pages, authored } = productPages(ROOT, sys, name);
  const conventions = deriveConventions(pages, authored);
  const differs = r.ok ? consistencyFindings(pageFacts(treeOf(ui), { actionNames: sys.actionNames }), conventions) : [];
  // What the documentation says about each component this prototype uses, beside what it uses it for.
  const uses = usesAgainstPurpose(sys.context, nodesOf(ui).nodes);
  const outDir = join(ROOT, OUT_DIR, 'prototypes');
  const gapsFile = join(outDir, 'gaps.json');
  let store = { byPrototype: {} };
  try { store = JSON.parse(readFileSync(gapsFile, 'utf8')); } catch { /* first prototype */ }
  let page = null;
  if (r.ok) {
    store.byPrototype[name] = r.gaps;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(gapsFile, JSON.stringify({ $description: `What the design system lacks, from every prototype drawn with ${CLI} --prototype. Generated; the design team decides each one.`, byPrototype: store.byPrototype, merged: mergeGaps(store.byPrototype) }, null, 2) + '\n');
    page = join(outDir, `${name}.html`);
    const mine = mergeGaps({ [name]: r.gaps }).map(gapLine);
    // What the reply owes the person: every gap of the prototype just drawn (the Stop hook holds the reply to it).
    writeFileSync(join(outDir, 'last.json'), JSON.stringify({ at: new Date().toISOString(), name, pending: true, gaps: [...mergeGaps({ [name]: r.gaps }).map((g) => ({ need: g.need, kind: g.kind, line: gapLine(g) })), ...differs.map((d) => ({ need: `${d.what} ${d.product}`, kind: 'consistency', line: consistencyLine(d) })), ...r.findings.filter((f) => f.kind === 'request').map((f) => ({ need: f.message.replace(/^the request asks for /, '').split(' and ')[0], kind: 'request', line: f.message }))] }, null, 2) + '\n');
    writeFileSync(page, prototypePage({ name, tree: treeOf(ui), parts: sys.parts, scales: sys.scales, gaps: mine, catalog: sys.catalog, note: `${r.counts.components} parts · only the design system's own components${r.gaps.some((g) => g.kind === 'layout') ? ', with the engine\'s neutral layout' : ''}` }));
  }
  return { ...r, page, differs, uses, used: [...new Set(nodesOf(ui).nodes.map((n) => n.component))] };
}

// What the context was read from, for the catalog: so the person sees what the prototype knows, and what is missing.
export function sourceLines(ctx) {
  if (!ctx?.sources?.length) return [];
  return ['', 'Read from:', ...ctx.sources.map((s) => `  ${s.missing ? '⚠️ ' : '• '}${s.what}: ${s.detail}`)];
}

// How the product's pages are arranged, for the catalog (only what at least two pages, or the team, agree on).
export function conventionLines(conv) {
  if (!conv) return [];
  const LABEL = { padding: 'page padding', gap: 'space between sections', width: 'screen width', align: 'alignment' };
  const src = (c) => (c.authored ? 'the team' : c.pages.join(', '));
  const lines = [
    ...Object.entries(conv.page ?? {}).map(([k, c]) => `${LABEL[k]} ${c.value} (${src(c)})`),
    ...(conv.heading?.style ? [`page heading in ${conv.heading.style.value} (${src(conv.heading.style)})`] : []),
    ...(conv.actions?.at ? [`actions at the ${conv.actions.at.value}${conv.actions.justify ? `, lined up ${conv.actions.justify.value}` : ''} (${src(conv.actions.at)})`] : []),
    ...((conv.frame ?? []).length ? [`frame: ${conv.frame.map((c) => c.component).join(', ')} (${src(conv.frame[0])})`] : []),
    ...(conv.needs ?? []).map((n) => `"${n.need}" is ${n.answer} (${src(n)})`),
  ];
  return lines.length ? ['', 'How this product\'s pages are arranged (keep a new page the same):', ...lines.map((l) => `  ${l}`)] : [];
}

// --catalog: everything a prototype may use, in one screen: the system's components and options, the engine's pieces
// with the tokens they take, the format, and the starting points already made.
export function catalogText(sys, { cmd = CLI, starts = [], conventions = null, focus = null } = {}) {
  const drawable = new Set((sys.parts.view.components ?? []).map((c) => c.name));
  const comps = Object.fromEntries(Object.entries(sys.catalog.components ?? {}).map(([n, c]) => [n, { ...c, ...(drawable.has(n) ? {} : { status: c.status ? `${c.status}, not built in code` : 'not built in code: drawn as a box' }) }]));
  const pieces = pieceCatalog(sys.scales, Object.keys(comps));
  const pieceRows = Object.entries(pieces).map(([n, d]) => `${n.padEnd(8)}  ${Object.entries(d.props).map(([k, e]) => `${k}=${e.type === 'enum' ? (e.values.length > 6 ? `<${k === 'style' ? 'text style' : 'spacing token'}>` : e.values.join('|')) : e.type === 'boolean' ? 'true|false' : `<${k === 'width' ? 'screen width in px' : k === 'need' ? 'what is needed' : k === 'closest' ? 'nearest system component' : 'text'}>`}`).join('  ')}`);
  return [
    'PROTOTYPE CATALOG  ·  everything a prototype may use; nothing else exists for it',
    ...sourceLines(sys.context),
    ...focusLines(focus),
    '',
    'The design system\'s components (name, options):',
    catalogTable({ components: comps }),
    ...(() => { const l = purposeLines(sys.context ?? { components: {}, rules: [] }, Object.keys(comps)); return l.length ? ['', 'What each component is for (Figma descriptions and annotations, code notes, the team\'s guidelines); use it only for that:', ...l] : []; })(),
    ...(() => { const l = ruleLines(sys.context ?? { components: {}, rules: [] }); return l.length ? ['', 'The team\'s rules for the product:', ...l] : []; })(),
    ...((sys.context?.limits ?? []).length ? ['', 'Rules the check holds every prototype to (read from the guidelines):', ...sys.context.limits.map((l) => `  at most ${l.max} ${l.component} per ${l.per}: "${cut(l.sentence, 160)}" (${l.from})`)] : []),
    ...((sys.context?.templates ?? []).length ? ['', 'Templates in Figma (the components each composes, in order):', ...sys.context.templates.map((t) => `  ${t.name}: ${t.components.join(', ')}`)] : []),
    ...conventionLines(conventions),
    '',
    'The engine\'s pieces (only where the system has none of its own):',
    ...pieceRows.map((r) => `  ${r}`),
    `Spacing tokens: ${sys.scales.spacing.map((t) => `${t.name} (${t.value})`).join(', ') || 'none'}`,
    `Text styles: ${sys.scales.text.map((t) => `${t.name} (${t.size}/${t.lh} ${t.weight})`).join(', ') || 'none'}`,
    ...((sys.context?.breakpoints ?? []).length ? [`Screen widths (Page.width): ${sys.context.breakpoints.map((b) => `${b.name} (${b.px})`).join(', ')}`] : []),
    '',
    'Format: { "component": "Page", "props": { "padding": "<spacing token>" }, "children": [ { "component": "<name>", "props": { "<option>": "<value>" } } ] }',
    'A system component used for a need it does not quite meet carries "standInFor": "<the need>" in its props; a need nothing fits is { "component": "Missing", "props": { "need": "…" } }.',
    ...(starts.length ? ['', `Prototypes already here (starting points read from designed screens among them): ${starts.map((f) => `prototypes/${f}`).join(', ')}; copy the closest one`] : []),
    '',
    `NEXT: write prototypes/<name>.json with only the parts above, then run ${cmd} --prototype prototypes/<name>.json and fix each ❌ line until it is drawn.`,
  ].join('\n');
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'screen';

// --from-screens <capture.json>: each designed screen becomes a starting point in prototypes/, drawn at once.
async function fromScreens(ROOT, cfg, file, sys, { force = false } = {}) {
  const { screenToPrototype, layoutHabits } = await import('./screen-layout.mjs');
  let capture;
  try { capture = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')); } catch (e) { console.log(`\n❌ ${file} is not a screen capture (${String(e.message).split('\n')[0]}).\n`); return 1; }
  const screens = capture.screens ?? [];
  if (!screens.length) { console.log(`\n⏭  ${file} holds no screens.\n`); return 2; }
  mkdirSync(join(ROOT, 'prototypes'), { recursive: true });
  const results = [];
  console.log(`\nScreens to prototypes  ·  ${screens.length} screen(s) from ${file}`);
  for (const sc of screens) {
    const { prototype, gaps } = screenToPrototype(sc, { catalog: sys.catalog, scales: sys.scales });
    const name = slug(sc.name);
    const target = join(ROOT, 'prototypes', `${name}.json`);
    const kept = existsSync(target) && !force;
    if (!kept) writeFileSync(target, JSON.stringify({ $note: `Starting point read from the screen "${sc.name}" in Figma (${sc.id}). Edit it freely: only the system's components and the engine's layout pieces.`, prototype, gaps }, null, 2) + '\n');
    const r = drawOne(ROOT, name, kept ? JSON.parse(readFileSync(target, 'utf8')) : { prototype, gaps }, sys);
    results.push({ name: sc.name, prototype, ok: r.ok });
    console.log(`   ${r.ok ? '✅' : '❌'} ${sc.name} → prototypes/${name}.json${kept ? ' (kept as it was; --force replaces it)' : ''}${r.page ? ` · drawn ${r.page.replace(ROOT + '/', '')}` : ''}`);
    for (const f of r.findings.filter((x) => x.level === 'error')) console.log(`      ❌ ${f.message}`);
  }
  const h = layoutHabits(results);
  console.log('\n📐 HOW THESE SCREENS ARRANGE THINGS');
  if (h.pagePadding.length) console.log(`   page padding: ${h.pagePadding.join(', ')}`);
  if (h.gaps.length) console.log(`   spacing between parts: ${h.gaps.map((g) => `${g.name} ×${g.n}`).join(', ')}`);
  if (h.components.length) console.log(`   components used: ${h.components.map((c) => `${c.name} (${c.screens.length})`).join(', ')}`);
  if (h.repeated.length) { console.log('   structures that repeat (template candidates):'); for (const t of h.repeated) console.log(`     • ${t.structure} in ${t.screens.join(', ')}`); }
  const merged = mergeGaps(JSON.parse(readFileSync(join(ROOT, OUT_DIR, 'prototypes', 'gaps.json'), 'utf8')).byPrototype);
  if (merged.length) {
    console.log(`\n🧩 GAPS  ${merged.length}  (what the design system would need; nothing was invented)`);
    for (const g of merged.slice(0, 30)) console.log(`   • ${gapLine(g)}`);
    if (merged.length > 30) console.log(`   … ${merged.length - 30} more in ${join(OUT_DIR, 'prototypes', 'gaps.json')}`);
  }
  console.log(`\nNEXT: open the drawn screens to compare them with Figma; start a new prototype from the closest one in prototypes/, then run ${CLI} --prototype prototypes/<name>.json.\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

// --consistency: every page of the product against the others: where one decides differently.
function consistencyReport(ROOT, sys) {
  const { pages, authored } = productPages(ROOT, sys);
  const names = Object.keys(pages);
  console.log(`\nConsistency  ·  ${names.length} page(s) in prototypes/`);
  if (names.length < 2 && !Object.keys(authored).length) { console.log('   ⏭  fewer than two pages and no prototypes/conventions.json: nothing to compare yet.\n'); return 0; }
  let n = 0;
  for (const name of names) {
    const others = Object.fromEntries(Object.entries(pages).filter(([k]) => k !== name));
    const d = consistencyFindings(pages[name], deriveConventions(others, authored));
    n += d.length;
    console.log(`   ${d.length ? '⚠️ ' : '✅'} ${name}${d.length ? '' : ': the same as the others'}`);
    for (const x of d) console.log(`      • ${consistencyLine(x)}`);
  }
  for (const l of conventionLines(deriveConventions(pages, authored)).slice(1)) console.log(l.replace(/^/, ' '));
  console.log(`\nNEXT: ${n ? 'bring each page marked ⚠️ in line with the others, or tell the person why it differs; the team can write a decision in prototypes/conventions.json.' : 'nothing to change.'}\n`);
  return 0;
}

export async function runPrototype(ROOT, argv) {
  const args = argv.filter((a) => a !== '--prototype');
  const JSON_MODE = args.includes('--json');
  const screensAt = args.indexOf('--from-screens');
  const screensFile = screensAt >= 0 ? args[screensAt + 1] : null;
  const input = screensFile ? null : args.find((a) => !a.startsWith('--'));
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch { /* defaults */ }
  const file = screensFile ?? input;
  if (!args.includes('--catalog') && !args.includes('--consistency') && (!file || !existsSync(resolve(ROOT, file)))) {
    console.log(`\nUsage: ${CLI} --prototype <composition.json>`);
    console.log(`       ${CLI} --prototype --from-screens <screen-capture.json>`);
    console.log(`       ${CLI} --prototype --catalog | --consistency`);
    console.log('   The composition names the design system\'s components and their options, in the format --check-ui reads,');
    console.log('   plus the engine\'s layout pieces (Page, Stack, Row, Columns, Text) and Missing for a need nothing fits.');
    console.log('   A screen capture (screen-layout.mjs) turns each designed screen into a starting point.\n');
    return 2;
  }
  const sys = await systemFor(ROOT, cfg);
  if (sys) sys.request = requestOf(ROOT, args);
  if (!sys) { console.log(`\n⏭  no catalog yet: run ${CLI} once to write it, then draw the prototype again.\n`); return 2; }
  if (args.includes('--catalog')) {
    let starts = [];
    try { starts = readdirSync(join(ROOT, 'prototypes')).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
    const { pages, authored } = productPages(ROOT, sys);
    const req = requestOf(ROOT, args);
    const focus = req ? requestFocus(sys.context, req, Object.entries(pages).map(([name, p]) => ({ name, label: p.label ?? name, text: p.text, designed: !!p.designed, file: p.file }))) : null;
    console.log('\n' + catalogText(sys, { starts, conventions: deriveConventions(pages, authored), focus }) + '\n');
    return 0;
  }
  if (args.includes('--consistency')) return consistencyReport(ROOT, sys);
  if (screensFile) return fromScreens(ROOT, cfg, screensFile, sys, { force: args.includes('--force') });

  let raw;
  try { raw = JSON.parse(readFileSync(resolve(ROOT, input), 'utf8')); }
  catch (e) { console.log(`\n❌ ${input} is not valid JSON (${e.message.split('\n')[0]}). Nothing was drawn.\n`); return 1; }
  const name = basename(input).replace(/\.json$/i, '');
  const r = drawOne(ROOT, name, raw, sys);
  const { catalog } = sys;
  const page = r.page;
  const used = r.used;
  if (JSON_MODE) { process.stdout.write(JSON.stringify({ ok: r.ok, page: page && page.replace(ROOT + '/', ''), findings: r.findings, counts: r.counts, gaps: r.gaps, used }, null, 2) + '\n'); return r.ok ? 0 : 1; }

  console.log(`\nPrototype  ·  ${name}  ·  ${r.counts.components} part(s)`);
  for (const f of r.findings) console.log(`   ${f.level === 'error' ? '❌' : '⚠️ '} ${f.message}${f.rule ? `  (rule ${f.rule}: ${RULES[f.rule - 1]})` : f.source ? `  (${f.source})` : ''}`);
  if (!r.ok) {
    console.log(`\n❌ ${r.counts.errors} error(s): nothing drawn.`);
    console.log(`\nNEXT: fix each ❌ line in ${input} (only the system's components and their own options; Missing for a need nothing fits), then run ${CLI} --prototype ${input} again.\n`);
    return 1;
  }
  console.log(`✅ drawn: ${page.replace(ROOT + '/', '')}`);
  const own = used.filter((u) => catalog.components?.[u]);
  if (own.length) console.log(`   the system's components: ${own.join(', ')}`);
  if (r.uses.length) {
    console.log('\n📓 WHAT THE DOCUMENTATION SAYS ABOUT WHAT THIS PROTOTYPE USES');
    for (const u of r.uses) console.log(`   • ${u.component}${u.uses.length ? ` (used for ${u.uses.map((x) => JSON.stringify(x)).join(', ')})` : ''}: ${u.rule}`);
  }
  if (r.differs.length) {
    console.log(`\n📐 DIFFERENT FROM THE PRODUCT'S OTHER PAGES  ${r.differs.length}`);
    for (const d of r.differs) console.log(`   • ${consistencyLine(d)}`);
  }
  const gaps = mergeGaps({ [name]: r.gaps });
  if (gaps.length) {
    console.log(`\n🧩 GAPS  ${gaps.length}  (what the design system would need; nothing was invented)`);
    for (const g of gaps) console.log(`   • ${gapLine(g)}`);
    console.log(`   every prototype's gaps: ${join(OUT_DIR, 'prototypes', 'gaps.json')}`);
  }
  const next = [
    r.uses.length ? 'Check each use above against what its component is for: a use the documentation rules out gets "standInFor" with the need, or a Missing box, and the prototype is drawn again.' : null,
    r.differs.length ? 'Make each 📐 line match the other pages, or tell the person why this page differs.' : null,
    gaps.length ? 'Tell the person each gap above as it is written: the design team decides them; never build one.' : null,
  ].filter(Boolean);
  console.log(`\nNEXT: open ${page.replace(ROOT + '/', '')} to see it.${next.length ? ` ${next.join(' ')}` : ''}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await runPrototype(process.cwd(), process.argv.slice(2)));
}
