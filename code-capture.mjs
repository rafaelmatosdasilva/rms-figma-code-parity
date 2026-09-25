// code-capture.mjs - capture the code once, the way Figma is captured once.
//
// The Figma side of every run is a set of snapshots that all gates read. The code side used to be
// re-read inside each gate, each with its own text patterns. This module writes the code side as a
// snapshot too, `code.snapshot.json`, in the same spirit: every fact says where it came from and
// how sure the reading is.
//
// Readings (best source first):
//   • browser  - Chrome (via cdp.mjs) opens the theme and the built pages, switches into every mode
//                the way ds-config says the mode is switched, and reads what the browser resolved.
//                Runtime-injected tokens (CSS-in-JS, a stylesheet loaded by script) are seen too.
//   • static   - css-source.mjs parses the CSS with file and line, follows @import, and resolves
//                each mode by the real cascade (importance, specificity, source order).
// Confidence per fact: `verified` (both readings agree), `single-source` (only one reading was
// possible), `uncertain` (the readings disagree - a READING problem, never reported as a design
// difference), `not-read` (with the reason).
//
// Cached by content: the snapshot records a hash of every input; an unchanged project reuses it.
//
// CLI:  node code-capture.mjs [--force] [--no-browser] [--json]
//       (also: rms-figma-code-parity --capture-code)
// Config (all optional): ds-config.json → codeReading: { browser: "auto" | "off", pages: [paths or URLs],
//                                                       out: ".parity-out/code.snapshot.json" }

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { allModes } from './mode-resolver.mjs';
import { loadCssSources, rootTokens, resolveVars, canonValue } from './css-source.mjs';
import { findChrome, launchChrome, connectCDP, openPage, waitForTrue } from './cdp.mjs';
import { captureComponents, staticComponentReading } from './component-capture.mjs';
import { createLocator, loadLocator } from './component-locator.mjs';
import { apiReaderFor, captureApis, captureIcons, captureMarkup, renderedNesting, sourceNesting, mergeNesting, structureInputFiles, markupInputKey } from './structure-capture.mjs';
import { conceptOf } from './state-concepts.mjs';
import { inProgressNames } from './in-progress.mjs';   // I52: work in progress is not drift

export const CAPTURE_VERSION = 2;
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

// ── Inputs ────────────────────────────────────────────────────────────────────
// Theme CSS = the DS tokens. Pages = where the code actually renders: the built apps
// (paths.plugins, as Gate 16 resolves them), the generated styleguide, and any extra
// codeReading.pages. A page that does not exist is simply not read.
export function captureInputs(ROOT, cfg) {
  const themeEntries = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const apps = cfg.paths?.plugins ?? [];
  const appSrc = cfg.paths?.pluginCSS ?? [];
  const pages = [];
  apps.forEach((app, i) => {
    const src = appSrc[i];
    const built = src ? src.replace(/\.src\.html$/, '.html') : `apps/${app}/ui.html`;
    pages.push({ label: app, path: built });
  });
  // The styleguide shows every component and state on one page, so it is the capture's first place
  // to measure. With a template configured, the capture builds its own private copy (never the
  // project's page); a configured template that is missing is reported with the one found nearby.
  const styleguide = styleguidePlan(ROOT, cfg);
  if (!styleguide.generate) pages.push({ label: 'styleguide', path: cfg.styleguide?.out ?? 'apps/styleguide/index.html' });
  for (const p of cfg.codeReading?.pages ?? []) pages.push({ label: String(p), path: p });
  const present = pages.filter((p) => /^https?:\/\//.test(p.path) || existsSync(resolve(ROOT, p.path)));
  if (styleguide.generate) present.push({ label: 'styleguide', path: styleguide.out, generated: true });
  return { themeEntries, pages: present, styleguide };
}

// { generate, template, out, note } for the styleguide. `out` is the private copy in .parity-out.
export function styleguidePlan(ROOT, cfg) {
  const sg = cfg.styleguide;
  const outDir = dirname(cfg.codeReading?.out ?? '.parity-out/code.snapshot.json');
  if (!sg?.template) return { generate: false, note: sg ? null : 'no styleguide configured (ds-config.json → styleguide.template)' };
  if (existsSync(resolve(ROOT, sg.template))) return { generate: true, template: sg.template, out: join(outDir, 'styleguide.html') };
  const found = findTemplates(ROOT);
  return { generate: false, template: sg.template, note: `styleguide template not found at ${sg.template}${found.length ? ` (found ${found.join(', ')}: set ds-config.json → styleguide.template)` : ''}` };
}
function findTemplates(ROOT) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= 5) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.template\.html?$/i.test(e.name)) out.push(relative(ROOT, p));
    }
  };
  walk(ROOT, 0);
  return out;
}

function hashInputs(ROOT, cfg, files, pages, opts) {
  const h = createHash('sha256');
  h.update(`v${CAPTURE_VERSION}|${JSON.stringify(cfg.figma?.modes ?? null)}|${JSON.stringify(cfg.figma?.collections ?? null)}|${JSON.stringify(cfg.codeReading ?? null)}`);
  for (const f of ['code-capture.mjs', 'css-source.mjs', 'component-capture.mjs', 'component-locator.mjs', 'structure-capture.mjs', 'component-api.mjs', 'component-source.mjs', 'icon-source.mjs', 'markup-source.mjs', 'codeconnect-check.mjs', 'state-concepts.mjs', 'css-values.mjs']) { try { h.update(readFileSync(join(ENGINE_DIR, f))); } catch { /* engine file */ } }
  for (const extra of opts.extraFiles ?? []) { try { h.update(extra); h.update(readFileSync(extra)); } catch { /* optional */ } }
  for (const key of opts.extraKeys ?? []) h.update(`|${key}`);
  for (const abs of [...files.map((f) => f.abs), ...pages.filter((p) => !/^https?:/.test(p.path) && !p.generated).map((p) => resolve(ROOT, p.path))].sort()) {
    try { h.update(abs); h.update(readFileSync(abs)); } catch { /* vanished */ }
  }
  return h.digest('hex').slice(0, 16);
}

// ── Static reading ────────────────────────────────────────────────────────────
export function staticTokenReading(sources, modes) {
  const byMode = {};
  for (const mode of modes) {
    const vars = rootTokens(sources, mode);
    const out = {};
    for (const [name, decl] of vars) {
      const r = resolveVars(decl.value, vars);
      out[name] = { value: r.value, declared: decl.value, at: `${decl.file}:${decl.line}`, chain: r.chain, unresolved: r.unresolved };
    }
    byMode[mode.snapshotKey] = out;
  }
  return byMode;
}

// ── Browser reading ───────────────────────────────────────────────────────────
// Every custom property the page's stylesheets declare (CSSOM, including @import, <style> added by
// script and adopted sheets), plus any set directly on the root element, read from the root's
// computed style. Returns { vars: { name: value }, blocked: [sheet hrefs the page could not read] }.
const READ_ROOT_VARS = `(() => {
  const names = new Set(); const blocked = [];
  const walk = (rules) => { for (const r of rules) {
    if (r.style) for (let i = 0; i < r.style.length; i++) { const p = r.style[i]; if (p.startsWith('--')) names.add(p); }
    if (r.styleSheet) { try { walk(r.styleSheet.cssRules); } catch { blocked.push(r.href || '(import)'); } }
    if (r.cssRules) { try { walk(r.cssRules); } catch { /* unreadable group */ } }
  } };
  for (const sh of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    try { walk(sh.cssRules); } catch { blocked.push(sh.href || '(inline)'); }
  }
  const root = document.documentElement;
  for (let i = 0; i < root.style.length; i++) { const p = root.style[i]; if (p.startsWith('--')) names.add(p); }
  const cs = getComputedStyle(root);
  for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (p.startsWith('--')) names.add(p); }
  const vars = {};
  for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v !== '') vars[n] = v; }
  return { vars, blocked };
})()`;

// The Figma breakpoint collection as widths to measure at: each mode's viewport/min-width (the
// smallest mode, usually 0, is measured at 375px, a phone). Empty when the file has no breakpoints.
export function breakpointWidths(ROOT, cfg) {
  let bp = {};
  try { bp = JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json'), 'utf8')).breakpoints ?? {}; } catch { return []; }
  return Object.entries(bp).map(([name, t]) => {
    const w = parseFloat(t?.['viewport/min-width'] ?? t?.['viewport/width'] ?? '0') || 0;
    return { name, width: w > 0 ? w : 375 };
  }).sort((a, b) => a.width - b.width);
}

// How to put a page into a mode. Returns { media, viewport, apply, undo } or { unsupported }.
// The generated styleguide pins its own mode on <html data-color="…"> (its manual toggle), which
// turns the media-query theme off: there the switch also sets that attribute to the light or dark
// the mode stands for, or the page would be measured in light for every mode.
export function modeSwitch(mode, { styleguide = false } = {}) {
  const sw = modeSwitchFor(mode);
  if (!styleguide || sw.unsupported) return sw;
  const scheme = sw.media?.find((f) => f.name === 'prefers-color-scheme')?.value;
  if (!scheme) return sw;
  const set = `(() => { const r = document.documentElement; if (!r.hasAttribute('data-color')) return; if (!r.hasAttribute('data-parity-color-was')) r.setAttribute('data-parity-color-was', r.getAttribute('data-color')); r.setAttribute('data-color', ${JSON.stringify(scheme)}); })()`;
  const reset = `(() => { const r = document.documentElement; if (!r.hasAttribute('data-parity-color-was')) return; r.setAttribute('data-color', r.getAttribute('data-parity-color-was')); r.removeAttribute('data-parity-color-was'); })()`;
  return { ...sw, apply: sw.apply ? `${sw.apply}; ${set}` : set, undo: sw.undo ? `${sw.undo}; ${reset}` : reset };
}

function modeSwitchFor(mode) {
  const sel = mode.cssSelector ?? 'root';
  const base = [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-contrast', value: 'no-preference' }];
  if (sel === 'root') return { media: base };
  if (sel === 'dark-media') return { media: [{ name: 'prefers-color-scheme', value: 'dark' }, base[1]] };
  if (sel === 'high-contrast-media') return { media: [base[0], { name: 'prefers-contrast', value: 'more' }] };
  if (sel.startsWith('class:')) {
    const c = JSON.stringify(sel.slice(6));
    return { media: base, apply: `document.documentElement.classList.add(${c})`, undo: `document.documentElement.classList.remove(${c})` };
  }
  if (sel.startsWith('data:')) {
    const [attr, val = ''] = sel.slice(5).split('=');
    const a = JSON.stringify(attr.startsWith('data-') ? attr : `data-${attr}`);
    return { media: base, apply: `document.documentElement.setAttribute(${a}, ${JSON.stringify(val)})`, undo: `document.documentElement.removeAttribute(${a})` };
  }
  if (sel.startsWith('media:')) {
    const cond = sel.slice(6);
    const feats = [...cond.matchAll(/\(\s*(prefers-color-scheme|prefers-contrast|prefers-reduced-motion|forced-colors)\s*:\s*([\w-]+)\s*\)/g)].map((m) => ({ name: m[1], value: m[2] }));
    const width = cond.match(/\(\s*min-width\s*:\s*(\d+)px\s*\)/)?.[1] ?? cond.match(/\(\s*max-width\s*:\s*(\d+)px\s*\)/)?.[1];
    const rest = cond.replace(/\(\s*(prefers-color-scheme|prefers-contrast|prefers-reduced-motion|forced-colors|min-width|max-width)\s*:[^)]*\)/g, '').replace(/\band\b|\s/g, '');
    if (rest) return { unsupported: `cannot emulate media condition ${cond}` };
    return { media: feats.length ? feats : base, viewport: width ? +width : null };
  }
  return { unsupported: `unknown mode switch ${sel}` };
}

// A throwaway page holding only the theme CSS, so the browser resolves the theme alone. The files
// are inlined in cascade order (imports already come first), because Chrome treats a file://
// stylesheet as another origin and hides its rules from the page.
function themePage(files) {
  const css = files.map((f) => f.text.replace(/@import\s[^;]*;/g, '')).join('\n').replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html><head><style>${css}</style></head><body></body></html>`;
}

// Open a page and wait for it to load. Returns { targetId, sessionId } (sessionId null if it never loaded).
export async function openLoaded(send, url) {
  const { targetId, sessionId } = await openPage(send, url);
  const ok = await waitForTrue(send, sessionId, 'document.readyState === "complete" && location.href !== "about:blank"', { attempts: 200, intervalMs: 50, tolerateErrors: true });
  if (!ok) { await send('Target.closeTarget', { targetId }).catch(() => {}); return { targetId, sessionId: null }; }
  return { targetId, sessionId };
}

export async function browserTokenReading(ROOT, { files, pages, modes, send, tmpDir }) {
  const result = { theme: {}, pages: {}, notRead: [] };
  {
    const targets = [];
    if (files.length) {
      const p = join(tmpDir, 'theme-page.html');
      writeFileSync(p, themePage(files));
      targets.push({ label: '(theme)', url: pathToFileURL(p).href, isTheme: true });
    }
    for (const pg of pages) targets.push({ label: pg.label, url: /^https?:/.test(pg.path) ? pg.path : pathToFileURL(resolve(ROOT, pg.path)).href });
    for (const t of targets) {
      const { targetId, sessionId } = await openLoaded(send, t.url);
      if (!sessionId) { result.notRead.push(`${t.label}: page did not load`); continue; }
      const perMode = {};
      for (const mode of modes) {
        const sw = modeSwitch(mode);
        if (sw.unsupported) { result.notRead.push(`${t.label} ${mode.snapshotKey}: ${sw.unsupported}`); continue; }
        await send('Emulation.setEmulatedMedia', { features: sw.media }, sessionId);
        if (sw.viewport) await send('Emulation.setDeviceMetricsOverride', { width: sw.viewport, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        if (sw.apply) await send('Runtime.evaluate', { expression: sw.apply }, sessionId);
        const r = await send('Runtime.evaluate', { expression: READ_ROOT_VARS, returnByValue: true }, sessionId);
        perMode[mode.snapshotKey] = r.result?.value?.vars ?? {};
        // A sheet the page cannot open through the CSSOM (file:// is another origin) is still read:
        // its custom properties come through the root's computed style. Only counted, not an error.
        result.blockedSheets = (result.blockedSheets ?? 0) + (r.result?.value?.blocked?.length ?? 0);
        if (sw.undo) await send('Runtime.evaluate', { expression: sw.undo }, sessionId);
        if (sw.viewport) await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
      }
      if (t.isTheme) result.theme = perMode; else result.pages[t.label] = perMode;
      await send('Target.closeTarget', { targetId });
    }
  }
  return result;
}

// Every DS component the project knows about, with its selector, a probe when the contract
// declares one, and the states its propertyMap maps (Figma option → selector).
export async function componentSpecs(ROOT, cfg) {
  let contract = {};
  const cp = resolve(ROOT, cfg.paths?.structureContract ?? 'structure-contract.mjs');
  if (existsSync(cp)) { try { contract = await import(pathToFileURL(cp).href); } catch { /* optional */ } }
  const CONTRACT = contract.CONTRACT ?? {}, SELECTORS = contract.COMPONENT_CSS_SELECTORS ?? {};
  const locator = createLocator(cfg, { contractSelectors: SELECTORS });
  let snapNames = [], snap = {};
  try { snap = JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json'), 'utf8')).components ?? {}; snapNames = Object.keys(snap); } catch { /* optional */ }
  const maxCombos = Number.isFinite(cfg.codeReading?.maxCombinations) ? cfg.codeReading.maxCombinations : 12;
  const names = [...new Set([...snapNames, ...Object.keys(CONTRACT), ...Object.keys(SELECTORS), ...Object.keys(cfg.componentSelectors ?? {})])];
  const probes = new Map();
  for (const a of [...(contract.RENDERED_ASSERTIONS ?? []), ...(contract.CROSS_PLUGIN_CONSISTENCY ?? [])]) {
    if (a?.probe && a.selector && !probes.has(a.selector)) probes.set(a.selector.replace(/\s+/g, ' ').trim(), a.probe);
  }
  const unbuilt = await inProgressNames(ROOT, cfg);
  return names.map((name) => {
    const selector = locator.selectorFor(name).replace(/\s+/g, ' ').trim();
    const states = [];
    for (const [figProp, mapping] of Object.entries(CONTRACT[name]?.propertyMap ?? {})) {
      if (!mapping || typeof mapping !== 'object') continue;
      for (const [option, sel] of Object.entries(mapping)) {
        if (typeof sel !== 'string' || sel.replace(/\s+/g, ' ').trim() === selector) continue;
        states.push({ label: `${figProp}=${option}`, selector: sel });
      }
    }
    const children = (CONTRACT[name]?.children ?? []).map((c) => c?.cssSelector).filter((x) => typeof x === 'string' && x.trim());
    // The parts the contract's selector map names: where the font, radius, gap or ::before really live.
    const sm = SELECTORS[name] ?? {};
    const parts = Object.fromEntries([['font', sm.fontSel], ['radius', sm.radiusSel], ['gap', sm.gapSel], ['before', sm.beforeSel]]
      .filter(([, v]) => typeof v === 'string' && v.trim() && !/::/.test(v)).map(([k, v]) => [k, v.replace(/\s+/g, ' ').trim()]));
    // Named parts (the contract's children with a name and a selector), so the capture can say which
    // are visible in each state and variant.
    const childParts = (CONTRACT[name]?.children ?? []).filter((c) => c?.name && typeof c.cssSelector === 'string' && c.cssSelector.trim()).map((c) => ({ name: c.name, selector: c.cssSelector.replace(/\s+/g, ' ').trim() }));
    return { name, selector, locatedBy: locator.sourceOf(name), probe: probes.get(selector) ?? null, states, children, parts, childParts, combos: variantCombos(snap[name], states, maxCombos), unbuilt: unbuilt.has(name) };
  });
}

// Figma variants that change two or more axes from the default variant, when every changed axis value
// has a selector in the contract's propertyMap: the capture puts them on together (idea I41). At most
// maxCombos per component (codeReading.maxCombinations, default 12).
export function variantCombos(figma, states, maxCombos = 12) {
  if (!figma?.variants || !figma.defaultVariant) return [];
  const axes = (n) => Object.fromEntries(String(n).split(',').map((p) => p.split('=').map((x) => x.trim().toLowerCase())).filter((p) => p.length === 2));
  const bySel = new Map(states.map((st) => [st.label.replace(/\s+/g, '').toLowerCase(), st.selector]));
  const def = axes(figma.defaultVariant);
  const out = [];
  for (const v of Object.keys(figma.variants)) {
    const diff = Object.entries(axes(v)).filter(([k, x]) => def[k] !== x);
    if (diff.length < 2) continue;
    const parts = diff.map(([k, x]) => ({ label: `${k}=${x}`, selector: bySel.get(`${k}=${x}`) }));
    if (parts.some((p) => !p.selector)) continue;
    out.push({ name: v, parts });
    if (out.length >= maxCombos) break;
  }
  return out;
}

// ── Merge the readings into facts ─────────────────────────────────────────────
export function mergeTokenReadings({ staticByMode, browser, modes, browserNote }) {
  const tokens = {};
  const counts = { verified: 0, 'single-source': 0, uncertain: 0 };
  const names = new Set();
  for (const m of modes) {
    for (const n of Object.keys(staticByMode[m.snapshotKey] ?? {})) names.add(n);
    for (const n of Object.keys(browser?.theme?.[m.snapshotKey] ?? {})) names.add(n);
  }
  for (const name of [...names].sort()) {
    const entry = { modes: {} };
    for (const m of modes) {
      const st = staticByMode[m.snapshotKey]?.[name];
      const br = browser?.theme?.[m.snapshotKey]?.[name];
      if (st == null && br == null) continue;
      const fact = {};
      if (st && br != null) {
        const same = canonValue(st.value) === canonValue(br);
        fact.value = br;
        fact.confidence = same ? 'verified' : 'uncertain';
        if (!same) fact.readings = { browser: br, static: st.value };
      } else if (br != null) {
        fact.value = br; fact.confidence = 'single-source'; fact.readBy = 'browser';
      } else {
        fact.value = st.value; fact.confidence = 'single-source'; fact.readBy = 'static';
        if (browserNote) fact.why = browserNote;
      }
      if (st?.chain?.length) fact.alias = st.chain;   // the tokens this one points through, in order
      if (st?.unresolved?.length) fact.unresolved = st.unresolved;
      counts[fact.confidence]++;
      entry.modes[m.snapshotKey] = fact;
      if (st && !entry.declaredAt) entry.declaredAt = st.at;
    }
    // Apps that change a DS token: a real code fact (a local override), recorded per page.
    for (const [label, perMode] of Object.entries(browser?.pages ?? {})) {
      for (const m of modes) {
        const v = perMode[m.snapshotKey]?.[name];
        const base = entry.modes[m.snapshotKey]?.value;
        if (v != null && base != null && canonValue(v) !== canonValue(base)) ((entry.overriddenBy ??= {})[label] ??= {})[m.snapshotKey] = v;
      }
    }
    tokens[name] = entry;
  }
  // Tokens that only exist on a page (declared by an app, not the theme): recorded separately.
  const appTokens = {};
  for (const [label, perMode] of Object.entries(browser?.pages ?? {})) {
    for (const m of modes) for (const [n, v] of Object.entries(perMode[m.snapshotKey] ?? {})) {
      if (tokens[n]) continue;
      ((appTokens[n] ??= {})[label] ??= {})[m.snapshotKey] = v;
    }
  }
  return { tokens, appTokens, counts };
}

// Without a browser: each component's own base rule, read statically (single-source).
function staticComponents(specs, sources, modes, why) {
  const vars = rootTokens(sources, modes[0]);
  const out = {};
  for (const c of specs) {
    if (c.unbuilt) continue;
    const st = staticComponentReading(sources, c.selector, vars);
    if (!Object.keys(st).length) continue;
    out[c.name] = {
      selector: c.selector, locatedBy: c.locatedBy, instance: null, confidence: 'static-only',
      props: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { value: v.value, var: v.var ?? undefined, at: v.at, confidence: 'single-source', readBy: 'static', why }])),
    };
  }
  return out;
}

export function componentCoverage(specs, components, comp) {
  const built = specs.filter((c) => !c.unbuilt);
  const byInstance = {};
  let statesProduced = 0, statesListed = 0;
  const byConfidence = { verified: 0, 'single-source': 0, uncertain: 0 };
  for (const c of Object.values(components)) {
    const how = c.instance?.how ?? 'static';
    byInstance[how] = (byInstance[how] ?? 0) + 1;
    statesProduced += Object.keys(c.states ?? {}).length;
    statesListed += Object.keys(c.states ?? {}).length + (c.statesNotProduced ?? []).length;
    for (const p of Object.values(c.props ?? {})) if (byConfidence[p.confidence] != null) byConfidence[p.confidence]++;
  }
  return {
    known: built.length,
    captured: Object.keys(components).length,
    byInstance,
    missing: built.map((c) => c.name).filter((n) => !components[n]),
    notBuiltYet: specs.filter((c) => c.unbuilt).map((c) => c.name),
    states: { produced: statesProduced, listed: statesListed },
    props: byConfidence,
    notes: comp?.notes ?? [],
  };
}

export const nestingLabel = (n) => n.rendered && n.source ? 'rendered page + source' : n.rendered ? 'rendered page only' : n.source ? 'source only' : 'not read';

export function apiCoverage(api, note, sources) {
  const all = Object.values(api);
  const props = all.flatMap((a) => Object.values(a.props ?? {}));
  const by = (c) => props.filter((p) => p.confidence === c).length;
  return {
    components: all.filter((a) => a.file || Object.keys(a.props ?? {}).length).length,
    noFile: Object.entries(api).filter(([, a]) => !a.file && !Object.keys(a.props ?? {}).length).map(([n, a]) => `${n} (${a.how})`),
    props: { total: props.length, verified: by('verified'), 'single-source': by('single-source'), uncertain: by('uncertain') },
    sources: sources ?? [],
    ...(note ? { note } : {}),
  };
}

// ── Capture ───────────────────────────────────────────────────────────────────
// Everything the capture reads, and the content hash of it (the cache key). Shared by captureCode
// and readFreshSnapshot so both agree on what "unchanged" means.
async function prepareCapture(ROOT, cfg) {
  const outPath = resolve(ROOT, cfg.codeReading?.out ?? '.parity-out/code.snapshot.json');
  const modes = allModes(cfg);
  const { themeEntries, pages, styleguide } = captureInputs(ROOT, cfg);
  const { files, missing, remote } = loadCssSources(ROOT, themeEntries);
  const locator = await loadLocator(ROOT, cfg);
  let figmaStructure = {};
  try { figmaStructure = JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json'), 'utf8')).components ?? {}; } catch { /* optional */ }
  const nodeIds = Object.fromEntries(Object.entries(figmaStructure).filter(([, v]) => v?.nodeId).map(([k, v]) => [k, v.nodeId]));
  const apiReader = apiReaderFor(ROOT, cfg, { classFor: locator.classFor, nodeIds });
  const extraFiles = [...new Set([cfg.paths?.structureContract ?? 'structure-contract.mjs', cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json', cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json', ...(cfg.paths?.pluginCSS ?? [])].map((p) => resolve(ROOT, p)).concat(structureInputFiles(ROOT, cfg, apiReader), styleguide.template ? [resolve(ROOT, styleguide.template)] : []))];
  const inputHash = hashInputs(ROOT, cfg, files, pages, { extraFiles, extraKeys: [markupInputKey(ROOT, cfg), [...(await inProgressNames(ROOT, cfg))].sort().join(',')] });
  return { outPath, modes, themeEntries, pages, styleguide, files, missing, remote, locator, apiReader, inputHash };
}

// The saved code snapshot, only when it still describes the code as it is now (same inputs, same
// engine). Gates use it for facts only the capture has (the browser reading, rendered nesting);
// a missing or stale snapshot returns null and the gate keeps its own reading.
export async function readFreshSnapshot(ROOT, cfg) {
  const outPath = resolve(ROOT, cfg.codeReading?.out ?? '.parity-out/code.snapshot.json');
  if (!existsSync(outPath)) return null;
  let prev;
  try { prev = JSON.parse(readFileSync(outPath, 'utf8')); } catch { return null; }
  try { return prev._inputHash === (await prepareCapture(ROOT, cfg)).inputHash ? prev : null; } catch { return null; }
}

export async function captureCode(ROOT, cfg, { force = false, browser: wantBrowser = true, log = () => {} } = {}) {
  const { outPath, modes, pages: plannedPages, styleguide, files, missing, remote, locator, apiReader, inputHash } = await prepareCapture(ROOT, cfg);
  let pages = plannedPages;

  const browserOff = !wantBrowser || cfg.codeReading?.browser === 'off';
  const chromePath = browserOff ? null : findChrome({ playwright: true });
  const canBrowse = !!chromePath && typeof WebSocket !== 'undefined';
  const browserNote = browserOff ? 'browser reading switched off' : !chromePath ? 'Chrome not found (set CHROME_PATH)' : typeof WebSocket === 'undefined' ? 'Node >= 22 required for the browser reading' : null;

  if (!force && existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      // Reuse only a capture made the same way: a static-only capture is redone once a browser is available.
      if (prev._inputHash === inputHash && !!prev._sources?.browser === canBrowse) { log('code capture unchanged since last run (cache hit)'); return { snapshot: prev, outPath, cached: true }; }
    } catch { /* recapture */ }
  }

  // Build the private styleguide copy the capture measures (the browser reading only).
  const sgNotes = [];
  if (styleguide.generate) {
    if (!canBrowse) pages = pages.filter((p) => !p.generated);
    else {
      try {
        const { generateStyleguide } = await import('./styleguide-gen.mjs');
        await generateStyleguide(ROOT, cfg, { out: styleguide.out });
      } catch (e) {
        pages = pages.filter((p) => !p.generated);
        sgNotes.push(`styleguide not built: ${e.message.split('\n')[0]}`);
      }
    }
  } else if (styleguide.note && cfg.styleguide) sgNotes.push(styleguide.note);
  const staticByMode = staticTokenReading(files, modes);
  let browser = null, comp = null, nestingRendered = null;
  const notRead = [...sgNotes, ...missing.map((m) => `${m}: file not found`), ...remote.map((r) => `${r}: remote stylesheet (static reading skips it; the browser reads it)`)];
  const specs = await componentSpecs(ROOT, cfg);
  // Static sources for component rules: the theme plus every app's own CSS (<style> blocks).
  const appSources = loadCssSources(ROOT, cfg.paths?.pluginCSS ?? []).files;
  const componentSources = [...files, ...appSources];
  if (canBrowse) {
    const tmpDir = join(dirname(outPath), '.tmp');
    mkdirSync(tmpDir, { recursive: true });
    let chrome = null;
    try {
      chrome = await launchChrome(chromePath, { tmpPrefix: 'code-capture-' });
      const cdp = await connectCDP(chrome.wsUrl);
      try {
        // A generated styleguide is a view of the DS (with its own mode toggle), not an app: its tokens are not app facts.
        browser = await browserTokenReading(ROOT, { files, pages: pages.filter((p) => !p.generated), modes, send: cdp.send, tmpDir });
        notRead.push(...browser.notRead);
        // Components: the styleguide first (every component and state on one page), then the apps;
        // the theme-only page last, as a clean place for probes and bare elements.
        const ordered = [...pages].sort((a, b) => (b.label === 'styleguide') - (a.label === 'styleguide'));
        const compPages = ordered.map((p) => ({ label: p.label, generated: !!p.generated, url: /^https?:/.test(p.path) ? p.path : pathToFileURL(resolve(ROOT, p.path)).href }));
        if (!compPages.length && files.length) {
          const tp = join(tmpDir, 'theme-page.html');
          if (existsSync(tp)) compPages.push({ label: '(theme)', url: pathToFileURL(tp).href });
        }
        comp = await captureComponents({
          send: cdp.send, on: cdp.on, pages: compPages, modes, modeSwitch,
          components: specs.filter((c) => !c.unbuilt),
          staticSources: componentSources,
          staticRootVars: rootTokens(componentSources, modes[0]),
          openPage: (url) => openLoaded(cdp.send, url),
          breakpoints: breakpointWidths(ROOT, cfg),
          stateConcept: (label) => conceptOf(label, cfg),
          visual: cfg.codeReading?.visual === true,
        });
        const nest = await renderedNesting({ send: cdp.send, pages: compPages, specs, openLoaded });
        nestingRendered = nest.rendered;
        notRead.push(...nest.notRead);
      } finally { cdp.close(); }
    } catch (e) { notRead.push(`browser reading failed: ${e.message.split('\n')[0]}`); }
    finally { chrome?.kill(); try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  } else if (browserNote) notRead.push(`browser reading skipped: ${browserNote}`);

  const { tokens, appTokens, counts } = mergeTokenReadings({ staticByMode, browser, modes, browserNote: browser ? null : browserNote });
  const components = comp?.components ?? staticComponents(specs, componentSources, modes, browserNote);
  // The instance images (codeReading.visual, idea I43), written beside the snapshot for the visual diff.
  const visualDir = join(dirname(outPath), 'visual', 'code');
  rmSync(visualDir, { recursive: true, force: true });
  for (const [name, c] of Object.entries(components)) {
    if (!c.visual?.data) continue;
    mkdirSync(visualDir, { recursive: true });
    const file = join(visualDir, `${name.replace(/[^\w.-]+/g, '_')}.png`);
    writeFileSync(file, Buffer.from(c.visual.data, 'base64'));
    c.visual = { file: relative(ROOT, file), width: c.visual.width, height: c.visual.height, scale: 2, background: c.visual.background, text: c.visual.text ?? [] };
  }
  const compCoverage = componentCoverage(specs, components, comp);
  const { api, note: apiNote, sources: apiSources } = captureApis(ROOT, specs, apiReader);
  const icons = captureIcons(ROOT, cfg);
  const markup = captureMarkup(ROOT, cfg);
  const nesting = mergeNesting(nestingRendered ?? {}, sourceNesting(specs.filter((s) => !s.unbuilt), apiReader, locator.classFor));
  if (!nestingRendered) notRead.push(`nesting from the rendered page not read${browserNote ? ` (${browserNote})` : ''}: source reading only`);
  const snapshot = {
    _captured: new Date().toISOString(),
    _captureVersion: CAPTURE_VERSION,
    _inputHash: inputHash,
    _sources: {
      theme: files.map((f) => f.file),
      pages: browser ? ['(theme)', ...Object.keys(browser.pages)] : [],
      browser: browser ? relative(ROOT, chromePath).startsWith('..') ? chromePath : relative(ROOT, chromePath) : null,
      modes: modes.map((m) => ({ key: m.snapshotKey, switch: m.cssSelector })),
    },
    _coverage: {
      tokens: Object.keys(tokens).length,
      byConfidence: counts,
      appTokens: Object.keys(appTokens).length,
      components: compCoverage,
      api: apiCoverage(api, apiNote, apiSources),
      icons: { symbols: Object.keys(icons).length, unused: Object.values(icons).filter((i) => !i.usedAt.length).length },
      markup: { apps: Object.keys(markup).filter((k) => !k.startsWith('_')).length, classesFrom: markup._classes.from },
      nesting: { components: Object.keys(nesting).length, rendered: !!nestingRendered, source: !!apiReader },
      styleguide: styleguide.generate && pages.some((p) => p.generated) ? { built: true, template: styleguide.template } : { built: false, ...(styleguide.note ? { note: styleguide.note } : {}) },
      notRead,
    },
    tokens,
    appTokens,
    components,
    api,
    icons,
    markup,
    nesting,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
  return { snapshot, outPath, cached: false };
}

// ── Report ────────────────────────────────────────────────────────────────────
export function captureSummary(snapshot, outPath, ROOT) {
  const c = snapshot._coverage ?? {};
  const b = c.byConfidence ?? {};
  const lines = [];
  lines.push(`Code capture → ${relative(ROOT, outPath)}`);
  lines.push(`  tokens      ${c.tokens ?? 0} read in ${(snapshot._sources?.modes ?? []).length} mode(s)` +
    `  ·  ${b.verified ?? 0} verified · ${b['single-source'] ?? 0} single-source · ${b.uncertain ?? 0} uncertain`);
  if (c.appTokens) lines.push(`  app tokens  ${c.appTokens} declared by an app, not the theme`);
  const over = Object.entries(snapshot.tokens ?? {}).filter(([, t]) => t.overriddenBy).length;
  if (over) lines.push(`  overrides   ${over} DS token(s) changed by an app`);
  const cc = c.components;
  if (cc) {
    const LABEL = { found: 'found on a page', 'isolated-copy': 'a page usage, copied without its extra classes', 'hidden-copy': 'hidden on the page (measured as a copy)', probe: 'from a contract probe', bare: 'bare element (low confidence)', static: 'static only' };
    const inst = Object.entries(cc.byInstance ?? {}).map(([k, v]) => `${v} ${LABEL[k] ?? k}`).join(' · ');
    lines.push(`  components  ${cc.captured}/${cc.known} captured  ·  ${inst}`);
    lines.push(`  values      ${cc.props.verified} verified · ${cc.props['single-source']} single-source · ${cc.props.uncertain} uncertain`);
    if (cc.states.listed) lines.push(`  states      ${cc.states.produced}/${cc.states.listed} produced and measured`);
    if (cc.missing.length) lines.push(`  not found   ${cc.missing.join(', ')}`);
  }
  const ap = c.api;
  if (ap?.note) lines.push(`  props       not read: ${ap.note}`);
  else if (ap) {
    lines.push(`  props       ${ap.props.total} prop(s) on ${ap.components} component(s)  ·  ${ap.props.verified} verified · ${ap.props['single-source']} single-source · ${ap.props.uncertain} uncertain`);
    if (ap.sources.length) lines.push(`  read from   ${ap.sources.join(' · ')} · text patterns`);
    if (ap.noFile.length) lines.push(`  no file     ${ap.noFile.slice(0, 8).join(', ')}${ap.noFile.length > 8 ? ` … +${ap.noFile.length - 8}` : ''}`);
  }
  if (c.icons) lines.push(`  icons       ${c.icons.symbols} symbol(s)${c.icons.unused ? `  ·  ${c.icons.unused} with no literal use` : ''}`);
  if (c.markup) lines.push(`  markup      ${c.markup.apps} app(s) fingerprinted  ·  DS classes from ${c.markup.classesFrom === 'config' ? 'ds-config' : c.markup.classesFrom === 'snapshot' ? 'the saved markup snapshot' : 'nowhere (not set)'}`);
  if (c.nesting) lines.push(`  nesting     ${c.nesting.components} component(s)  ·  ${nestingLabel(c.nesting)}`);
  lines.push(`  read by     ${snapshot._sources?.browser ? 'browser + static CSS' : 'static CSS only'}`);
  const unc = Object.entries(snapshot.tokens ?? {}).flatMap(([n, t]) => Object.entries(t.modes).filter(([, f]) => f.confidence === 'uncertain').map(([m, f]) => `${n} (${m}): browser ${f.readings.browser} · CSS ${f.readings.static}`));
  if (unc.length) {
    lines.push(`  couldn't read reliably (the two readings disagree, so nothing is claimed about the design):`);
    for (const u of unc.slice(0, 15)) lines.push(`    · ${u}`);
    if (unc.length > 15) lines.push(`    · … ${unc.length - 15} more in the snapshot`);
  }
  for (const n of (c.notRead ?? []).slice(0, 10)) lines.push(`  not read    ${n}`);
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = process.cwd();
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); }
  catch { console.error('❌ ds-config.json not found at project root.'); process.exit(1); }
  const argv = process.argv.slice(2);
  const { snapshot, outPath, cached } = await captureCode(ROOT, cfg, { force: argv.includes('--force'), browser: !argv.includes('--no-browser') });
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n'); process.exit(0); }
  console.log('\n' + captureSummary(snapshot, outPath, ROOT) + (cached ? '\n  (unchanged since the last capture)' : '') + '\n');
  // --compare: the same facts side by side with the Figma snapshots (calibration, and the neutral
  // comparison the authoring model builds on). Written in full to .parity-out/code-vs-figma.json.
  if (argv.includes('--compare')) {
    const { compareCapture, compareReport } = await import('./capture-compare.mjs');
    const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
    const r = await compareCapture(ROOT, cfg, snapshot, { readJSON });
    writeFileSync(join(dirname(outPath), 'code-vs-figma.json'), JSON.stringify(r, null, 2) + '\n');
    console.log(compareReport(r) + `\n  full list → ${relative(ROOT, join(dirname(outPath), 'code-vs-figma.json'))}\n`);
  }
  // An empty capture is a failure, never a quiet pass (the same rule Gate 1 applies to Figma data).
  if (!snapshot._coverage?.tokens) { console.error('❌ The code capture read no tokens at all. Check paths.themeCSS in ds-config.json.'); process.exit(1); }
}
