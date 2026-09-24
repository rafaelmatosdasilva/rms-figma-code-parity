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

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { allModes } from './mode-resolver.mjs';
import { loadCssSources, rootTokens, resolveVars, canonValue } from './css-source.mjs';
import { findChrome, launchChrome, connectCDP, openPage, waitForTrue } from './cdp.mjs';
import { captureComponents, staticComponentReading } from './component-capture.mjs';
import { createLocator } from './component-locator.mjs';

export const CAPTURE_VERSION = 1;
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
  const sg = cfg.styleguide?.out ?? 'apps/styleguide/index.html';
  pages.push({ label: 'styleguide', path: sg });
  for (const p of cfg.codeReading?.pages ?? []) pages.push({ label: String(p), path: p });
  const present = pages.filter((p) => /^https?:\/\//.test(p.path) || existsSync(resolve(ROOT, p.path)));
  return { themeEntries, pages: present };
}

function hashInputs(ROOT, cfg, files, pages, opts) {
  const h = createHash('sha256');
  h.update(`v${CAPTURE_VERSION}|${opts.browser ? 'browser' : 'static'}|${JSON.stringify(cfg.figma?.modes ?? null)}|${JSON.stringify(cfg.figma?.collections ?? null)}|${JSON.stringify(cfg.codeReading ?? null)}`);
  for (const f of ['code-capture.mjs', 'css-source.mjs', 'component-capture.mjs', 'component-locator.mjs']) { try { h.update(readFileSync(join(ENGINE_DIR, f))); } catch { /* engine file */ } }
  for (const extra of opts.extraFiles ?? []) { try { h.update(extra); h.update(readFileSync(extra)); } catch { /* optional */ } }
  for (const abs of [...files.map((f) => f.abs), ...pages.filter((p) => !/^https?:/.test(p.path)).map((p) => resolve(ROOT, p.path))].sort()) {
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

// How to put a page into a mode. Returns { media, viewport, apply, undo } or { unsupported }.
export function modeSwitch(mode) {
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
  let snapNames = [];
  try { snapNames = Object.keys(JSON.parse(readFileSync(resolve(ROOT, cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json'), 'utf8')).components ?? {}); } catch { /* optional */ }
  const names = [...new Set([...snapNames, ...Object.keys(CONTRACT), ...Object.keys(SELECTORS), ...Object.keys(cfg.componentSelectors ?? {})])];
  const probes = new Map();
  for (const a of [...(contract.RENDERED_ASSERTIONS ?? []), ...(contract.CROSS_PLUGIN_CONSISTENCY ?? [])]) {
    if (a?.probe && a.selector && !probes.has(a.selector)) probes.set(a.selector.replace(/\s+/g, ' ').trim(), a.probe);
  }
  const unbuilt = new Set(cfg.knownUnimplementedComponents ?? []);
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
    return { name, selector, locatedBy: locator.sourceOf(name), probe: probes.get(selector) ?? null, states, children, parts, unbuilt: unbuilt.has(name) };
  });
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

// ── Capture ───────────────────────────────────────────────────────────────────
export async function captureCode(ROOT, cfg, { force = false, browser: wantBrowser = true, log = () => {} } = {}) {
  const outPath = resolve(ROOT, cfg.codeReading?.out ?? '.parity-out/code.snapshot.json');
  const modes = allModes(cfg);
  const { themeEntries, pages } = captureInputs(ROOT, cfg);
  const { files, missing, remote } = loadCssSources(ROOT, themeEntries);

  const browserOff = !wantBrowser || cfg.codeReading?.browser === 'off';
  const chromePath = browserOff ? null : findChrome({ playwright: true });
  const canBrowse = !!chromePath && typeof WebSocket !== 'undefined';
  const browserNote = browserOff ? 'browser reading switched off' : !chromePath ? 'Chrome not found (set CHROME_PATH)' : typeof WebSocket === 'undefined' ? 'Node >= 22 required for the browser reading' : null;

  const extraFiles = [cfg.paths?.structureContract ?? 'structure-contract.mjs', cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json', ...(cfg.paths?.pluginCSS ?? [])].map((p) => resolve(ROOT, p));
  const inputHash = hashInputs(ROOT, cfg, files, pages, { browser: canBrowse, extraFiles });
  if (!force && existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev._inputHash === inputHash) { log('code capture unchanged since last run (cache hit)'); return { snapshot: prev, outPath, cached: true }; }
    } catch { /* recapture */ }
  }

  const staticByMode = staticTokenReading(files, modes);
  let browser = null, comp = null;
  const notRead = [...missing.map((m) => `${m}: file not found`), ...remote.map((r) => `${r}: remote stylesheet (static reading skips it; the browser reads it)`)];
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
        browser = await browserTokenReading(ROOT, { files, pages, modes, send: cdp.send, tmpDir });
        notRead.push(...browser.notRead);
        // Components: the styleguide first (every component and state on one page), then the apps;
        // the theme-only page last, as a clean place for probes and bare elements.
        const ordered = [...pages].sort((a, b) => (b.label === 'styleguide') - (a.label === 'styleguide'));
        const compPages = ordered.map((p) => ({ label: p.label, url: /^https?:/.test(p.path) ? p.path : pathToFileURL(resolve(ROOT, p.path)).href }));
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
        });
      } finally { cdp.close(); }
    } catch (e) { notRead.push(`browser reading failed: ${e.message.split('\n')[0]}`); }
    finally { chrome?.kill(); }
  } else if (browserNote) notRead.push(`browser reading skipped: ${browserNote}`);

  const { tokens, appTokens, counts } = mergeTokenReadings({ staticByMode, browser, modes, browserNote: browser ? null : browserNote });
  const components = comp?.components ?? staticComponents(specs, componentSources, modes, browserNote);
  const compCoverage = componentCoverage(specs, components, comp);
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
      notRead,
    },
    tokens,
    appTokens,
    components,
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
