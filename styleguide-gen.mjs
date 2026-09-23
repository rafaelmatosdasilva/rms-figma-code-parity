// styleguide-gen.mjs — generate the living styleguide HTML from the design system.
//
// The styleguide is a GENERATED VIEW over canonical sources — nothing is hand-kept.
// A template (structure + per-component render patterns, DS-specific, private)
// carries `{{markers}}`; this generator fills each marker with data gathered LIVE
// from Figma + code, then writes the HTML. Because it only ever renders what the
// DS actually contains, the styleguide can never drift from — or invent — anything
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
// Config (ds-config.json → styleguide):
//   { template: "<path to .template.html>", out: "<path to write index.html>",
//     iconSource: "<plugin ui.html to lift the icon sheet from>" }
//
// Exit 0 on success. Never throws into the audit — callers wrap it.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { resolveNamingSpec, tokenToVar, DEFAULT_NAMING } from './naming-convention.mjs';

// ── DS-derived colour-mode CSS ────────────────────────────────────────────────
// The DS expresses colour mode ONLY as @media (prefers-color-scheme: dark). The
// styleguide needs a MANUAL, per-component toggle, so we derive [data-color] rules
// straight from those @media blocks - nothing is hand-copied and no value is
// invented. Each @media block is ALSO gated to :root:not([data-color]) so the
// manual toggle always wins over the OS preference (and a per-component override
// wins over the global one, because [data-color] custom properties inherit from
// the nearest scope). Colour vars are chosen by transitive closure over the
// dark-overridden primitives, which excludes the size/typography axes so a
// colour scope never fights the [data-size] axis.
function _matchBlock(s, openIdx) {
  let d = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return { body: s.slice(openIdx + 1, i), end: i }; }
  }
  return { body: s.slice(openIdx + 1), end: s.length };
}
function _declMap(body) {
  const m = {};
  body.replace(/\/\*[\s\S]*?\*\//g, '').split(';').forEach((d) => {
    const c = d.indexOf(':'); if (c < 0) return;
    const k = d.slice(0, c).trim(), v = d.slice(c + 1).trim();
    if (k.startsWith('--')) m[k] = v;
  });
  return m;
}
function _balanceCSS(s) {
  // Make CSS brace-balanced by DROPPING stray top-level `}` (a DS token file may
  // carry an orphan brace) and closing any unclosed blocks. String- and comment-
  // aware (a `content: "}"` or a brace in a comment must not count). Unlike a
  // trailing-strip, this removes the stray close AT ITS POSITION, so a mid-file
  // orphan does not cost a real closing brace of the last rule.
  let out = '', depth = 0, inC = false, inS = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inC) { out += c; if (c === '*' && n === '/') { out += n; i++; inC = false; } continue; }
    if (inS) { out += c; if (c === inS) inS = null; continue; }
    if (c === '/' && n === '*') { out += c + n; i++; inC = true; continue; }
    if (c === '"' || c === "'") { out += c; inS = c; continue; }
    if (c === '{') { depth++; out += c; continue; }
    if (c === '}') { if (depth === 0) continue; depth--; out += c; continue; } // drop stray top-level close
    out += c;
  }
  if (depth > 0) out += '\n' + '}'.repeat(depth);   // close any still-open blocks
  return out;
}
function _mediaRules(inner) {
  const clean = inner.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = []; let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf('{', i); if (open < 0) break;
    const sel = clean.slice(i, open).trim();
    const { body, end } = _matchBlock(clean, open);
    if (sel) out.push({ sel, body: body.trim() });
    i = end + 1;
  }
  return out;
}
export function deriveModeCSS(raw) {
  const rootHead = raw.search(/:root\s*\{/);
  if (rootHead < 0) return raw;
  const baseMap = _declMap(_matchBlock(raw, raw.indexOf('{', rootHead)).body);
  const baseOrder = Object.keys(baseMap);

  const darkMap = {}; const compRules = [];
  let out = '', last = 0;
  const re = /@media\s*\(prefers-color-scheme:\s*dark\)\s*/g; let m;
  while ((m = re.exec(raw))) {
    const open = raw.indexOf('{', m.index);
    const { body, end } = _matchBlock(raw, open);
    const gated = _mediaRules(body).map((r) => {
      const sel = r.sel === ':root' ? ':root:not([data-color])' : ':root:not([data-color]) ' + r.sel;
      if (r.sel === ':root') Object.assign(darkMap, _declMap(r.body));
      else compRules.push(r);
      return '    ' + sel + ' { ' + r.body + ' }';
    }).join('\n');
    out += raw.slice(last, m.index) + '@media (prefers-color-scheme: dark) {\n' + gated + '\n  }';
    last = end + 1; re.lastIndex = end + 1;
  }
  out += raw.slice(last);

  // The DS token file must inject as BALANCED CSS: the manual [data-color] blocks
  // we append have to sit at the top level. A DS file can carry an orphan brace
  // (harmless standalone - the browser discards a stray top-level `}` - but when
  // content follows, an unmatched brace swallows the next rule). Normalise it.
  out = _balanceCSS(out);

  // transitive closure: dark-overridden primitives + everything referencing them
  const color = new Set(Object.keys(darkMap));
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of baseOrder) {
      if (color.has(k)) continue;
      const refs = [...String(baseMap[k]).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((x) => x[1]);
      if (refs.some((r) => color.has(r))) { color.add(k); grew = true; }
    }
  }
  const order = baseOrder.filter((k) => color.has(k)).concat([...color].filter((k) => !(k in baseMap)));
  const light = order.map((k) => '    ' + k + ': ' + (baseMap[k] ?? darkMap[k]) + ';').join('\n');
  const dark  = order.map((k) => '    ' + k + ': ' + (darkMap[k] ?? baseMap[k]) + ';').join('\n');
  const comp  = compRules.map((r) => '  [data-color="dark"] ' + r.sel + ' { ' + r.body + ' }').join('\n');

  return out +
    '\n\n  /* == Manual colour-mode toggle - generated from the DS @media blocks (no hand-copied values) == */\n' +
    '  [data-color="light"] {\n' + light + '\n  }\n' +
    '  [data-color="dark"] {\n' + dark + '\n  }\n' +
    (comp ? comp + '\n' : '');
}

// ── DS-derived size axis (e.g. Desktop/Phone) ─────────────────────────────────
// The styleguide toggles size with a [data-size] attribute, exactly like colour.
// The per-mode values come from the DS sizing collection's OWN modes, captured
// into the snapshot's `modeVariants` (the engine's per-mode, non-colour axis).
// Each non-base mode becomes a [data-size="<key>"] block; only vars that DIFFER
// from the base are emitted (base already lives in :root). A Figma token like
// `padding/m` maps to the CSS var `--padding-m`. When the snapshot has no such
// data (sizing captured single-mode), this returns '' - the styleguide keeps
// whatever the template already carries. Nothing invented, all from the DS.
export function deriveSizeCSS(modeVariants, spec = DEFAULT_NAMING) {
  const mv = modeVariants || {};
  let out = '';
  for (const def of Object.values(mv)) {
    const modes = def?.modes || [];
    const vars = def?.vars || {};
    const scalar = Object.entries(vars).filter(([, v]) => v && v.kind === 'scalar');
    if (modes.length < 2 || !scalar.length) continue;
    const baseKey = modes[0].snapshotKey;
    for (const m of modes.slice(1)) {
      const decls = scalar.map(([token, v]) => {
        const val = v.values?.[m.snapshotKey];
        if (val == null || val === v.values?.[baseKey]) return null;   // unchanged from base
        return '    ' + tokenToVar(String(token), spec, { raw: true }) + ': ' + val + ';';
      }).filter(Boolean);
      if (decls.length) out += `  [data-size="${m.snapshotKey}"] {\n${decls.join('\n')}\n  }\n`;
    }
  }
  return out ? '\n\n  /* == Size axis - generated from the DS sizing-collection modes (no hand-copied values) == */\n' + out : '';
}

export async function generateStyleguide(ROOT, cfg, opts = {}) {
  const sh = cfg.styleguide || {};
  const templatePath = resolve(ROOT, sh.template || 'apps/styleguide/styleguide.template.html');
  const outPath = resolve(ROOT, sh.out || 'apps/styleguide/index.html');
  if (!existsSync(templatePath)) throw new Error('styleguide template not found: ' + templatePath);
  let html = readFileSync(templatePath, 'utf8');

  const themeFiles = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const pluginCSS = (cfg.paths?.pluginCSS ?? []).flat();
  const pluginHTML = (cfg.paths?.plugins ?? []).flat();

  // ── THEME_CSS ────────────────────────────────────────────────────────────────
  function themeCSS() {
    const css = themeFiles.map((p) => { const abs = resolve(ROOT, p); return existsSync(abs) ? readFileSync(abs, 'utf8') : ''; }).join('\n\n');
    // Derive the manual [data-color] mode blocks straight from the DS @media
    // rules (gating each block so the toggle wins). Nothing hand-copied.
    // Then append the [data-size] axis from the DS sizing-collection modes
    // (snapshot modeVariants); empty when sizing was captured single-mode.
    let sizeCSS = '';
    try {
      const snapPath = cfg.paths?.snapshotVars ? resolve(ROOT, cfg.paths.snapshotVars) : null;
      if (snapPath && existsSync(snapPath)) sizeCSS = deriveSizeCSS(JSON.parse(readFileSync(snapPath, 'utf8')).modeVariants, resolveNamingSpec(cfg));
    } catch {}
    return deriveModeCSS(css) + sizeCSS;
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
    const PLUGS = (cfg.styleguide?.plugins) || [
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
