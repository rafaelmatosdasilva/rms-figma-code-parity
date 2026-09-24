// structure-capture.mjs - the code capture's structural facts: component APIs (props, defaults,
// allowed values, slots), icons, markup and nesting.
//
// Each reading is the one the matching gate uses (component-api.mjs, icon-source.mjs,
// markup-source.mjs, component-source.mjs), so the snapshot and the gates never disagree about
// what the code says. Nesting is read twice where possible: from the rendered page (markup built
// by JavaScript counts) and from the component's source file.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createApiReader } from './component-api.mjs';
import { readSymbols, iconRefs, pathHash } from './icon-source.mjs';
import { fingerprint, markupClassSet } from './markup-source.mjs';
import { norm, usedComponents } from './component-source.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export function markupSnapshotPath(cfg = {}) {
  const themeCSS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat()[0];
  return themeCSS.replace(/[^/\\]+$/, 'html-structure.snapshot.json');
}

// Every input file the structural readings depend on (for the capture's content hash).
export function structureInputFiles(ROOT, cfg = {}, apiReader) {
  const list = [
    ...(cfg.paths?.pluginCSS ?? []), ...(cfg.paths?.sharedIconSources ?? []), ...(cfg.iconCheck?.usageSources ?? []),
    markupSnapshotPath(cfg), 'component-composition.snapshot.json', 'custom-elements.json', 'package.json',
    ...[cfg.codeReading?.docgen ?? []].flat(), cfg.codeReading?.storybookIndex ?? 'storybook-static/index.json',
  ].map((p) => resolve(ROOT, p));
  if (apiReader) list.push(...apiReader.files);
  return [...new Set(list)];
}

// ── Component APIs ────────────────────────────────────────────────────────────
// The API reader walks the component files once; create it with apiReaderFor() before hashing the
// inputs, then read every component with captureApis().
export function apiReaderFor(ROOT, cfg, { classFor, nodeIds } = {}) {
  return cfg.frameworkComponents === false ? null : createApiReader(ROOT, cfg, { classFor, nodeIds });
}
export function captureApis(ROOT, specs, reader) {
  if (!reader) return { api: {}, note: 'frameworkComponents is false: components are markup and CSS, so there are no props to read' };
  const api = {};
  for (const s of specs) {
    if (s.unbuilt) continue;
    const a = reader.apiFor(s.name);
    if (!a.file && !Object.keys(a.props).length) { api[s.name] = { file: null, how: a.how }; continue; }
    api[s.name] = {
      file: a.file ? relative(ROOT, a.file) : null, how: a.how, readBy: a.readBy,
      props: a.props, slots: a.slots, ...(a.codeConnect ? { codeConnect: a.codeConnect } : {}),
    };
  }
  return { api, sources: reader.sources };
}

// ── Icons ─────────────────────────────────────────────────────────────────────
export function captureIcons(ROOT, cfg) {
  const html = (cfg.paths?.pluginCSS ?? []).filter((f) => f.endsWith('.html'));
  const defFiles = [...html, ...(cfg.paths?.sharedIconSources ?? [])];
  const symbols = readSymbols(ROOT, defFiles);
  const refFiles = [...defFiles, ...(cfg.iconCheck?.usageSources ?? [])];
  const refs = iconRefs(ROOT, refFiles, symbols.map((s) => s.id));
  const icons = {};
  for (const s of symbols) {
    const e = icons[s.id] ??= {
      viewBox: s.viewBox,
      paths: s.paths.length,
      pathHash: pathHash(s.paths),
      fillNone: s.fillNone, strokeNone: s.strokeNone,
      ...(s.transforms.length ? { transforms: s.transforms } : {}),
      definedAt: [],
      usedAt: refs[s.id] ?? [],
    };
    e.definedAt.push(`${s.file}:${s.line}`);
  }
  return icons;
}

// ── Markup ────────────────────────────────────────────────────────────────────
export function captureMarkup(ROOT, cfg) {
  const stored = readJson(join(ROOT, markupSnapshotPath(cfg))) ?? {};
  const { classes, from } = markupClassSet(cfg, stored);
  const apps = cfg.paths?.plugins ?? [], src = cfg.paths?.pluginCSS ?? [];
  const out = { _classes: { from, count: classes.size } };
  apps.forEach((app, i) => {
    const p = src[i];
    if (!p || !existsSync(join(ROOT, p))) return;
    out[app] = { file: p, ...fingerprint(readFileSync(join(ROOT, p), 'utf8'), classes) };
  });
  return out;
}

// ── Nesting ───────────────────────────────────────────────────────────────────
// In the page: for every instance of every component, which other DS components sit inside it.
export function nestingExpression(specs) {
  return `(() => {
    const specs = ${JSON.stringify(specs.map((s) => ({ name: s.name, selector: s.selector })))};
    const out = {};
    const all = (sel, root) => { try { return root.querySelectorAll(sel); } catch { return []; } };
    for (const s of specs) {
      const els = all(s.selector, document);
      if (!els.length) continue;
      const e = out[s.name] = { instances: els.length, contains: {} };
      for (const el of els) for (const o of specs) {
        if (o.name === s.name) continue;
        const hit = [...all(o.selector, el)].some((x) => x !== el);
        if (hit) e.contains[o.name] = (e.contains[o.name] || 0) + 1;
      }
    }
    return out;
  })()`;
}

// Merge the per-page rendered readings with the source reading into nesting facts.
//   rendered: { pageLabel: { comp: { instances, contains: { child: n } } } }
//   source:   { comp: Set(child) }  (only for components whose source file was found)
export function mergeNesting(rendered = {}, source = {}) {
  const out = {};
  const names = new Set([...Object.values(rendered).flatMap((p) => Object.keys(p)), ...Object.keys(source)]);
  for (const name of [...names].sort()) {
    const contains = {};
    for (const [page, per] of Object.entries(rendered)) {
      for (const [child, n] of Object.entries(per[name]?.contains ?? {})) {
        const c = contains[child] ??= { renderedIn: [], instances: 0 };
        c.renderedIn.push(page);
        c.instances += n;
      }
    }
    for (const child of source[name] ?? []) (contains[child] ??= {}).inSource = true;
    for (const c of Object.values(contains)) {
      const r = !!c.renderedIn?.length;
      c.confidence = r && c.inSource ? 'verified' : 'single-source';
      c.readBy = r && c.inSource ? 'rendered + source' : r ? 'rendered' : 'source';
    }
    const seen = Object.values(rendered).reduce((n, p) => n + (p[name]?.instances ?? 0), 0);
    if (seen || Object.keys(contains).length) out[name] = { instancesSeen: seen, contains };
  }
  return out;
}

// Source nesting: for each component with a source file, which DS components the file uses.
export function sourceNesting(specs, apiReader, classFor) {
  if (!apiReader) return {};
  const universe = specs.map((s) => ({ name: s.name, selNorm: norm(classFor(s.name)) }));
  const out = {};
  for (const s of specs) {
    const { file } = apiReader.fileFor(s.name);
    if (!file) continue;
    const used = usedComponents(apiReader.read(file), universe);
    used.delete(s.name);
    out[s.name] = used;
  }
  return out;
}

export async function renderedNesting({ send, pages, specs, openLoaded }) {
  const out = {}, notRead = [];
  const expr = nestingExpression(specs.filter((s) => !s.unbuilt));
  for (const pg of pages) {
    const { targetId, sessionId } = await openLoaded(send, pg.url);
    if (!sessionId) { notRead.push(`${pg.label}: page did not load (nesting)`); continue; }
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
      out[pg.label] = r.result?.value ?? {};
    } catch (e) { notRead.push(`${pg.label}: nesting not read (${e.message.split('\n')[0]})`); }
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
  return { rendered: out, notRead };
}
