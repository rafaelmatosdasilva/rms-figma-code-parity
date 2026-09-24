// ── Design-intent generator (generic) ───────────────────────────────────────
// Aggregates a project's design INTENT into ONE private file, as a generated
// VIEW over the canonical sources — nothing is hand-copied:
//   • Design intent  → Figma component descriptions + annotations (captured into
//                      the component-props snapshot each parity run).
//   • Code intent    → per-component notes in structure-contract.mjs (_note) and
//                      the comment that precedes each component rule in theme.css.
//   • Facts          → structure snapshot (height, padding/gap tokens, variants).
//   • Usage          → which plugin sources reference each component's class.
//
// It is an INTENT LAYER, not just components:
//   { system, foundations, components, patterns, templates, pages, flows }
// Components is auto-derived today; the other layers are yours to author. Because
// the file is regenerated every run, the generator is MERGE-AWARE: it reads the
// existing file, PRESERVES everything you authored (the `authored` block on any
// layer, and per-component `authored`), and only refreshes the derived fields.
// Regeneration never destroys hand-written intent, so it can stay one file.
//
// Output: design-intent.json — PROJECT-SPECIFIC, meant to stay private (gitignore).
// Generic: no project names, tokens, or components are hardcoded.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveStatus } from './decision-status.mjs';

const LAYERS = ['system', 'foundations', 'components', 'patterns', 'templates', 'pages', 'flows'];

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

function classOf(name, cfg) {
  const sel = cfg?.componentSelectors?.[name];
  if (sel) return sel.match(/[.#][\w-]+/)?.[0] || sel;
  return '.' + name.charAt(0).toLowerCase() + name.slice(1);
}

function usageOf(cls, sources) {
  const tok = cls.replace(/^[.#]/, '');
  const out = [];
  for (const [label, text] of sources) if (text.includes(tok)) out.push(label);
  return out;
}

// The comment block immediately preceding a component's CSS rule in theme.css.
// Index-based (no regex backtracking over a large stylesheet).
function cssNoteFor(cls, css) {
  const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{').exec(css);
  if (!m) return '';
  const before = css.slice(0, m.index);
  const end = before.lastIndexOf('*/');
  if (end === -1 || before.slice(end + 2).trim() !== '') return ''; // comment must sit right above the rule
  const start = before.lastIndexOf('/*', end);
  if (start === -1) return '';
  return before.slice(start + 2, end).split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').replace(/\s*─+\s*$/, '').trim())
    .filter(Boolean).join(' ').trim().slice(0, 600);
}

const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Split a markdown doc into a pre-heading "general" chunk + one section per heading.
function parseSections(text) {
  const parts = String(text).split(/^#{1,6}\s+(.+)$/m);
  const general = (parts.shift() || '').trim();
  const sections = [];
  for (let i = 0; i < parts.length; i += 2) {
    sections.push({ heading: (parts[i] || '').trim(), body: (parts[i + 1] || '').trim() });
  }
  return { general, sections };
}

// External guidelines ingestion (guidance → INTENT). Reads the committed files listed in
// ds-config.json → guidelines.sources (markdown or JSON), folds each section into the matching
// component (heading text = component name) and collects the rest as a global block. Advisory,
// never a gate. A live Notion/URL fetch, when configured, is a separate capture step that WRITES
// these files first; the generator always reads the committed file, for determinism.
function ingestGuidelines(ROOT, cfg) {
  const raw = cfg.guidelines?.sources;
  const files = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const sections = [];          // { heading, body } - matched to a component by heading, else global
  const generalParts = [];      // pre-heading text and JSON _general
  const used = [];
  const blobs = [];
  for (const rel of files) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    let txt; try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    used.push(rel); blobs.push(txt);
    if (rel.toLowerCase().endsWith('.json')) {
      const obj = readJSON(abs) || {};
      for (const [k, v] of Object.entries(obj)) {
        const val = typeof v === 'string' ? v.trim() : '';
        if (!val) continue;
        if (/^_?general$/i.test(k)) generalParts.push(val);
        else sections.push({ heading: k, body: val });
      }
    } else {
      const parsed = parseSections(txt);
      if (parsed.general) generalParts.push(parsed.general);
      for (const s of parsed.sections) if (s.body) sections.push(s);
    }
  }
  const hash = blobs.length ? createHash('sha1').update(blobs.join('\n---\n')).digest('hex').slice(0, 12) : null;
  return { sources: used, hash, sections, general: generalParts.join('\n\n').trim() };
}

export async function generateIntent(ROOT, cfg, opts = {}) {
  const paths = cfg.paths || {};
  const themeCss = Array.isArray(paths.themeCSS) ? paths.themeCSS[0] : paths.themeCSS;
  const dsDir = themeCss ? dirname(resolve(ROOT, themeCss)) : ROOT;
  const outPath = cfg.docs?.out ? resolve(ROOT, cfg.docs.out) : join(dsDir, 'design-intent.json');

  const structure = readJSON(resolve(ROOT, paths.snapshotStructure || 'figma-structure.snapshot.json'))?.components || {};
  const props = readJSON(resolve(ROOT, paths.compPropsSnapshot || 'figma-component-props.snapshot.json')) || {};
  const css = themeCss ? readFileSync(resolve(ROOT, themeCss), 'utf8') : '';

  let CONTRACT = {};
  const contractPath = resolve(ROOT, cfg.paths?.structureContract || 'structure-contract.mjs');
  if (existsSync(contractPath)) {
    try { CONTRACT = (await import(pathToFileURL(contractPath).href)).CONTRACT || {}; } catch { /* keep going */ }
  }

  // Authored agent guidance (whenNotToUse / useInstead) lives in the committed contract.authored.json.
  const authoredPath = cfg.contracts?.authored ? resolve(ROOT, cfg.contracts.authored) : join(ROOT, 'contract.authored.json');
  const authoredComps = (readJSON(authoredPath) || {}).components || {};

  const sources = [];
  for (const p of (paths.pluginCSS || [])) {
    const abs = resolve(ROOT, p);
    if (existsSync(abs)) sources.push([p.split('/').slice(-2, -1)[0] || p, readFileSync(abs, 'utf8')]);
  }

  // ── Merge base: keep everything authored from the existing file ─────────────
  const prev = readJSON(outPath) || {};
  const intent = {
    _generated: new Date().toISOString(),
    _note: 'Design-intent layer. AUTHORED fields (each layer\'s `authored`, and per-component `authored`) are preserved across regenerations; everything else is a generated view of Figma + code. Keep this file private (gitignored).',
    _sources: {
      figma: paths.compPropsSnapshot, structure: paths.snapshotStructure, code: themeCss,
      contract: existsSync(contractPath) ? (cfg.paths?.structureContract || 'structure-contract.mjs') : null,
    },
  };
  // Non-component layers: authored-only, preserved verbatim.
  for (const L of LAYERS) {
    if (L === 'components') continue;
    intent[L] = { authored: prev[L]?.authored ?? '' };
  }

  // ── Components: derived aggregation + preserved per-component `authored` ─────
  intent.components = {};
  for (const name of Object.keys(structure)) {
    const s = structure[name] || {};
    const cls = classOf(name, cfg);
    const pr = props[name] || {};
    const annotations = (pr.annotations || []).map(a => (a.label || a)).filter(Boolean);
    const variants = Object.keys(s.variantHeight || s.variantStroke || {});
    const ag = authoredComps[name] || {};
    const agUseInstead = Array.isArray(ag.useInstead)
      ? ag.useInstead.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : (typeof ag.useInstead === 'string' && ag.useInstead.trim() ? [ag.useInstead.trim()] : []);
    const agWhenNot = typeof ag.whenNotToUse === 'string' && ag.whenNotToUse.trim() ? ag.whenNotToUse.trim() : null;
    intent.components[name] = {
      class: cls,
      authored: prev.components?.[name]?.authored ?? '',   // your own per-component intent, preserved
      usedIn: usageOf(cls, sources),
      design: {                                            // canonical: Figma
        description: (pr.description || '').trim() || null,
        annotations,
      },
      code: {                                              // canonical: code
        note: (s._note || CONTRACT[name]?._note || '').trim() || null,
        cssComment: cssNoteFor(cls, css) || null,
      },
      guidance: (agWhenNot || agUseInstead.length)         // authored: when NOT to use, and what instead
        ? { whenNotToUse: agWhenNot, useInstead: agUseInstead.length ? agUseInstead : null } : null,
      status: resolveStatus(ag, pr.description),           // I33: current/deprecated/experimental + what won + why
      facts: {
        height: s.h ?? null,
        paddingVar: s.paddingVar || null,
        gapVar: s.gapVar ?? null,
        fillStructure: s.fillStructure || null,
        strokeSides: s.strokeSides || null,
        variants: variants.length ? variants : null,
        properties: (pr.props || []).length ? pr.props : null,
      },
    };
  }

  // ── External guidelines (guidance → INTENT), advisory ──────────────────────
  // Fold a project's own guidelines doc(s) into the intent so agents read the "why". A section whose
  // heading matches a component name attaches to that component; the rest becomes a global block.
  const GL = ingestGuidelines(ROOT, cfg);
  if (GL.sources.length) {
    const compByKey = new Map(Object.keys(intent.components).map(n => [normName(n), n]));
    const perComp = new Map();   // component name -> [bodies]
    const leftover = [];         // sections that match no component -> the global block (heading kept)
    for (const s of GL.sections) {
      const name = compByKey.get(normName(s.heading));
      if (name) { if (!perComp.has(name)) perComp.set(name, []); perComp.get(name).push(s.body); }
      else leftover.push(`## ${s.heading}\n${s.body}`);
    }
    for (const [name, bodies] of perComp) intent.components[name].guidelines = bodies.join('\n\n');
    const general = [GL.general, ...leftover].filter(Boolean).join('\n\n').trim();
    intent.guidelines = { _sources: GL.sources, _hash: GL.hash, general: general || null };
  }

  writeFileSync(outPath, JSON.stringify(intent, null, 2) + '\n');
  const names = Object.keys(intent.components);
  return {
    out: outPath,
    components: names.length,
    withDesign: names.filter(n => intent.components[n].design.annotations.length || intent.components[n].design.description).length,
    withCode: names.filter(n => intent.components[n].code.note || intent.components[n].code.cssComment).length,
    authoredKept: names.filter(n => intent.components[n].authored).length + LAYERS.filter(L => L !== 'components' && intent[L].authored).length,
    withGuidelines: names.filter(n => intent.components[n].guidelines).length,
    guidelineSources: GL.sources.length,
  };
}
