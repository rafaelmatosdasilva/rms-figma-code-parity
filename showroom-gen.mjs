// showroom-gen.mjs — generate the living style-guide HTML from the design system.
//
// The showroom is a GENERATED VIEW over canonical sources — nothing is hand-kept.
// A template (structure + per-component render patterns, DS-specific, private)
// carries `{{markers}}`; this generator fills each marker with data gathered LIVE
// from Figma + code, then writes the HTML. Because it only ever renders what the
// DS actually contains, the showroom can never drift from — or invent — anything
// the system doesn't have (the same guarantee the docs-truth gate checks).
//
// Sources gathered:
//   • THEME_CSS  — paths.themeCSS (the real tokens), with its dark @media guarded
//                  to :root:not([data-color]) so the manual mode toggle wins.
//   • ICON_SHEET — the DS icon <symbol> set, from a built plugin ui.html.
//   • USAGE      — which plugins use each component (scanned from plugin source).
//   • DOCS_CODE  — per-component code notes, from the design-intent layer.
//   • DOCS       — Figma component descriptions/annotations, from design-intent.
//
// Config (ds-config.json → showroom):
//   { template: "<path to .template.html>", out: "<path to write index.html>",
//     iconSource: "<plugin ui.html to lift the icon sheet from>" }
//
// Exit 0 on success. Never throws into the audit — callers wrap it.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

export async function generateShowroom(ROOT, cfg, opts = {}) {
  const sh = cfg.showroom || {};
  const templatePath = resolve(ROOT, sh.template || 'apps/style-guide/showroom.template.html');
  const outPath = resolve(ROOT, sh.out || 'apps/style-guide/index.html');
  if (!existsSync(templatePath)) throw new Error('showroom template not found: ' + templatePath);
  let html = readFileSync(templatePath, 'utf8');

  const themeFiles = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const pluginCSS = (cfg.paths?.pluginCSS ?? []).flat();
  const pluginHTML = (cfg.paths?.plugins ?? []).flat();

  // ── THEME_CSS ────────────────────────────────────────────────────────────────
  function themeCSS() {
    const css = themeFiles.map((p) => { const abs = resolve(ROOT, p); return existsSync(abs) ? readFileSync(abs, 'utf8') : ''; }).join('\n\n');
    // Guard the system-preference dark block so an explicit data-color wins: the
    // manual toggle is the authority, prefers-color-scheme is only the Auto path.
    return css.replace(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/g,
      '@media (prefers-color-scheme: dark) {\n    :root:not([data-color]) {');
  }

  // ── ICON_SHEET ───────────────────────────────────────────────────────────────
  function iconSheet() {
    const src = sh.iconSource ? resolve(ROOT, sh.iconSource) : (pluginHTML[0] ? resolve(ROOT, pluginHTML[0]) : null);
    if (!src || !existsSync(src)) return '';
    const doc = readFileSync(src, 'utf8');
    const syms = doc.match(/<symbol\b[\s\S]*?<\/symbol>/g) || [];
    if (!syms.length) return '';
    return '<svg id="ds-icon-sheet" width="0" height="0" style="position:absolute" aria-hidden="true">' + syms.join('') + '</svg>';
  }

  // ── design-intent (notes) ──────────────────────────────────────────────────────
  function designIntent() {
    const p = resolve(ROOT, (cfg.docs?.out) || join(dirname(themeFiles[0] || 'src/theme.css'), 'design-intent.json'));
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { components: {} }; }
  }
  function docsMaps(intent) {
    const comps = intent.components || {};
    const docs = {}, code = {};
    for (const [name, def] of Object.entries(comps)) {
      const d = def.design || {};
      const desc = d.description || (d.annotations && d.annotations[0]);
      if (desc) docs[name] = String(desc).replace(/\s+/g, ' ').trim();
      const c = def.code || {};
      let note = (c.note || '').trim();
      if (!note && c.cssComment) note = String(c.cssComment).replace(/[─—]+/g, ' ').replace(/\s+/g, ' ').trim();
      // Strip hardcoded pixel dimensions — docs describe with tokens, not values.
      note = note.replace(/\b\d+\s*[×x]\s*\d+\b/g, '').replace(/\bh=\d+[^,;)]*\)?/g, '').replace(/\b\d+px\b/g, '').replace(/\s{2,}/g, ' ').replace(/\(\s*\)/g, '').trim();
      if (note && note.length > 20) code[name.toLowerCase()] = note;
    }
    return { docs, code };
  }

  // ── USAGE — which plugins use each component ────────────────────────────────────
  function usageMap(intent) {
    // Plugin label ← short code, derived from the plugin source path.
    const PLUGS = (cfg.showroom?.plugins) || [
      { key: 'IA', match: 'impact-atlas' }, { key: 'TTI', match: 'tokens-to-ink' }, { key: 'FSL', match: 'font-scaling-lab' },
    ];
    const sources = pluginHTML.concat(pluginCSS).map((p) => ({ p, m: PLUGS.find((g) => p.includes(g.match)), txt: (() => { const abs = resolve(ROOT, p); return existsSync(abs) ? readFileSync(abs, 'utf8') : ''; })() })).filter((s) => s.m);
    const usage = {};
    for (const name of Object.keys(intent.components || {})) {
      const cls = intent.components[name].class || ('.' + name);
      const bare = cls.replace(/^\./, '');
      const found = new Set();
      for (const s of sources) if (s.txt.includes(cls) || s.txt.includes('"' + bare) || s.txt.includes(bare + ' ')) found.add(s.m.key);
      usage[name] = [...found];
    }
    return usage;
  }

  // ── Fill the template ───────────────────────────────────────────────────────────
  const intent = designIntent();
  const { docs, code } = docsMaps(intent);
  const fills = {
    THEME_CSS: () => themeCSS(),
    ICON_SHEET: () => iconSheet(),
    USAGE: () => JSON.stringify(usageMap(intent)),
    DOCS_CODE: () => JSON.stringify(code),
    DOCS: () => JSON.stringify(docs),
  };
  const filled = [];
  for (const [key, fn] of Object.entries(fills)) {
    // Wrapped forms FIRST — a bare `{{KEY}}` is a substring of `<!--{{KEY}}-->`
    // and `/*{{KEY}}*/`, so replacing it first would leave the fill inside a
    // comment. Replacing the wrapped form removes the wrapper entirely.
    const markers = [`<!--{{${key}}}-->`, `/*{{${key}}}*/`, `{{${key}}}`];
    let hit = false, value = null;
    for (const m of markers) if (html.includes(m)) { if (value === null) value = fn(); html = html.split(m).join(value); hit = true; }
    if (hit) filled.push(key);
  }

  writeFileSync(outPath, html);
  return { out: outPath, filled, bytes: html.length, components: Object.keys(intent.components || {}).length };
}
