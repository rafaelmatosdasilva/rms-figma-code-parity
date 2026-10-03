// prototype-context.mjs - everything the engine knows about the system and the product, put in front of whoever
// makes a prototype, with what the person asked for in view.
//
// Figma alone gives a component and its options. The engine gathers much more, and a prototype uses all of it:
//   • Figma: each component's description, annotations (a `Role:` annotation is its role), each option's description,
//     the text styles and spacing tokens, the screen widths (breakpoints), the templates it composes
//     (figma-templates.snapshot.json) and the screens designers made (the screen capture);
//   • the code: what is built, which components hold which, the notes beside a component and above its CSS rule;
//   • what the team authored: contract.authored.json (whenNotToUse, useInstead, status, notes) and the layers of the
//     design intent (system, foundations, patterns, templates, pages, flows);
//   • the team's guidelines, committed or fetched from the Notion and GitLab links in ds-config.json: a section
//     named after a component goes with it, every other section is a rule for the product.
// From the guidelines it also reads the rules a check can hold a prototype to ("one button per screen").
//
// loadContext reads files (and refreshes a guidelines link whose file is missing or old); the rest is pure.
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const clean = (s) => String(s ?? '').replace(/@(deprecated|experimental|status|use-?instead|superseded-?by|replaced-?by|since|why|rationale)\b[ \t]*:?[^\n@]*/gi, ' ').replace(/\s+/g, ' ').trim();
export const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const LAYERS = ['system', 'foundations', 'patterns', 'templates', 'pages', 'flows'];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'each', 'some', 'like', 'one', 'our', 'your', 'their', 'use', 'using', 'used', 'make', 'made', 'page', 'screen', 'prototype', 'prototyp', 'mock', 'wireframe', 'design', 'system', 'component', 'components', 'into', 'onto', 'when', 'what', 'which', 'there', 'them', 'they', 'then', 'than', 'have', 'has', 'are', 'was', 'were', 'will', 'can', 'not', 'all', 'any', 'only', 'also', 'its', 'it', 'a', 'an', 'to', 'of', 'on', 'in', 'or', 'is', 'be', 'by', 'as', 'at', 'up', 'new', 'show', 'shows', 'once', 'after', 'before', 'more', 'other']);
export const wordsOf = (s) => [...new Set((String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-zà-ú][a-zà-ú0-9]{2,}/g) ?? []).map((w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')).filter((w) => w.length > 2 && !STOP.has(w)))];

// Markdown into sections: the text before the first heading, then one per heading (any level).
export function sectionsOf(text) {
  const parts = String(text).split(/^#{1,6}\s+(.+)$/m);
  const general = (parts.shift() || '').trim();
  const out = general ? [{ heading: null, body: general }] : [];
  for (let i = 0; i < parts.length; i += 2) if ((parts[i + 1] || '').trim()) out.push({ heading: parts[i].trim(), body: parts[i + 1].trim() });
  return out;
}

// Where each guidelines file comes from: a Notion or GitLab link (fetched into it), or committed as it is.
function originOf(file, cfg, targets) {
  const t = targets.find((x) => x.file === file);
  return t ? `${t.provider} (${t.url})` : 'committed';
}

// A guidelines link whose file is missing, or older than guidelines.maxAgeHours (24 by default), is fetched again,
// as the audit does: written to its committed file. No token, no network: the file stays as it is, and says so.
async function refreshLinks(ROOT, cfg, targets, { fetchLinks = true } = {}) {
  const notes = [];
  const maxAge = (cfg.guidelines?.maxAgeHours ?? 24) * 3600 * 1000;
  for (const t of targets) {
    const abs = resolve(ROOT, t.file);
    const fresh = existsSync(abs) && Date.now() - statSync(abs).mtimeMs < maxAge;
    if (fresh || !fetchLinks) { if (!existsSync(abs)) notes.push({ file: t.file, provider: t.provider, url: t.url, status: 'not fetched yet' }); continue; }
    try {
      const md = t.provider === 'Notion' ? await (await import('./notion-fetch.mjs')).fetchNotionMarkdown(t.url, {}) : await (await import('./gitlab-fetch.mjs')).fetchGitlabMarkdown(t.url, {});
      if (md && md.trim()) {
        const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        if (md !== prev) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, md); }
        notes.push({ file: t.file, provider: t.provider, url: t.url, status: 'fetched now' });
      } else notes.push({ file: t.file, provider: t.provider, url: t.url, status: existsSync(abs) ? 'kept (the link gave nothing)' : 'not fetched yet' });
    } catch { notes.push({ file: t.file, provider: t.provider, url: t.url, status: existsSync(abs) ? 'kept (could not fetch)' : 'not fetched yet' }); }
  }
  return notes;
}

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const age = (p) => { try { const h = (Date.now() - statSync(p).mtimeMs) / 3600000; return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; } catch { return null; } };

// Everything, read once for a prototype.
export async function loadContext(ROOT, cfg = {}, catalog = { components: {} }, { fetchLinks = true } = {}) {
  const sources = [];
  const { gitlabTargets, notionTargets, guidelineFiles, generateIntent } = await import('./intent-gen.mjs');
  const targets = [...notionTargets(cfg).map((t) => ({ ...t, provider: 'Notion' })), ...gitlabTargets(cfg).map((t) => ({ ...t, provider: 'GitLab' }))];
  const linkNotes = targets.length ? await refreshLinks(ROOT, cfg, targets, { fetchLinks }) : [];

  // The design intent: the sources read without writing; the file the audit keeps when there is one (it holds what
  // the team authored, which generateIntent carries over).
  let intent = null;
  const themeCss = Array.isArray(cfg.paths?.themeCSS) ? cfg.paths.themeCSS[0] : cfg.paths?.themeCSS;
  const intentFile = cfg.docs?.out ? resolve(ROOT, cfg.docs.out) : join(themeCss ? dirname(resolve(ROOT, themeCss)) : ROOT, 'design-intent.json');
  const structFile = resolve(ROOT, cfg.paths?.snapshotStructure ?? 'figma-structure.snapshot.json');
  try { if (existsSync(structFile)) intent = (await generateIntent(ROOT, cfg, { write: false })).intent; } catch { /* the catalog alone still says what each component is for */ }
  if (!intent) intent = readJSON(intentFile);

  const figmaDir = dirname(structFile);
  const propsFile = resolve(ROOT, cfg.paths?.compPropsSnapshot ?? 'figma-component-props.snapshot.json');
  const varsFile = resolve(ROOT, cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json');
  if (existsSync(propsFile)) sources.push({ what: 'Figma', detail: `component descriptions, annotations and options (${cfg.paths?.compPropsSnapshot ?? 'figma-component-props.snapshot.json'}, captured ${age(propsFile)})` });
  const vars = readJSON(varsFile) ?? {};
  if (existsSync(varsFile)) sources.push({ what: 'Figma', detail: `tokens, text styles and screen widths (${cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json'}, captured ${age(varsFile)})` });
  const templatesFile = [cfg.paths?.snapshotTemplates, 'figma-templates.snapshot.json', join(figmaDir, 'figma-templates.snapshot.json')].filter(Boolean).map((p) => resolve(ROOT, p)).find(existsSync);
  const tsnap = templatesFile ? readJSON(templatesFile) : null;
  const templates = Object.values(tsnap?.templates ?? {}).filter((t) => t?.name && Array.isArray(t.components));
  if (templates.length) sources.push({ what: 'Figma', detail: `${templates.length} template${templates.length === 1 ? '' : 's'} and the components each composes (${templatesFile.replace(ROOT + '/', '')})` });
  const screensFile = [cfg.paths?.screenLayout, join(figmaDir, 'figma-screen-layout.snapshot.json'), 'figma-screen-layout.snapshot.json'].filter(Boolean).map((p) => resolve(ROOT, p)).find(existsSync) ?? null;
  const screens = screensFile ? (readJSON(screensFile)?.screens ?? []) : [];
  if (screens.length) sources.push({ what: 'Figma', detail: `${screens.length} designed screen${screens.length === 1 ? '' : 's'} (${screensFile.replace(ROOT + '/', '')})` });
  if (Object.keys(catalog.components ?? {}).length) sources.push({ what: 'the code', detail: `${Object.keys(catalog.components).length} components, what each holds, notes beside them` });
  const authoredFile = cfg.contracts?.authored ? resolve(ROOT, cfg.contracts.authored) : join(ROOT, 'contract.authored.json');
  if (existsSync(authoredFile)) sources.push({ what: 'the team', detail: `${authoredFile.replace(ROOT + '/', '')} (when not to use, what instead, status, notes)` });
  if (intent && LAYERS.some((L) => intent[L]?.authored)) sources.push({ what: 'the team', detail: `the design intent's ${LAYERS.filter((L) => intent[L]?.authored).join(', ')}` });

  // The guidelines, section by section, each with where it comes from.
  const sections = [];
  for (const rel of guidelineFiles(cfg)) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const origin = originOf(rel, cfg, targets);
    sources.push({ what: 'guidelines', detail: `${rel} (${origin === 'committed' ? 'committed' : `from ${origin}, ${age(abs)}`})` });
    if (rel.toLowerCase().endsWith('.json')) {
      for (const [k, v] of Object.entries(readJSON(abs) ?? {})) if (typeof v === 'string' && v.trim()) sections.push({ heading: /^_?general$/i.test(k) ? null : k, body: v.trim(), file: rel });
    } else for (const s of sectionsOf(text)) sections.push({ ...s, file: rel });
  }
  for (const n of linkNotes.filter((x) => x.status === 'not fetched yet')) sources.push({ what: 'guidelines', detail: `${n.provider} link ${n.url}: not fetched yet (its token goes in .env; the engine names it when it runs)`, missing: true });

  const ctx = contextFrom(catalog, intent, sections);
  return { ...ctx, sources, templates, screens, screensFile, breakpoints: breakpointsOf(vars), linkNotes };
}

// The system's screen widths: { name, px } from the Figma breakpoints.
export function breakpointsOf(vars = {}) {
  return Object.entries(vars.breakpoints ?? {}).map(([name, v]) => ({ name, px: parseFloat(typeof v === 'object' ? v?.value ?? v?.$value : v) })).filter((b) => Number.isFinite(b.px));
}

// { components: { name: { purpose, role, notes, notFor, useInstead, status, guidelines, options } }, rules, limits }
export function contextFrom(catalog = { components: {} }, intent = null, sections = null) {
  const components = {};
  const names = Object.keys(catalog.components ?? {});
  const byKey = new Map(names.map((n) => [n.toLowerCase().replace(/[^a-z0-9]/g, ''), n]));
  // Guideline sections named after a component go with it; the rest are the product's rules.
  const own = new Map();
  const rest = [];
  if (sections) {
    for (const s of sections) {
      const n = s.heading && byKey.get(s.heading.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (n) { if (!own.has(n)) own.set(n, []); own.get(n).push(s.body); } else rest.push(s);
    }
  }
  for (const name of names) {
    const c = catalog.components[name];
    const i = intent?.components?.[name] ?? {};
    const annotations = (i.design?.annotations ?? []).map((a) => clean(a?.label ?? a)).filter(Boolean);
    const role = annotations.map((a) => a.match(/^role\s*:\s*(.+)$/i)?.[1]).find(Boolean) ?? null;
    const notes = [...annotations.filter((a) => !/^role\s*:/i.test(a)), clean(i.code?.note), clean(i.code?.cssComment), clean(i.authored)].filter(Boolean);
    const options = Object.entries(c.props ?? {}).filter(([, e]) => e.description).map(([p, e]) => `${p}: ${clean(e.description)}`);
    const guidelines = clean(own.has(name) ? own.get(name).join(' ') : i.guidelines) || null;
    const notFor = clean(c.whenNotToUse ?? i.guidance?.whenNotToUse) || null;
    components[name] = {
      never: neverOf([guidelines, ...notes].filter(Boolean).join(' '), notFor),
      purpose: clean(c.description) || clean(i.design?.description) || null,
      role,
      notes: [...new Set(notes)],
      options,
      notFor,
      useInstead: c.useInstead ?? i.guidance?.useInstead ?? null,
      status: c.status ?? (i.status?.state && i.status.state !== 'current' ? i.status.state : null),
      guidelines,
    };
  }
  // Without the sections themselves (an older caller), the intent's general block stands for them.
  if (!sections && intent?.guidelines?.general) rest.push(...sectionsOf(intent.guidelines.general).map((s) => ({ ...s, file: (intent.guidelines._sources ?? [])[0] ?? null })));
  const rules = rest.map((s) => ({ title: s.heading ?? 'guidelines', text: s.body.trim(), file: s.file ?? null }));
  for (const L of LAYERS) {
    const a = intent?.[L]?.authored;
    const text = typeof a === 'string' ? a.trim() : a && typeof a === 'object' ? JSON.stringify(a) : '';
    if (text) rules.push({ title: `${L} (design intent)`, text, file: null });
  }
  return { components, rules, limits: limitsFrom(components, rules, names) };
}

// The sentences that rule a use out ("Never an on/off control", "not for navigation"), and the authored whenNotToUse.
const NEVER = /\b(never|not for|not to be|don['’]t|do not|avoid|must not|no longer)\b/i;
// Each keeps its sentence (shown) and the clause after the negation (matched): "People turn it on and off; it never
// submits anything" rules out submitting, not turning on and off.
export function neverOf(text, notFor = null) {
  const out = [];
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+/).map((x) => x.trim())) {
    const m = NEVER.exec(sentence);
    if (m) out.push({ sentence, clause: sentence.slice(m.index).split(/[;:.!?]/)[0] });
  }
  if (notFor) { const t = `Not for ${notFor.replace(/^not for\s*/i, '')}`; out.push({ sentence: t, clause: t }); }
  return out;
}

// A use the documentation rules out: the words of a stand-in or a label that one of the component's "never" sentences
// names. Returns [{ sentence, words }].
export function ruledOut(k, text, name = '') {
  const w = wordsOf(text).filter((x) => x !== name.toLowerCase());
  if (!k?.never?.length || !w.length) return [];
  return k.never.map((n) => ({ sentence: n.sentence, words: w.filter((x) => wordsOf(n.clause).includes(x)) })).filter((r) => r.words.length);
}

// The rules a check can hold a prototype to, read from the guidelines as written: "one <component> per screen",
// "only one <component> on a page", "at most <n> <components> per page". Each keeps the sentence it came from.
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, single: 1 };
export function limitsFrom(components, rules, names) {
  const out = [];
  const texts = [...Object.entries(components).filter(([, k]) => k.guidelines).map(([n, k]) => ({ text: k.guidelines, about: n, from: `guidelines, ${n}` })),
    ...rules.map((r) => ({ text: r.text, about: null, from: `guidelines, ${r.title}` }))];
  for (const t of texts) {
    for (const sentence of t.text.split(/(?<=[.!?])\s+/)) {
      for (const name of names) {
        const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = new RegExp(`\\b(?:only\\s+|at most\\s+|no more than\\s+)?(one|two|three|four|five|single|\\d+)\\s+${n}s?\\s+(?:per|on each|in each|for each|on a|on the|in a)\\s+(screen|page|view|dialog)`, 'i').exec(sentence)
          ?? (t.about === name ? new RegExp(`^\\s*(one|two|three|single|\\d+)\\s+per\\s+(screen|page|view|dialog)`, 'i').exec(sentence) : null);
        if (m) out.push({ component: name, max: NUM[m[1].toLowerCase()] ?? Number(m[1]), per: m[2].toLowerCase(), sentence: sentence.trim(), from: t.from });
      }
    }
  }
  const seen = new Set();
  return out.filter((l) => !seen.has(l.component) && seen.add(l.component));
}

const said = (k) => k && (k.purpose || k.role || k.notes.length || k.notFor || k.guidelines || k.useInstead?.length || k.status || k.options?.length);

// One block per component for the catalog: what it is for, its role, its options' meaning, when not to use it, the
// team's notes and its guidelines.
export function purposeLines(ctx, names, { width = 400 } = {}) {
  const list = names.filter((n) => said(ctx.components[n]));
  if (!list.length) return [];
  const pad = Math.max(...list.map((n) => n.length));
  const out = [];
  for (const n of list) {
    const k = ctx.components[n];
    const head = [k.purpose, k.role ? `Role ${k.role}.` : null, k.status ? `[${k.status}${k.useInstead?.length ? `: use ${k.useInstead.join(' or ')}` : ''}]` : null].filter(Boolean).join(' ');
    out.push(`  ${n.padEnd(pad)}  ${cut(head || '(no description yet)', width)}`);
    const more = (label, text) => out.push(`  ${' '.repeat(pad)}    ${label} ${cut(text, width)}`);
    for (const o of k.options) more('option', o);
    if (k.notFor) more('not for', `${k.notFor}${k.useInstead?.length && !k.status ? `; use ${k.useInstead.join(' or ')}` : ''}`);
    for (const note of k.notes.slice(0, 3)) more('note', note);
    if (k.guidelines) more('guidelines', k.guidelines);
  }
  return out;
}

// The team's rules for the product, each section on its own line (the full text stays in its file).
export function ruleLines(ctx, { width = 500 } = {}) {
  return ctx.rules.map((r) => `  ${r.title}${r.file ? ` (${r.file})` : ''}: ${cut(r.text.replace(/\s+/g, ' '), width)}`);
}

// What the person asked for, against everything known: the guidelines' opening text (it is for every page) and the
// sections the request touches, in full; the components
// its words point to (by name, description, options or guidelines), and the pages closest to it.
// pages: [{ name, label, text, designed, file }] (prototypes already made and designed screens).
export function requestFocus(ctx, request, pages = []) {
  const words = wordsOf(request);
  if (!words.length) return null;
  const hit = (text) => { const w = wordsOf(text); return words.filter((x) => w.includes(x)); };
  const sections = ctx.rules.map((r) => {
    const inHead = hit(r.title), inBody = hit(r.text);
    return { ...r, score: inHead.length * 3 + inBody.length, matched: [...new Set([...inHead, ...inBody])] };
  }).filter((r) => r.score >= 2 || r.matched.length >= 2 || r.title === 'guidelines').sort((a, b) => (b.title === 'guidelines') - (a.title === 'guidelines') || b.score - a.score).slice(0, 5);
  const positive = (k) => [k.purpose, k.role, ...k.options, ...(k.guidelines ?? '').split(/(?<=[.!?])\s+/), ...k.notes].filter((x) => x && !NEVER.test(x)).join(' ');
  // A word many components' notes share (the product's name) points to none of them.
  const docs = Object.entries(ctx.components).map(([name, k]) => [name, hit(positive(k))]);
  const common = new Set(words.filter((w) => docs.filter(([, m]) => m.includes(w)).length > Math.max(2, docs.length / 4)));
  // Ranked: a component the request names first, then one whose documentation shares two of its words or more.
  const components = docs.map(([name, m]) => {
    const byName = words.filter((w) => name.toLowerCase().includes(w) || (name.length >= 3 && w.includes(name.toLowerCase())));
    const byDocs = m.filter((w) => !common.has(w) && !byName.includes(w));
    const inPurpose = byDocs.filter((w) => wordsOf(ctx.components[name].purpose ?? '').includes(w));
    return { name, matched: [...new Set([...byName, ...byDocs])], score: byName.length * 3 + inPurpose.length + byDocs.length, purpose: ctx.components[name].purpose };
  }).filter((c) => c.score >= 2).sort((a, b) => b.score - a.score).slice(0, 6);
  const out = Object.entries(ctx.components).flatMap(([name, k]) => ruledOut(k, request, name).map((r) => ({ name, ...r })));
  const scored = pages.map((p) => ({ ...p, matched: [...new Set([...hit(p.name), ...hit(p.text ?? '')])] })).filter((p) => p.matched.length).sort((a, b) => b.matched.length - a.matched.length || b.designed - a.designed);
  return { request: String(request).trim(), words, sections, components, ruledOut: out, pages: scored.slice(0, 3) };
}

// The lines the catalog prints for a request.
export function focusLines(f) {
  if (!f) return [];
  const out = ['', `FOR THIS REQUEST  "${cut(f.request.replace(/\s+/g, ' '), 160)}"`];
  if (f.pages.length) out.push(`  start from: ${f.pages.map((p) => `${p.label}${p.file ? ` (${p.file})` : ''}`).join('; ')}`);
  if (f.components.length) out.push(`  components its words point to: ${f.components.map((c) => `${c.name} (${c.matched.join(', ')}${c.purpose ? `: ${cut(c.purpose, 80)}` : ''})`).join('; ')}`);
  for (const r of f.ruledOut ?? []) out.push(`  ruled out by the documentation for "${r.words.join(', ')}": ${r.name}, "${cut(r.sentence, 200)}"; what the request needs there is a Missing box unless another component is for it`);
  if (f.sections.length) {
    out.push('  the team\'s guidelines that apply (follow them; say so when the request asks for something they rule out):');
    for (const s of f.sections) out.push(`    ${s.title}${s.file ? ` (${s.file})` : ''}: ${cut(s.text.replace(/\s+/g, ' '), 1200)}`);
  }
  out.push('  Every word of the request that no component is for is a Missing box, or a component with "standInFor".');
  return out;
}

// After a prototype is drawn: what the documentation says about each system component it uses, beside what the
// prototype uses it for (its labels and texts), so a use the component is not for stands out.
export function usesAgainstPurpose(ctx, nodes) {
  const byComponent = new Map();
  for (const n of nodes) {
    const k = ctx.components[n.component];
    if (!k) continue;
    const p = n.props ?? {};
    const what = p.standInFor ? `stand-in for ${p.standInFor}` : [p.Label, p.label, p.text, p.Text, p.placeholder, p.Placeholder, p['aria-label']].find((v) => typeof v === 'string' && v.trim()) ?? null;
    if (!byComponent.has(n.component)) byComponent.set(n.component, []);
    if (what) byComponent.get(n.component).push(what);
  }
  return [...byComponent].filter(([name]) => said(ctx.components[name])).map(([name, uses]) => {
    const k = ctx.components[name];
    const rule = [k.purpose, k.role ? `Role ${k.role}.` : null, k.notFor ? `Not for ${k.notFor.replace(/^not for\s*/i, '')}` : null, k.guidelines ? `Guidelines: ${cut(k.guidelines, 240)}` : null].filter(Boolean).join(' ');
    return { component: name, uses: [...new Set(uses)], rule };
  });
}

// What the request asks for, held against the composition:
//   • a component the request names (all the words of its name are in it: "an empty state" → emptyState, "a switch"
//     → switch) that the composition does not use: a warning the reply owes;
//   • a component the documentation rules out for the request's words ("a message confirming…" and a tag that is
//     "never a message that comes and goes"), used anyway: an error, unless the node says in "purpose" what else it
//     is for, and that purpose is not ruled out too.
const nameWords = (n) => wordsOf(String(n).replace(/^[._]+/, ''));
export function requestFindings(ctx, request, nodes) {
  const out = [];
  if (!request) return out;
  const asked = wordsOf(request);
  const used = new Set(nodes.map((n) => n.component));
  for (const name of Object.keys(ctx.components)) {
    const w = nameWords(name);
    if (!w.length || used.has(name) || !w.every((x) => asked.includes(x))) continue;
    out.push({ rule: null, source: 'the request', level: 'warning', id: null, said: `asked:${name}`, kind: 'request', message: `the request asks for ${w.join(' ')} and the system has ${name}, which is not in the prototype: add it, or say why it is left out` });
  }
  for (const n of nodes) {
    const k = ctx.components[n.component];
    if (!k || n.props?.standInFor) continue;   // a stand-in is judged by its own need
    const hits = ruledOut(k, request, n.component);
    if (!hits.length) continue;
    const purpose = n.props?.purpose;
    if (purpose && !ruledOut(k, purpose, n.component).length) continue;
    out.push({ rule: null, source: 'the team\'s documentation', level: 'error', id: n.id, message: `${n.component} is ruled out for "${hits[0].words.join(', ')}" in this request: "${hits[0].sentence}". Show that need as a Missing box; if this ${n.component} is for something else, write it in "purpose"` });
  }
  const seen = new Set();
  return out.filter((f) => { const key = f.said ?? f.message; return !seen.has(key) && seen.add(key); });
}

// The guidelines' limits a composition breaks: [{ component, max, count, sentence, from }].
export function limitFindings(limits, nodes) {
  const count = new Map();
  for (const n of nodes) count.set(n.component, (count.get(n.component) ?? 0) + 1);
  return limits.filter((l) => (count.get(l.component) ?? 0) > l.max).map((l) => ({ ...l, count: count.get(l.component) }));
}
