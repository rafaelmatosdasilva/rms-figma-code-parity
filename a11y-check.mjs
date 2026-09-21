// a11y-check.mjs — I18 Accessibility gate.  Run from project root:
//   node a11y-check.mjs [--component A,B|.selector] [--url <page>] [--a11y]
//
// Mechanical + agnostic: reads the REAL render (headless Chrome via the DevTools Protocol,
// the same flow as rendered-check.mjs / Gate 22), never an assumed DS shape.
//
// Render targets — NO project shape is imposed. It loads, in priority order: a live page from
// `--url <page>` (repeatable/comma), then `ds-config.json → a11y.urls` (any project that serves
// its components — a Vue/Vite SPA, Storybook, a deployed styleguide), then the built plugin UIs
// via file:// (the Figma-plugin shape). So a non-plugin DS is checked by pointing it at a running
// dev server; `--url` even runs with no ds-config.json at all. `a11y.waitFor` (a selector) delays
// the sweep until an SPA has rendered.
//
// Per configured theme it checks:
//   1. Contrast  — WCAG 2.1 AA ratio of each text leaf's computed color vs its EFFECTIVE
//                  (composited) background; normal >= 4.5:1, large >= 3:1.
//   2. Name/role — every interactive node in the accessibility tree has a non-empty
//                  accessible name and a resolvable role (catches the icon-button-with-no-label).
//   3. Focus     — every focusable element shows a computed style change when focused.
//
// Advisory by default (never fails the audit); `ds-config.json → a11yStrict: true` promotes
// findings to a hard fail (exit 1). Skips cleanly (exit 0) when no browser is available — never
// a false fail. `--component A,B` scopes the contrast/focus sweep to those components' subtrees.
//
// No npm dependencies (Node >= 22 built-in WebSocket). Honors No-imposed-structure: findings
// come from measured pixels and the accessibility tree, not from any presumed token/tier model.
//
// NOT yet (v2, by design):
//   - Non-text / component contrast (WCAG 1.4.11, >= 3:1) — borders, icons, states.
//   - Per-interaction-state a11y (real focus/hover/checked, reusing the state walk).
//   - Keyboard order, skip links, landmarks — and anything the render cannot reveal: only when
//     the project declares it in ds-config.json, never imposed (No-imposed-structure).

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

// ── Pure, unit-testable core (exported; importing this module runs NOTHING) ─────
// Parse a computed-style color. Returns {r,g,b,a} or null when it is not an rgb()/rgba()
// (e.g. a gradient keyword or color(display-p3 …)) — callers treat null as "cannot compute".
export function parseColor(s) {
  if (typeof s !== 'string') return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

// Composite a translucent foreground over an opaque background (both {r,g,b}, fg has a).
export function over(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
}

// Resolve the effective background from a nearest-first stack of computed background-color
// strings (element's own first, ancestors outward up to the first opaque one). Composites over
// white (the canvas default) in paint order.
export function effectiveBg(layers) {
  const parsed = layers.map(parseColor).filter(Boolean);
  let eff = { r: 255, g: 255, b: 255 };
  for (let i = parsed.length - 1; i >= 0; i--) eff = over(parsed[i], eff);
  return eff;
}

// WCAG relative luminance of an {r,g,b} in 0–255.
export function relLuminance({ r, g, b }) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG contrast ratio between two {r,g,b} colors (1–21).
export function contrastRatio(c1, c2) {
  const L1 = relLuminance(c1), L2 = relLuminance(c2);
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG "large text": >= 24px, or >= 18.66px when bold (>= 700).
export function isLargeText(fontSizePx, fontWeight) {
  const w = Number(fontWeight) || (fontWeight === 'bold' ? 700 : 400);
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && w >= 700);
}

// AA threshold for a text element.
export function aaThreshold(fontSizePx, fontWeight) {
  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
}

// Interactive ARIA roles that must carry an accessible name.
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'tab', 'option',
]);

// Turn one theme's captured text leaves into contrast findings (pure; the heart of the gate).
export function contrastFindings(textEls, theme) {
  const out = [];
  for (const el of textEls) {
    if (el.bgImage) { out.push({ kind: 'contrast', theme, desc: el.desc, text: el.text, cannotCompute: 'background-image/gradient' }); continue; }
    const fg = parseColor(el.color);
    if (!fg) continue;
    const bg = effectiveBg(el.bgLayers);
    const ratio = contrastRatio(fg, bg);
    const threshold = aaThreshold(el.fontSize, el.fontWeight);
    if (ratio + 1e-9 < threshold) {
      out.push({ kind: 'contrast', theme, desc: el.desc, text: el.text, ratio: Math.round(ratio * 100) / 100, threshold });
    }
  }
  return out;
}

// ── Auto-discovery: start the project's dev server and enumerate render pages ────
// The most-automated path when nothing is configured and there is no static build. Reads
// package.json for a dev/serve/storybook script, starts it, reads the URL it prints, then
// enumerates targets: Storybook stories → else static router routes → else the base page.
// Fully agnostic (no DS shape assumed) and opt-out via ds-config.json → a11y.discover:false.
// Any failure returns null/nothing — the caller then asks or skips, never a crash.
function detectServeCmd(ROOT, cfg) {
  if (cfg.a11y?.serve) return cfg.a11y.serve;
  let pkg; try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); } catch { return null; }
  const s = pkg.scripts || {};
  for (const name of ['storybook', 'dev', 'serve', 'start', 'preview']) if (s[name]) return 'npm run ' + name;
  return null;
}
function startDevServer(cmd, ROOT) {
  const parts = cmd.split(/\s+/);
  const proc = spawn(parts[0], parts.slice(1), { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' } });
  const stop = () => { try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} } };
  const url = new Promise((res) => {
    let buf = '', done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    const scan = (d) => { buf += d.toString(); const m = buf.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"]*/i); if (m) finish(m[0].replace(/\/+$/, '')); };
    proc.stdout.on('data', scan); proc.stderr.on('data', scan);
    proc.on('exit', () => finish(null));
    setTimeout(() => finish(null), 40000);   // give the server up to 40s to print a URL
  });
  return { url, stop };
}
async function fetchJson(u) { try { const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function discoverStorybook(base) {
  for (const p of ['/index.json', '/stories.json']) {
    const j = await fetchJson(base + p); if (!j) continue;
    const entries = j.entries || j.stories || {};
    const ids = Object.values(entries).filter((e) => (e.type ?? 'story') === 'story').map((e) => e.id).filter(Boolean);
    if (ids.length) return ids.map((id) => `${base}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);
  }
  return null;
}
function discoverRoutes(ROOT, base) {
  const files = ['src/router/index.ts', 'src/router/index.js', 'src/router.ts', 'src/router.js', 'src/routes.ts', 'src/routes.js', 'src/App.tsx', 'src/App.jsx'];
  const out = new Set();
  for (const rel of files) {
    let txt; try { txt = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/\bpath\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      const p = m[1];
      if (p.startsWith('/') && !p.includes(':') && !p.includes('*')) out.add(p);   // static routes only (no params/wildcards)
    }
  }
  const b = base.replace(/\/$/, '');
  return out.size ? [...out].map((p) => b + p) : null;
}

// ── CLI arg helpers ─────────────────────────────────────────────────────────────
function argValues(flag, argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
    else if (argv[i].startsWith(flag + '=')) out.push(argv[i].slice(flag.length + 1));
  }
  return out.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
}

// ── Chrome discovery (mirrors rendered-check.mjs) ───────────────────────────────
function findChrome() {
  const abs = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean);
  for (const p of abs) if (existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

// The in-page sweep: collect visible text leaves (with their computed color + background layer
// stack + font) and focusable elements that show no focus-style change. Runs entirely in the page.
function sweepExpression(roots, doFocus) {
  return `(() => {
    const roots = ${JSON.stringify(roots)};
    const rootEls = roots ? roots.flatMap(s => [...document.querySelectorAll(s)]) : [document.body];
    const scope = roots ? rootEls.flatMap(r => [r, ...r.querySelectorAll('*')]) : [...document.body.querySelectorAll('*')];
    const vis = (el) => { const s = getComputedStyle(el); if (s.display==='none'||s.visibility==='hidden'||+s.opacity===0) return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const disabled = (el) => el.disabled===true || el.getAttribute('aria-disabled')==='true';
    const seen = new Set();
    const textEls = [];
    for (const el of scope) {
      if (seen.has(el)) continue; seen.add(el);
      if (!vis(el) || disabled(el)) continue;
      const hasText = [...el.childNodes].some(n => n.nodeType===3 && n.textContent.trim());
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      const layers = []; let node = el;
      while (node && node.nodeType===1) {
        const b = getComputedStyle(node).backgroundColor; layers.push(b);
        const mm = b.match(/^rgba?\\(([^)]+)\\)/);
        const parts = mm ? mm[1].split(',') : null;
        const a = parts ? (parts[3]!==undefined ? parseFloat(parts[3]) : 1) : 0;
        if (a === 1) break;
        node = node.parentElement;
      }
      const cls = (el.className && typeof el.className==='string') ? '.'+el.className.trim().split(/\\s+/).join('.') : '';
      textEls.push({
        desc: (el.tagName.toLowerCase() + (el.id?('#'+el.id):'') + cls).slice(0,80),
        text: [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim().slice(0,40),
        color: cs.color, bgLayers: layers,
        fontSize: parseFloat(cs.fontSize) || 16, fontWeight: cs.fontWeight,
        bgImage: !!(cs.backgroundImage && cs.backgroundImage !== 'none'),
      });
    }
    let noFocus = [];
    if (${doFocus ? 'true' : 'false'}) {
      const focusables = scope.filter(el => vis(el) && !disabled(el) && el.matches('a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[role=button],[role=link]'));
      for (const el of focusables) {
        const b = getComputedStyle(el); const before = b.outlineStyle+'|'+b.outlineWidth+'|'+b.boxShadow+'|'+b.borderColor+'|'+b.borderWidth;
        try { el.focus(); } catch(e){}
        const a = getComputedStyle(el); const after = a.outlineStyle+'|'+a.outlineWidth+'|'+a.boxShadow+'|'+a.borderColor+'|'+a.borderWidth;
        try { el.blur(); } catch(e){}
        if (before === after) noFocus.push((el.tagName.toLowerCase()+(el.id?('#'+el.id):'')).slice(0,60));
      }
    }
    return { textEls, noFocus };
  })()`;
}

async function main() {
  const ROOT = process.cwd();
  const argv = process.argv.slice(2);
  const VERBOSE = argv.includes('--a11y');
  const components = argValues('--component', argv).concat(argValues('--components', argv));
  const cliUrls = argValues('--url', argv);   // check a live page directly (any project that serves it)

  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); }
  catch {
    // --url runs configuration-free (a non-plugin DS with no ds-config still gets checked).
    if (!cliUrls.length) { console.error('❌ ds-config.json not found at project root (or pass --url <page> to check a live URL without a config).'); process.exit(1); }
  }

  const STRICT = cfg.a11yStrict === true;
  const skip = (msg) => { console.log(`⏭  [a11y] ${msg}`); process.exit(0); };

  const plugins = cfg.paths?.plugins ?? [];
  const pluginSrc = cfg.paths?.pluginCSS ?? [];

  const modes = (cfg.figma?.modes?.length ? cfg.figma.modes : [{ name: 'Light', snapshotKey: 'light' }])
    .map((m) => ({ name: m.name || m.snapshotKey || 'light', scheme: (m.snapshotKey || m.name || 'light').toLowerCase().includes('dark') ? 'dark' : 'light' }));
  const selOf = (name) => {
    if (cfg.componentSelectors?.[name]) return cfg.componentSelectors[name];
    if (/^[.#\[]/.test(name)) return name;                        // already a CSS selector — use as-is
    return '.' + name.charAt(0).toLowerCase() + name.slice(1);    // DS convention: ComponentName -> .componentName
  };
  const roots = components.length ? components.map(selOf) : null;

  const builtUiPath = (plugin) => {
    const i = plugins.indexOf(plugin);
    const src = i >= 0 ? pluginSrc[i] : null;
    return join(ROOT, src ? src.replace(/\.src\.html$/, '.html') : `apps/${plugin}/ui.html`);
  };

  // Render targets — no project shape imposed. Priority: --url > ds-config a11y.urls > built
  // static HTML (the plugin shape) > AUTO-DISCOVERY (start the dev server + enumerate pages).
  const urlList = [...cliUrls, ...(cfg.a11y?.urls ?? [])];
  let stopServer = null;
  let targets = urlList.length
    ? urlList.map((u) => ({ label: u, url: u }))
    : plugins.map(builtUiPath).filter((f) => existsSync(f)).map((f) => ({ label: f.replace(ROOT + '/', ''), url: pathToFileURL(f).href }));

  // Nothing configured or built → be as automatic as possible: start the project's dev server
  // and discover pages (Storybook stories, else static router routes, else the base page). This
  // is what lets a non-plugin DS (SPA/Storybook) run with zero config and zero questions.
  if (!targets.length && cfg.a11y?.discover !== false) {
    let base = cfg.a11y?.baseUrl || null;
    if (!base) {
      const cmd = detectServeCmd(ROOT, cfg);
      if (cmd) {
        console.log(`ℹ️  [a11y] no target configured — starting the dev server (${cmd}) to discover pages…`);
        const srv = startDevServer(cmd, ROOT);
        base = await srv.url;
        if (base) stopServer = srv.stop; else srv.stop();
      }
    }
    if (base) {
      const found = (await discoverStorybook(base)) || discoverRoutes(ROOT, base) || [base];
      const capped = found.slice(0, 40);
      targets = capped.map((u) => ({ label: u.startsWith(base) ? (u.slice(base.length) || '/') : u, url: u }));
      console.log(`ℹ️  [a11y] ${found.length === 1 ? 'checking the base page' : `${found.length} page(s) found — checking ${capped.length}`} via ${base}`);
    }
  }

  if (!targets.length) skip('no render targets — start your dev server and pass --url <page> (or set ds-config.json → a11y.urls / a11y.serve), or build the UIs for a static DS. Auto-discovery found nothing.');
  const waitFor = cfg.a11y?.waitFor ?? null;   // optional selector to await before the sweep (SPA hydration)

  const CHROME = findChrome();
  if (!CHROME) skip('Chrome not found (set CHROME_PATH to enable)');
  if (typeof WebSocket === 'undefined') skip('Node >= 22 required (built-in WebSocket)');

  const userDataDir = mkdtempSync(join(tmpdir(), 'a11y-check-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-sandbox', '--disable-gpu', '--disable-extensions', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} try { stopServer?.(); } catch {} };
  process.on('exit', cleanup);
  const killTimer = setTimeout(() => { console.error('❌ [a11y] timed out (120s)'); cleanup(); process.exit(STRICT ? 1 : 0); }, 120000); killTimer.unref();

  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    chrome.on('exit', () => rej(new Error('Chrome exited before DevTools was ready')));
  }).catch(() => null);
  if (!wsUrl) skip('Chrome failed to start');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, (m) => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const findings = [];   // { kind, theme?, desc, ... }
  let sweptPlugins = 0;

  for (const target of targets) {
    const label = target.label;
    const { targetId } = await send('Target.createTarget', { url: target.url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    let loaded = false;
    for (let i = 0; i < 200; i++) {   // up to ~10s — a dev server / SPA can be slower than a file://
      const expr = `document.readyState === "complete"${waitFor ? ` && !!document.querySelector(${JSON.stringify(waitFor)})` : ''}`;
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId).catch(() => ({ result: {} }));
      if (r.result?.value === true) { loaded = true; break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    if (!loaded) { await send('Target.closeTarget', { targetId }); continue; }
    await new Promise((res) => setTimeout(res, 300));   // settle — let an SPA finish its first render
    sweptPlugins++;

    // 2. Name/role — accessibility tree (theme-independent), run once per target.
    try {
      await send('Accessibility.enable', {}, sessionId);
      const { nodes } = await send('Accessibility.getFullAXTree', {}, sessionId);
      for (const n of nodes || []) {
        if (n.ignored) continue;
        const role = n.role?.value;
        if (!INTERACTIVE_ROLES.has(role)) continue;
        const name = (n.name?.value || '').trim();
        if (!name) findings.push({ kind: 'name', plugin: label, role, desc: `<${role}> with no accessible name` });
      }
    } catch { /* Accessibility domain unavailable — skip name/role, not a fail */ }

    // 1 + 3. Contrast per theme; focus once (first theme).
    let first = true;
    for (const mode of modes) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode.scheme }] }, sessionId);
      const r = await send('Runtime.evaluate', { expression: sweepExpression(roots, first), returnByValue: true }, sessionId);
      const { textEls = [], noFocus = [] } = r.result.value || {};
      for (const f of contrastFindings(textEls, mode.name)) findings.push({ plugin: label, ...f });
      if (first) for (const desc of noFocus) findings.push({ kind: 'focus', plugin: label, desc });
      first = false;
    }
    await send('Target.closeTarget', { targetId });
  }

  ws.close(); cleanup(); clearTimeout(killTimer);

  if (!sweptPlugins) skip('nothing rendered to check — a --url/dev-server page did not load, or the plugin UIs are not built');

  // ── Report ────────────────────────────────────────────────────────────────────
  const contrast = findings.filter((f) => f.kind === 'contrast' && !f.cannotCompute);
  const cannot   = findings.filter((f) => f.kind === 'contrast' && f.cannotCompute);
  const names    = findings.filter((f) => f.kind === 'name');
  const focus    = findings.filter((f) => f.kind === 'focus');
  const themes   = [...new Set(modes.map((m) => m.name))];

  console.log(`\n─── [a11y] Accessibility (WCAG AA, from the render) ${STRICT ? '· STRICT' : '· advisory'} ───\n`);
  console.log(`a11y: ${contrast.length} contrast, ${names.length} missing names, ${focus.length} no-focus across ${themes.length} theme(s)${cannot.length ? ` · ${cannot.length} cannot-compute` : ''}`);

  if (VERBOSE) {
    const show = (list, head, fmt) => { if (!list.length) return; console.log(`\n  ${head}`); for (const f of list.slice(0, 100)) console.log(`    · ${fmt(f)}`); };
    show(contrast, 'Below AA contrast:', (f) => `[${f.theme}] ${f.desc} — ${f.ratio}:1 < ${f.threshold}:1${f.text ? `  ("${f.text}")` : ''}`);
    show(names, 'Missing accessible name:', (f) => `${f.desc} (${f.plugin})`);
    show(focus, 'No visible focus indicator:', (f) => `${f.desc} (${f.plugin})`);
    show(cannot, 'Cannot compute (image/gradient background):', (f) => `[${f.theme}] ${f.desc}`);
  } else if (contrast.length + names.length + focus.length) {
    console.log('   run with --a11y to list every finding');
  }

  const total = contrast.length + names.length + focus.length;
  if (STRICT && total) {
    console.log(`\n❌ [a11y] a11yStrict: ${total} accessibility issue(s)`);
    process.exit(1);
  }
  process.exit(0);
}

// Only run when invoked directly — importing for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('⏭  [a11y] skipped - ' + e.message); process.exit(0); });
}
