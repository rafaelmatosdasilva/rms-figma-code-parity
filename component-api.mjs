// component-api.mjs - a DS component's code API (props, defaults, allowed values, slots), read from
// the best source the project has, with a confidence per prop.
//
// Sources, best first. Each is optional and detected, never imposed:
//   • Custom Elements Manifest   custom-elements.json (or package.json "customElements", or
//                                 codeReading.customElements)
//   • docgen JSON                 react-docgen or vue-docgen-api output (codeReading.docgen: path or list)
//   • TypeScript                  the project's own compiler, when installed (never added as a
//                                 dependency). Reads the Props type by syntax, no type checking.
//   • text patterns               component-source.mjs, the reading the props gate has always used
// Pairing only (which file is component X, which code prop a Figma property maps to):
//   • Storybook index             storybook-static/index.json or stories.json (codeReading.storybookIndex)
//   • Figma Code Connect          committed *.figma.{tsx,ts,jsx,js} files, joined to the Figma component
//                                 by node id. Pairing evidence only, never a source of values.
//
// Confidence per prop: `verified` (two sources agree), `single-source`, `uncertain` (sources
// disagree on the default or the allowed values - a reading problem, never a design difference).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { norm, SKIP_DIR, componentSourceFiles, textReader, resolveComponentFile, textComponentApi } from './component-source.mjs';
import { parseCodeConnect, normalizeNodeId } from './codeconnect-check.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const unq = (s) => String(s ?? '').trim().replace(/^['"`]|['"`]$/g, '');
const literalOptions = (text) => {
  // "'s' | 'm' | 'l'" → ['s','m','l'] (only when every member is a string literal)
  const parts = String(text ?? '').split('|').map((x) => x.trim()).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => /^(['"`]).*\1$/.test(p)) ? parts.map(unq) : null;
};

// ── Custom Elements Manifest ──────────────────────────────────────────────────
export function cemComponents(manifest, ROOT = '') {
  const out = [];
  for (const mod of manifest?.modules ?? []) {
    for (const d of mod.declarations ?? []) {
      if (!(d.customElement || d.tagName)) continue;
      const props = {};
      const add = (name, type, def) => {
        if (!name) return;
        const e = props[name] ?? (props[name] = {});
        const opts = literalOptions(type);
        if (opts) e.options = opts;
        else if (type && /^boolean$/i.test(type.trim())) e.type = 'boolean';
        if (def != null && def !== '' && def !== 'undefined') e.default = unq(def);
      };
      for (const a of d.attributes ?? []) add(a.fieldName ?? a.name, a.type?.text, a.default);
      for (const m of d.members ?? []) if (m.kind === 'field' && !m.static && m.privacy !== 'private' && m.privacy !== 'protected') add(m.name, m.type?.text, m.default);
      out.push({
        names: [d.name, d.tagName].filter(Boolean),
        file: mod.path ? resolve(ROOT, mod.path) : null,
        props,
        slots: { named: (d.slots ?? []).map((s) => s.name).filter(Boolean).map(norm), default: (d.slots ?? []).some((s) => !s.name) },
      });
    }
  }
  return out;
}

// ── docgen JSON (react-docgen, vue-docgen-api) ─────────────────────────────────
function docgenOptions(p) {
  const t = p.tsType ?? p.flowType;
  if (t?.name === 'union' && Array.isArray(t.elements) && t.elements.every((e) => e.name === 'literal')) return t.elements.map((e) => unq(e.value));
  if (p.type?.name === 'enum' && Array.isArray(p.type.value)) return p.type.value.map((v) => unq(v.value));
  if (Array.isArray(p.values) && p.values.length) return p.values.map(unq);   // vue-docgen-api
  if (p.type?.name && literalOptions(p.type.name)) return literalOptions(p.type.name);
  return null;
}
export function docgenComponents(doc, ROOT = '') {
  // Accepts an array of docs, { file: doc | [docs] } (react-docgen CLI), or a single doc.
  const docs = [];
  const push = (d, file) => { if (d && typeof d === 'object' && (d.displayName || d.props)) docs.push({ d, file }); };
  if (Array.isArray(doc)) doc.forEach((d) => push(d, d?.sourceFiles?.[0] ?? d?.filePath));
  else if (doc && typeof doc === 'object' && (doc.displayName || doc.props)) push(doc, doc.sourceFiles?.[0] ?? doc.filePath);
  else if (doc && typeof doc === 'object') for (const [file, v] of Object.entries(doc)) (Array.isArray(v) ? v : [v]).forEach((d) => push(d, file));
  return docs.map(({ d, file }) => {
    const props = {};
    const list = Array.isArray(d.props) ? d.props.map((p) => [p.name, p]) : Object.entries(d.props ?? {});
    for (const [name, p] of list) {
      if (!name) continue;
      const e = {};
      const opts = docgenOptions(p);
      if (opts) e.options = opts;
      else if (/^(bool|boolean)$/.test(p.tsType?.name ?? p.type?.name ?? '')) e.type = 'boolean';
      const def = p.defaultValue?.value;
      if (def != null && def !== 'undefined') e.default = unq(def);
      props[name] = e;
    }
    const slotList = Array.isArray(d.slots) ? d.slots : [];
    return {
      names: [d.displayName, d.exportName].filter(Boolean),
      file: file ? resolve(ROOT, file) : null,
      props,
      slots: { named: slotList.map((s) => s.name).filter((n) => n && n !== 'default').map(norm), default: slotList.some((s) => !s.name || s.name === 'default') },
    };
  });
}

// ── Storybook index (pairing) ─────────────────────────────────────────────────
// { componentName: file } from index.json (v7+) or stories.json (v6). The component is the last
// segment of the story title ("Components/Button" → Button); componentPath wins over importPath.
export function storybookFiles(index, ROOT = '') {
  const out = {};
  const entries = Object.values(index?.entries ?? index?.stories ?? {});
  for (const e of entries) {
    if (e.type && e.type !== 'story' && e.type !== 'docs') continue;
    const name = String(e.title ?? e.kind ?? '').split('/').pop().trim();
    const file = e.componentPath ?? null;
    if (name && file && !out[name]) out[name] = resolve(ROOT, file);
  }
  return out;
}

// ── Code Connect (pairing) ────────────────────────────────────────────────────
// Each connect: { component (code identifier), nodeId, file (the component's source, from its
// import), propMap: { figmaProp: codeProp } }.
export function codeConnectPairs(text, fileAbs) {
  const out = [];
  for (const c of parseCodeConnect(text)) {
    let file = null;
    const id = c.component.split('.')[0];
    const imp = text.match(new RegExp(`import\\s+(?:\\{[^}]*\\b${id}\\b[^}]*\\}|${id})[^;]*?from\\s+['"\`]([^'"\`]+)['"\`]`));
    if (imp && imp[1].startsWith('.')) {
      const base = resolve(dirname(fileAbs), imp[1]);
      file = [base, ...['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'].map((x) => base + x), ...['index.tsx', 'index.ts', 'index.jsx', 'index.js'].map((x) => join(base, x))].find((p) => existsSync(p) && extname(p)) ?? null;
    }
    const propMap = {};
    const start = text.indexOf(c.component, c.index);
    const end = (() => { const nxt = text.indexOf('figma.connect(', c.index + 1); return nxt === -1 ? text.length : nxt; })();
    const body = text.slice(start, end);
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*figma\.(?:enum|boolean|string|instance|children|textContent|nestedProps)\(\s*(['"`])([^'"`]+)\2/g)) propMap[m[3]] = m[1];
    out.push({ component: c.component, nodeId: c.nodeId, file, propMap });
  }
  return out;
}
function codeConnectFiles(ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p); }
      else if (/\.figma\.[jt]sx?$/.test(e.name)) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

// ── TypeScript (optional, the project's own compiler) ─────────────────────────
export function loadTypeScript(ROOT) {
  try {
    const req = createRequire(join(ROOT, 'package.json'));
    return req(req.resolve('typescript'));
  } catch { return null; }
}
// Read the Props type of one component by syntax. Returns the api shape, or null when no Props
// type is found. Vue single-file components: the <script lang="ts"> block is read.
export function typescriptComponentApi(ts, file, text, componentName) {
  if (!ts) return null;
  let src = text, kind = ts.ScriptKind.TS;
  const ext = extname(file);
  if (ext === '.vue' || ext === '.svelte') {
    const m = text.match(/<script\b[^>]*\blang\s*=\s*["']ts["'][^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    src = m[1];
  } else if (ext === '.tsx') kind = ts.ScriptKind.TSX;
  else if (ext === '.jsx') kind = ts.ScriptKind.JSX;
  else if (ext === '.js') kind = ts.ScriptKind.JS;
  let sf;
  try { sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind); } catch { return null; }

  const literals = (node) => {
    if (!node) return null;
    if (ts.isUnionTypeNode(node)) {
      const out = [];
      for (const t of node.types) {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
        else return null;
      }
      return out.length >= 2 ? out : null;
    }
    return null;
  };
  const membersOf = (typeNode) => {
    const props = {};
    const members = typeNode && (ts.isTypeLiteralNode(typeNode) ? typeNode.members : typeNode.members);
    for (const m of members ?? []) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = m.name.text ?? m.name.escapedText;
      if (!name) continue;
      const e = {};
      const opts = literals(m.type);
      if (opts) e.options = opts;
      else if (m.type?.kind === ts.SyntaxKind.BooleanKeyword) e.type = 'boolean';
      props[name] = e;
    }
    return props;
  };
  const candidates = [];   // [name, typeNode]
  let vueProps = null;
  const defaults = {};
  const literalText = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text
    : n && ts.isNumericLiteral(n) ? n.text
    : n && n.kind === ts.SyntaxKind.TrueKeyword ? 'true' : n && n.kind === ts.SyntaxKind.FalseKeyword ? 'false' : null);
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && /Props$/.test(node.name.text)) candidates.push([node.name.text, node]);
    else if (ts.isTypeAliasDeclaration(node) && /Props$/.test(node.name.text) && ts.isTypeLiteralNode(node.type)) candidates.push([node.name.text, node.type]);
    else if (ts.isCallExpression(node) && node.expression.getText?.(sf) === 'defineProps' && node.typeArguments?.[0] && ts.isTypeLiteralNode(node.typeArguments[0])) vueProps = node.typeArguments[0];
    else if (ts.isCallExpression(node) && node.expression.getText?.(sf) === 'withDefaults' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const p of node.arguments[1].properties) if (ts.isPropertyAssignment(p) && p.name) { const v = literalText(p.initializer); if (v != null) defaults[p.name.text] = v; }
    } else if (ts.isObjectBindingPattern(node) && (ts.isParameter(node.parent))) {
      for (const el of node.elements) if (el.initializer && ts.isIdentifier(el.name)) { const v = literalText(el.initializer); if (v != null) defaults[el.name.text] = v; }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const want = componentName ? norm(componentName) + 'props' : null;
  const chosen = vueProps ?? (candidates.find(([n]) => want && norm(n) === want)?.[1]) ?? (candidates.length === 1 ? candidates[0][1] : null);
  if (!chosen) return null;
  const props = membersOf(chosen);
  for (const [k, v] of Object.entries(defaults)) if (props[k]) props[k].default = v;
  return { props };
}

// ── Merge ─────────────────────────────────────────────────────────────────────
const sameList = (a, b) => a.length === b.length && a.map(norm).sort().join('|') === b.map(norm).sort().join('|');

// readings: [{ source, props, slots? }] best first. Returns { props, slots, readBy }.
export function mergeApiReadings(readings) {
  const props = {};
  const byKey = new Map();   // norm(name) → name as the best source spells it
  for (const r of readings) for (const name of Object.keys(r.props ?? {})) if (!byKey.has(norm(name))) byKey.set(norm(name), name);
  for (const [key, name] of byKey) {
    const seen = readings.filter((r) => Object.keys(r.props ?? {}).some((n) => norm(n) === key))
      .map((r) => ({ source: r.source, e: Object.entries(r.props).find(([n]) => norm(n) === key)[1] }));
    const fact = { readBy: seen.map((s) => s.source) };
    const defs = seen.filter((s) => s.e.default != null);
    const opts = seen.filter((s) => Array.isArray(s.e.options));
    if (defs.length) fact.default = defs[0].e.default;
    if (opts.length) fact.options = opts[0].e.options;
    const type = seen.find((s) => s.e.type)?.e.type;
    if (type) fact.type = type;
    const defDisagree = defs.some((s) => norm(s.e.default) !== norm(defs[0].e.default));
    const optDisagree = opts.some((s) => !sameList(s.e.options, opts[0].e.options));
    if (defDisagree || optDisagree) {
      fact.confidence = 'uncertain';
      fact.readings = Object.fromEntries(seen.map((s) => [s.source, s.e]));
    } else fact.confidence = seen.length >= 2 ? 'verified' : 'single-source';
    props[name] = fact;
  }
  const named = new Set(), sources = [];
  let hasDefault = false;
  for (const r of readings) {
    if (!r.slots) continue;
    for (const n of r.slots.named ?? []) named.add(norm(n));
    if (r.slots.default) hasDefault = true;
  }
  for (const r of readings) sources.push(r.source);
  return { props, slots: { named: [...named], default: hasDefault }, readBy: sources };
}

// ── The whole reading, for a list of component names ──────────────────────────
// createApiReader(ROOT, cfg, { classFor, nodeIds }) → { fileFor(name), apiFor(name), sources }
//   nodeIds: { componentName: figmaNodeId } (from the Figma structure snapshot), to join Code Connect.
export function createApiReader(ROOT, cfg = {}, { classFor, nodeIds = {} } = {}) {
  const read = textReader();
  const files = componentSourceFiles(ROOT, cfg);
  const cr = cfg.codeReading ?? {};
  const sources = [];

  // Standard files
  const cemPath = cr.customElements ?? readJson(join(ROOT, 'package.json'))?.customElements ?? 'custom-elements.json';
  const cem = existsSync(resolve(ROOT, cemPath)) ? cemComponents(readJson(resolve(ROOT, cemPath)), ROOT) : [];
  if (cem.length) sources.push(`custom elements manifest (${relative(ROOT, resolve(ROOT, cemPath))})`);
  const docgen = [];
  for (const p of [cr.docgen ?? []].flat()) {
    const abs = resolve(ROOT, p);
    if (existsSync(abs)) { docgen.push(...docgenComponents(readJson(abs), ROOT)); sources.push(`docgen (${p})`); }
  }
  const sbPath = cr.storybookIndex ?? ['storybook-static/index.json', 'storybook-static/stories.json'].find((p) => existsSync(join(ROOT, p)));
  const sb = sbPath && existsSync(resolve(ROOT, sbPath)) ? storybookFiles(readJson(resolve(ROOT, sbPath)), ROOT) : {};
  if (Object.keys(sb).length) sources.push(`storybook index (${sbPath})`);
  const cc = [];
  for (const f of codeConnectFiles(ROOT)) cc.push(...codeConnectPairs(read(f), f));
  if (cc.length) sources.push(`code connect (${cc.length} mapping${cc.length === 1 ? '' : 's'})`);
  const ts = loadTypeScript(ROOT);
  if (ts) sources.push('typescript (project compiler)');

  const byNode = new Map(Object.entries(nodeIds).map(([n, id]) => [normalizeNodeId(id), n]));
  const matches = (names, name) => names.some((x) => norm(x) === norm(name) || norm(String(x).replace(/^[a-z0-9]+-/i, '')) === norm(name));
  const ccFor = (name) => cc.find((c) => (c.nodeId && byNode.get(c.nodeId) === name)) ?? cc.find((c) => norm(c.component) === norm(name)) ?? null;

  const declared = {};
  const fileCache = new Map();
  function fileFor(name) {
    if (fileCache.has(name)) return fileCache.get(name);
    if (!declared[name]) {
      const c = ccFor(name);
      const e = cem.find((x) => matches(x.names, name)) ?? docgen.find((x) => matches(x.names, name));
      if (c?.file) declared[name] = { file: c.file, how: 'code connect' };
      else if (e?.file && existsSync(e.file)) declared[name] = { file: e.file, how: cem.includes(e) ? 'custom elements manifest' : 'docgen' };
      else if (sb[name]) declared[name] = { file: sb[name], how: 'storybook' };
    }
    const r = resolveComponentFile(name, { ROOT, cfg, files, read, classFor, declared });
    fileCache.set(name, r);
    return r;
  }

  function apiFor(name) {
    const { file, how } = fileFor(name);
    const readings = [];
    const e = cem.find((x) => matches(x.names, name));
    if (e) readings.push({ source: 'custom-elements', props: e.props, slots: e.slots });
    const d = docgen.find((x) => matches(x.names, name) || (file && x.file === file));
    if (d) readings.push({ source: 'docgen', props: d.props, slots: d.slots });
    if (file) {
      const text = read(file);
      const t = typescriptComponentApi(ts, file, text, name);
      if (t) readings.push({ source: 'typescript', props: t.props });
      readings.push({ source: 'text', ...textComponentApi(file, text) });
    }
    if (!readings.length) return { file: null, how, props: {}, slots: { named: [], default: false }, readBy: [], codeConnect: ccFor(name)?.propMap ?? null };
    const merged = mergeApiReadings(readings);
    return { file, how, ...merged, codeConnect: ccFor(name)?.propMap ?? null };
  }

  return { fileFor, apiFor, sources, read, files };
}
