// a11y-check.mjs — I18 Accessibility gate.  Run from project root:
//   node a11y-check.mjs [--component A,B|.selector] [--url <page>] [--a11y]
//
// Mechanical + agnostic: reads the REAL render (headless Chrome via the DevTools Protocol,
// the same flow as rendered-check.mjs / Gate 22), never an assumed DS shape.
//
// Render targets — NO project shape is imposed. It loads, in priority order: a live page from
// `--url <page>` (repeatable/comma), then `ds-config.json → a11y.urls` (any project that serves
// its components — a Vue/Vite SPA, Storybook, a deployed styleguide), then the **generated
// styleguide** (`ds-config.json → styleguide.out`, default `apps/styleguide/index.html`) via
// file:// — one static page that renders every component × every state, so the sweep gets
// deterministic, per-state coverage with no dev server; then the built plugin UIs via file://
// (the Figma-plugin shape); then AUTO-DISCOVERY (start the dev server + enumerate pages). So a
// non-plugin DS is checked by pointing it at a running dev server; `--url` even runs with no
// ds-config.json at all. `a11y.waitFor` (a selector) delays the sweep until an SPA has rendered.
// `a11y.styleguide:false` opts out of the styleguide target; `a11y.regenerateStyleguide:true`
// rebuilds it first (via styleguide-gen.mjs) so a11y never audits a stale one.
//
// It checks:
//   1. Contrast   — WCAG 2.1 AA ratio of each text leaf's computed color vs its EFFECTIVE
//                   (composited) background; normal >= 4.5:1, large >= 3:1. Per theme.
//   2. Name/role  — every interactive node in the accessibility tree has a non-empty accessible
//                   name and a resolvable role (a component not exposing aria / an icon-button
//                   with no label).
//   3. Focus      — every focusable element shows a computed style change when focused, AND that
//                   change is actually visible: the focus ring's colour has >= 3:1 contrast against
//                   its background (WCAG 1.4.11 for focus — a ring that "changes" but is nearly the
//                   same colour is still invisible).
//   4. State expo — an element whose STATE is shown only by a CSS class (selected / checked /
//                   expanded / disabled / invalid / pressed / …) but never through the matching
//                   aria/native state, so assistive tech never hears it. State-class → aria map
//                   is common-English by default; extend via ds-config.json → a11y.stateClasses.
//   5. Keyboard   — an interactive control that cannot be reached by keyboard (an interactive
//                   role on a non-focusable element, or a native control with tabindex=-1).
//
// Output is plain language, no jargon: each issue says what is wrong, why it matters, and what to
// do. `--a11y` adds the exact elements; `--json` emits a machine-readable record for an agent/CI.
// `--axe` (or ds-config a11y.axe:true) also runs axe-core (fetched from a CDN, no npm dep) for the
// broader WCAG rules the five checks above do not cover — non-text contrast, target size, duplicate
// ids, ARIA validity, heading order, labels — reported as an extra advisory section. `--states`
// (or a11y.interactionStates:true) forces :hover and re-measures, flagging text that reads fine at
// rest but fails contrast while hovered.
//
// Advisory by default (never fails the audit); `ds-config.json → a11yStrict: true` promotes
// findings to a hard fail (exit 1). Skips cleanly (exit 0) when no browser is available — never
// a false fail. `--component A,B|.selector` scopes the sweep to those components' subtrees.
//
// No npm dependencies (Node >= 22 built-in WebSocket). Honors No-imposed-structure: findings
// come from measured pixels and the accessibility tree, not from any presumed token/tier model.
//
// NOT yet (v2, by design):
//   - Non-text / component contrast (WCAG 1.4.11, >= 3:1): the FOCUS RING is now checked natively
//     (see check 3); the rest (control borders, icons, graphics) comes from --axe.
//   - Live pseudo-class states (:hover / :active) — the styleguide target below renders every
//     variant state (disabled / checked / selected / error) as its OWN instance, so those are
//     covered in the resting DOM; forcing true interaction pseudo-states is the remaining step.
//   - Reading order, skip links, landmark completeness — and anything the render cannot reveal:
//     only when the project declares it in ds-config.json, never imposed (No-imposed-structure).

import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { findChrome, launchChrome, connectCDP, openPage, waitForTrue } from './cdp.mjs';
import { loadLocator } from './component-locator.mjs';

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

// ── Plain-language reporting (pure; exported for tests) ─────────────────────────
// No jargon: every issue says what is wrong, why it matters to a real person, and what to
// do about it. `title` returns the count sentence, singular/plural aware.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const A11Y_GUIDE = {
  contrast: {
    title: (n) => `${plural(n, 'piece of text is', 'pieces of text are')} hard to read`,
    why: 'The text colour is too close to its background, so it is hard to read — and can be invisible when the page is shown in the other theme (light vs dark).',
    fix: 'Use a darker or lighter text colour, or add the colour for the theme that is missing.',
  },
  name: {
    title: (n) => `${plural(n, 'button or field has', 'buttons or fields have')} no label for screen readers`,
    why: 'A button that is only an icon, or a field with no label, is silent to someone using a screen reader — they hear nothing when they reach it.',
    fix: 'Give it a name: add aria-label to an icon button, or a <label> to an input.',
  },
  focus: {
    title: (n) => `${plural(n, 'control does', 'controls do')} not show where the keyboard is`,
    why: 'When someone moves through the page with the Tab key, nothing lights up, so they cannot tell which control they are on.',
    fix: 'Add a visible outline (a focus ring) on the control itself when it is focused — not only on a box around it.',
  },
  focuscontrast: {
    title: (n) => `${plural(n, 'focus outline is', 'focus outlines are')} too faint to see`,
    why: 'The control does light up when focused, but the outline is so close in colour to its background that a keyboard user still cannot tell where they are.',
    fix: 'Make the focus outline stand out clearly — a stronger colour or a thicker ring, so it is at least three times the contrast of whatever is behind it.',
  },
  hovercontrast: {
    title: (n) => `${plural(n, 'control becomes', 'controls become')} hard to read on hover`,
    why: 'When the mouse is over the control its colours change to something too faint — readable at rest, but not while it is being used.',
    fix: 'Give the hover state the same care as the normal state: keep the text at least 4.5 times the contrast of its background.',
  },
  ariastate: {
    title: (n) => `${plural(n, 'control shows', 'controls show')} their state only by looks`,
    why: 'Something is marked selected, checked or open only with colour or a CSS class, so a screen reader never announces that state.',
    fix: 'Also set the matching accessibility attribute: aria-selected, aria-checked, aria-expanded, and so on.',
  },
  keyboard: {
    title: (n) => `${plural(n, 'control cannot', 'controls cannot')} be used with the keyboard`,
    why: 'The control works with a mouse, but the Tab key skips over it, so people who only use a keyboard cannot reach it.',
    fix: 'Use a real <button> or link, or add tabindex="0" so it can be focused.',
  },
};
const A11Y_ROLE_WORD = { button: 'A button', link: 'A link', textbox: 'An input field', searchbox: 'A search field', checkbox: 'A checkbox', radio: 'A radio button', switch: 'A switch', combobox: 'A dropdown', tab: 'A tab', slider: 'A slider' };
// One readable line locating a single finding.
export function a11yItemLine(kind, f) {
  if (kind === 'contrast') {
    const what = f.text ? `the text "${f.text}"` : (f.desc || 'text');
    return `${what} — its readability score is ${f.ratio} out of 21, needs at least ${f.threshold} (${f.theme} theme)`;
  }
  if (kind === 'focuscontrast') return `${f.desc} — its focus outline scores ${f.ratio} out of 21, needs at least ${f.threshold}`;
  if (kind === 'hovercontrast') { const what = f.text ? `the text "${f.text}"` : (f.desc || 'text'); return `${what} on hover — its readability score is ${f.ratio} out of 21, needs at least ${f.threshold}`; }
  if (kind === 'name') return `${A11Y_ROLE_WORD[f.role] || `A ${f.role || 'control'}`} with no label`;
  return f.desc;   // focus / ariastate / keyboard — the CSS selector locates the element
}
// Structured record for --json (machines / an agent that fixes the code): exact locator +
// numbers + the fix. Same facts as the plain lines, but parseable.
export function a11yFindingRecord(kind, f) {
  const rec = { issue: kind, selector: f.desc ?? null, fix: A11Y_GUIDE[kind]?.fix ?? null };
  if (kind === 'contrast' || kind === 'hovercontrast') { rec.theme = f.theme ?? null; rec.text = f.text ?? null; rec.contrast = f.ratio ?? null; rec.needs = f.threshold ?? null; }
  if (kind === 'focuscontrast') { rec.contrast = f.ratio ?? null; rec.needs = f.threshold ?? null; }
  if (kind === 'name') rec.role = f.role ?? null;
  return rec;
}
// Collapse axe-core's per-node violations into one row per rule (highest count first).
export function summarizeAxe(violations) {
  const byId = {};
  for (const v of violations || []) {
    const e = (byId[v.id] ??= { id: v.id, help: v.help, impact: v.impact, helpUrl: v.helpUrl, count: 0, targets: [] });
    e.count += v.count || 0;
    for (const t of v.targets || []) if (e.targets.length < 8 && !e.targets.includes(t)) e.targets.push(t);
  }
  return Object.values(byId).sort((a, b) => b.count - a.count);
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

// ── The generated styleguide as a render target ─────────────────────────────────
// styleguide-gen.mjs writes one static page rendering every component × every state. As a
// file:// a11y target it is deterministic, complete and needs no dev server — and because
// each state is its own instance in the resting DOM, the existing sweep gets per-state
// coverage for free. Returns the target or null (missing, or opted out via a11y.styleguide:false).
export function styleguideTarget(cfg, ROOT, exists = existsSync) {
  if (cfg?.a11y?.styleguide === false) return null;
  const rel = cfg?.styleguide?.out ?? 'apps/styleguide/index.html';
  const abs = join(ROOT, rel);
  if (exists(abs)) return { label: rel, url: pathToFileURL(abs).href, styleguide: true };
  // Not built by the project yet: the code capture keeps its own copy, built from the same template.
  const cap = join(ROOT, dirname(cfg?.codeReading?.out ?? '.parity-out/code.snapshot.json'), 'styleguide.html');
  return cfg?.styleguide?.template && exists(cap) ? { label: 'styleguide (built by the code capture)', url: pathToFileURL(cap).href, styleguide: true } : null;
}

// Chrome discovery + DevTools plumbing live in cdp.mjs (shared with Gate [16]).

// The in-page sweep: collect visible text leaves (with their computed color + background layer
// stack + font) and focusable elements that show no focus-style change. Runs entirely in the page.
function sweepExpression(roots, doFocus, stateMap) {
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
    let noFocus = [], faintFocus = [], ariaState = [], notKeyboard = [];
    if (${doFocus ? 'true' : 'false'}) {
      const STATE_MAP = ${JSON.stringify(stateMap || {})};
      const stateWords = Object.keys(STATE_MAP);
      const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=slider]';
      const NATIVE_FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea';
      const IROLES = ['button','link','checkbox','radio','switch','tab','menuitem','option','combobox','slider'];
      for (const el of scope) {
        if (!vis(el)) continue;
        const desc = (el.tagName.toLowerCase()+(el.id?('#'+el.id):'')).slice(0,60);
        const role = el.getAttribute('role');
        const isInteractive = el.matches(INTERACTIVE);
        // 3. Visible focus — does focusing change the look, and is that change actually visible?
        if (!disabled(el) && el.matches('a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[role=button],[role=link]')) {
          const b = getComputedStyle(el); const before = b.outlineStyle+'|'+b.outlineWidth+'|'+b.boxShadow+'|'+b.borderColor+'|'+b.borderWidth;
          try { el.focus(); } catch(e){}
          const a = getComputedStyle(el); const after = a.outlineStyle+'|'+a.outlineWidth+'|'+a.boxShadow+'|'+a.borderColor+'|'+a.borderWidth;
          if (before === after) { noFocus.push(desc); }
          else {
            // Something changed — capture the focus-indicator colour + its background so Node can
            // check it is perceivable (WCAG 1.4.11, >= 3:1). A ring that "changes" but is nearly the
            // same colour as its background is still invisible to a keyboard user.
            let ind = null;
            if (a.outlineStyle !== 'none' && parseFloat(a.outlineWidth) > 0) ind = a.outlineColor;
            else if (a.boxShadow !== b.boxShadow && a.boxShadow !== 'none') { const m = a.boxShadow.match(/rgba?\\([^)]+\\)/); ind = m ? m[0] : null; }
            else if (a.borderColor !== b.borderColor) ind = a.borderColor;
            if (ind) {
              const layers = []; let node = el;
              while (node && node.nodeType===1) {
                const bg = getComputedStyle(node).backgroundColor; layers.push(bg);
                const mm = bg.match(/^rgba?\\(([^)]+)\\)/); const parts = mm ? mm[1].split(',') : null;
                const al = parts ? (parts[3]!==undefined ? parseFloat(parts[3]) : 1) : 0;
                if (al === 1) break; node = node.parentElement;
              }
              faintFocus.push({ desc, color: ind, bgLayers: layers });
            }
          }
          try { el.blur(); } catch(e){}
        }
        // 4. State communicated ONLY by a CSS class — a state word in the class list with no
        //    matching aria/native state, so assistive tech never hears the state.
        if (isInteractive || role) {
          const tokens = ((el.className && typeof el.className==='string') ? el.className.toLowerCase() : '').split(/[\\s_-]+/).filter(Boolean);
          for (const w of stateWords) {
            if (!tokens.includes(w)) continue;
            const spec = STATE_MAP[w];
            const got = spec.attr==='disabled'
              ? (el.disabled===true || el.getAttribute('aria-disabled')==='true')
              : (el.getAttribute(spec.attr)===spec.val || (spec.val==='true' && el.getAttribute(spec.attr)==='true'));
            if (!got) { ariaState.push((desc+' .'+w).slice(0,70)); break; }
          }
        }
        // 5. Keyboard reachability — an interactive control that cannot be reached by keyboard.
        const interactiveRole = role && IROLES.includes(role);
        if ((interactiveRole || isInteractive) && !disabled(el)) {
          const ti = el.getAttribute('tabindex');
          const focusable = el.matches(NATIVE_FOCUSABLE) ? ti !== '-1' : (ti !== null && Number(ti) >= 0);
          if (!focusable) notKeyboard.push((desc+(role?('[role='+role+']'):'')).slice(0,70));
        }
      }
    }
    return { textEls, noFocus, faintFocus, ariaState, notKeyboard };
  })()`;
}

// ── axe-core (opt-in, I32): broaden coverage toward full WCAG rule set ───────────
// Fetch the scanner source once (any CDN, pinned; no npm dependency), inject it into the
// already-open page and run it. Adds the rules our own five checks do not cover — non-text
// contrast, target size, duplicate ids, ARIA validity, and more — mapped to plain findings.
// Degrades to null on any failure (offline, blocked), so the core check is never affected.
async function fetchAxeSource() {
  try {
    const r = await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js', { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}
async function runAxe(send, sessionId, axeSource) {
  if (!axeSource) return null;
  try {
    await send('Runtime.evaluate', { expression: axeSource, returnByValue: false }, sessionId);
    const expr = `axe.run(document, { resultTypes: ['violations'] })
      .then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, help: v.help, impact: v.impact, helpUrl: v.helpUrl, count: v.nodes.length, targets: v.nodes.slice(0, 4).map(n => (n.target || []).join(' ')) }))))
      .catch(e => 'ERR:' + e.message)`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    const val = r.result?.value;
    if (typeof val !== 'string' || val.startsWith('ERR:')) return null;
    return JSON.parse(val);
  } catch { return null; }
}

async function main() {
  const ROOT = process.cwd();
  const argv = process.argv.slice(2);
  const VERBOSE = argv.includes('--a11y');
  const JSON_MODE = argv.includes('--json');   // structured output for an agent/CI that fixes the code
  const components = argValues('--component', argv).concat(argValues('--components', argv));
  const cliUrls = argValues('--url', argv);   // check a live page directly (any project that serves it)

  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); }
  catch {
    // --url runs configuration-free (a non-plugin DS with no ds-config still gets checked).
    if (!cliUrls.length) { console.error('❌ ds-config.json not found at project root (or pass --url <page> to check a live URL without a config).'); process.exit(1); }
  }

  const STRICT = cfg.a11yStrict === true;
  const RUN_AXE = argv.includes('--axe') || cfg.a11y?.axe === true;   // broaden coverage with axe-core (opt-in)
  const RUN_STATES = argv.includes('--states') || cfg.a11y?.interactionStates === true;   // check :hover contrast (opt-in)
  const skip = (msg) => { console.log(`⏭  [a11y] ${msg}`); process.exit(0); };

  const plugins = cfg.paths?.plugins ?? [];
  const pluginSrc = cfg.paths?.pluginCSS ?? [];

  const modes = (cfg.figma?.modes?.length ? cfg.figma.modes : [{ name: 'Light', snapshotKey: 'light' }])
    .map((m) => ({ name: m.name || m.snapshotKey || 'light', scheme: (m.snapshotKey || m.name || 'light').toLowerCase().includes('dark') ? 'dark' : 'light' }));
  const locator = await loadLocator(ROOT, cfg);   // the one shared component finder
  const selOf = (name) => locator.selectorFor(name);
  const roots = components.length ? components.map(selOf) : null;

  const builtUiPath = (plugin) => {
    const i = plugins.indexOf(plugin);
    const src = i >= 0 ? pluginSrc[i] : null;
    return join(ROOT, src ? src.replace(/\.src\.html$/, '.html') : `apps/${plugin}/ui.html`);
  };

  // Render targets — no project shape imposed. Priority: --url / a11y.urls > the generated
  // styleguide (every component × state, no dev server) > built plugin UIs > AUTO-DISCOVERY.
  const urlList = [...cliUrls, ...(cfg.a11y?.urls ?? [])];
  let stopServer = null;

  // Opt-in: (re)generate the styleguide first so a11y never audits a stale one.
  if (!urlList.length && cfg.a11y?.regenerateStyleguide && cfg.styleguide?.template) {
    try {
      const { generateStyleguide } = await import('./styleguide-gen.mjs');
      const r = await generateStyleguide(ROOT, cfg);
      console.log(`ℹ️  [a11y] regenerated styleguide → ${r.out.replace(ROOT + '/', '')}`);
    } catch (e) { console.log(`ℹ️  [a11y] styleguide regeneration skipped: ${e.message}`); }
  }

  const sg = urlList.length ? null : styleguideTarget(cfg, ROOT);
  let targets;
  if (urlList.length) {
    targets = urlList.map((u) => ({ label: u, url: u }));
  } else if (sg) {
    targets = [sg];
    console.log(`ℹ️  [a11y] target: the generated styleguide — every component × state on one page, no dev server (${sg.label})`);
  } else {
    targets = plugins.map(builtUiPath).filter((f) => existsSync(f)).map((f) => ({ label: f.replace(ROOT + '/', ''), url: pathToFileURL(f).href }));
  }

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

  // State-class → the aria/native state it must also expose. A common-English default (extend or
  // override per project via ds-config.json → a11y.stateClasses). Curated words only, so a plain
  // decorative class never trips it; the check only fires on interactive / roled elements.
  const STATE_MAP = Object.assign({
    selected:      { attr: 'aria-selected', val: 'true' },
    checked:       { attr: 'aria-checked',  val: 'true' },
    expanded:      { attr: 'aria-expanded', val: 'true' },
    open:          { attr: 'aria-expanded', val: 'true' },
    pressed:       { attr: 'aria-pressed',  val: 'true' },
    disabled:      { attr: 'disabled',      val: 'true' },
    invalid:       { attr: 'aria-invalid',  val: 'true' },
    error:         { attr: 'aria-invalid',  val: 'true' },
    current:       { attr: 'aria-current',  val: 'true' },
    indeterminate: { attr: 'aria-checked',  val: 'mixed' },
  }, cfg.a11y?.stateClasses ?? {});

  const CHROME = findChrome();
  if (!CHROME) skip('Chrome not found (set CHROME_PATH to enable)');
  if (typeof WebSocket === 'undefined') skip('Node >= 22 required (built-in WebSocket)');

  let browser = null;
  const cleanup = () => { try { browser?.kill(); } catch {} try { stopServer?.(); } catch {} };
  process.on('exit', cleanup);
  const killTimer = setTimeout(() => { console.error('❌ [a11y] timed out (120s)'); cleanup(); process.exit(STRICT ? 1 : 0); }, 120000); killTimer.unref();

  browser = await launchChrome(CHROME, { tmpPrefix: 'a11y-check-' }).catch(() => null);
  if (!browser) skip('Chrome failed to start');

  const { send, close: closeCDP } = await connectCDP(browser.wsUrl);

  const findings = [];   // { kind, theme?, desc, ... }
  const axeViolations = [];
  let sweptPlugins = 0;

  let axeSource = null;
  if (RUN_AXE) {
    axeSource = await fetchAxeSource();
    if (!axeSource) console.log('ℹ️  [a11y] --axe: could not load axe-core (offline or blocked) — the broader scan was skipped; the core checks still ran.');
  }

  for (const target of targets) {
    const label = target.label;
    const { targetId, sessionId } = await openPage(send, target.url);
    // up to ~10s — a dev server / SPA can be slower than a file://
    const loadedExpr = `document.readyState === "complete"${waitFor ? ` && !!document.querySelector(${JSON.stringify(waitFor)})` : ''}`;
    const loaded = await waitForTrue(send, sessionId, loadedExpr, { attempts: 200, intervalMs: 50, tolerateErrors: true });
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

    // 1. Contrast per theme; 3/4/5. focus + state-exposure + keyboard once (first theme).
    let first = true;
    for (const mode of modes) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode.scheme }] }, sessionId);
      const r = await send('Runtime.evaluate', { expression: sweepExpression(roots, first, STATE_MAP), returnByValue: true }, sessionId);
      const { textEls = [], noFocus = [], faintFocus = [], ariaState = [], notKeyboard = [] } = r.result.value || {};
      for (const f of contrastFindings(textEls, mode.name)) findings.push({ plugin: label, ...f });
      if (first) {
        for (const desc of noFocus) findings.push({ kind: 'focus', plugin: label, desc });
        for (const desc of ariaState) findings.push({ kind: 'ariastate', plugin: label, desc });
        for (const desc of notKeyboard) findings.push({ kind: 'keyboard', plugin: label, desc });
        // Focus indicator visible? (WCAG 1.4.11 for the focus ring — computed in Node)
        for (const f of faintFocus) {
          const raw = parseColor(f.color); if (!raw) continue;
          const bg = effectiveBg(f.bgLayers);
          const fg = raw.a < 1 ? over(raw, bg) : raw;
          const ratio = contrastRatio(fg, bg);
          if (ratio + 1e-9 < 3) findings.push({ kind: 'focuscontrast', plugin: label, desc: f.desc, ratio: Math.round(ratio * 100) / 100, threshold: 3 });
        }
      }
      first = false;
    }
    // Interaction-state contrast (:hover) — force the pseudo-state via CDP and re-measure. Reuses the
    // contrast sweep; reports only text that reads fine at rest but fails while hovered (opt-in --states).
    if (RUN_STATES) {
      try {
        await send('DOM.enable', {}, sessionId);
        await send('CSS.enable', {}, sessionId);
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: modes[0].scheme }] }, sessionId);
        const doc = await send('DOM.getDocument', { depth: -1 }, sessionId);
        const q = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'a[href],button,[role=button],[role=link],input:not([type=hidden]),select,textarea,[tabindex]' }, sessionId);
        const ids = (q.nodeIds || []).slice(0, 400);
        for (const id of ids) { try { await send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] }, sessionId); } catch {} }
        const r = await send('Runtime.evaluate', { expression: sweepExpression(roots, false, STATE_MAP), returnByValue: true }, sessionId);
        const hoverText = (r.result?.value || {}).textEls || [];
        const restKey = new Set(findings.filter((f) => f.kind === 'contrast' && f.theme === modes[0].name).map((f) => f.desc + '|' + f.text));
        for (const f of contrastFindings(hoverText, modes[0].name)) {
          if (!restKey.has(f.desc + '|' + f.text)) findings.push({ kind: 'hovercontrast', plugin: label, theme: f.theme, desc: f.desc, text: f.text, ratio: f.ratio, threshold: f.threshold });
        }
        for (const id of ids) { try { await send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] }, sessionId); } catch {} }
      } catch { /* CSS/DOM domain unavailable — skip the hover pass, not a fail */ }
    }
    if (axeSource) { const v = await runAxe(send, sessionId, axeSource); if (v) for (const row of v) axeViolations.push(row); }
    await send('Target.closeTarget', { targetId });
  }

  closeCDP(); cleanup(); clearTimeout(killTimer);

  if (!sweptPlugins) skip('nothing rendered to check — a --url/dev-server page did not load, or the plugin UIs are not built');

  // ── Report ────────────────────────────────────────────────────────────────────
  const contrast = findings.filter((f) => f.kind === 'contrast' && !f.cannotCompute);
  const cannot   = findings.filter((f) => f.kind === 'contrast' && f.cannotCompute);
  const names    = findings.filter((f) => f.kind === 'name');
  const focus    = findings.filter((f) => f.kind === 'focus');
  const focusCon = findings.filter((f) => f.kind === 'focuscontrast');
  const hoverCon = findings.filter((f) => f.kind === 'hovercontrast');
  const state    = findings.filter((f) => f.kind === 'ariastate');
  const keyboard = findings.filter((f) => f.kind === 'keyboard');
  const themes   = [...new Set(modes.map((m) => m.name))];

  const buckets = [['contrast', contrast], ['hovercontrast', hoverCon], ['name', names], ['focus', focus], ['focuscontrast', focusCon], ['ariastate', state], ['keyboard', keyboard]].filter(([, l]) => l.length);
  const total = buckets.reduce((n, [, l]) => n + l.length, 0);
  const inThemes = themes.length > 1 ? ` (checked in ${themes.length} themes)` : '';

  const axe = RUN_AXE ? summarizeAxe(axeViolations) : [];

  // ── Machine lane (--json): precise, parseable — for an agent/CI that fixes the code ──
  if (JSON_MODE) {
    const issues = buckets.flatMap(([kind, list]) => list.map((f) => a11yFindingRecord(kind, f)));
    console.log(JSON.stringify({
      target: targets.map((t) => t.label),
      usedStyleguide: !!sg,
      themes, strict: STRICT, total, cannotMeasure: cannot.length, issues,
      ...(RUN_AXE ? { axe } : {}),
    }, null, 2));
    process.exit(STRICT && total ? 1 : 0);
  }

  // ── Human lane (default): plain language, no jargon ──
  console.log(`\n─── Accessibility check ${STRICT ? '(must pass)' : '(advisory — never blocks the build)'} ───\n`);
  if (!total) {
    console.log(`Good news: nothing to fix here${inThemes}.`);
  } else {
    console.log(`Found ${plural(total, 'thing', 'things')} that would make this hard to use for some people${inThemes}:\n`);
    for (const [kind, list] of buckets) {
      const g = A11Y_GUIDE[kind];
      console.log(`• ${g.title(list.length)}`);
      console.log(`     Why it matters: ${g.why}`);
      console.log(`     What to do:     ${g.fix}`);
      if (VERBOSE) {
        console.log(`     Where:`);
        for (const f of list.slice(0, 100)) console.log(`       - ${a11yItemLine(kind, f)}`);
        if (list.length > 100) console.log(`       - ...and ${list.length - 100} more`);
      }
      console.log('');
    }
    if (!VERBOSE) console.log(`Want the exact list? Run the same command again with --a11y — it shows every element and where to find it. (Add --json instead for a machine-readable version an agent can act on.)`);
  }
  if (cannot.length) {
    console.log(`\n${cannot.length === 1 ? 'One piece of text sits' : `${cannot.length} pieces of text sit`} on an image or gradient background, so its readability could not be measured automatically — please check ${cannot.length === 1 ? 'it' : 'them'} by eye.`);
  }

  // ── Broader scan (axe-core, opt-in) — the rules our own checks do not cover ──
  if (RUN_AXE && axeSource) {
    if (axe.length) {
      console.log(`\nA broader scanner (axe-core) also found ${plural(axe.length, 'other kind of problem', 'other kinds of problem')}:`);
      for (const v of axe) {
        console.log(`• ${v.help} — in ${plural(v.count, 'place', 'places')}${v.impact ? ` (severity: ${v.impact})` : ''}`);
        if (VERBOSE) for (const t of v.targets.slice(0, 5)) console.log(`       - ${t}`);
      }
      if (!VERBOSE) console.log(`Run with --a11y to see where each one is.`);
    } else {
      console.log(`\nThe broader scanner (axe-core) found nothing beyond the above.`);
    }
  }

  // ── Smart nudge: how to get deeper results (only when a styleguide wasn't the target) ──
  if (!sg && cfg.a11y?.styleguide !== false) {
    const sgOut = cfg.styleguide?.out ?? 'apps/styleguide/index.html';
    if (cfg.styleguide?.template && !existsSync(join(ROOT, sgOut))) {
      console.log(`\nTip for a deeper check: you have a styleguide set up but it isn't built yet. Build it (run the parity with --docs) and this check will use it on its own — that is the most thorough result: every component in every state (normal, disabled, error, focused), all on one page.`);
    } else if (!cfg.styleguide?.template) {
      console.log(`\nTip for a deeper check: this looked at "${targets[0]?.label ?? 'the page it could reach'}", which only shows the components that happen to be on screen. For the most thorough check — every component in every state (normal, disabled, error, focused) — add a styleguide (one page that shows all your components). Once it exists, this check finds and uses it automatically, so nothing is missed.`);
    }
  }

  if (STRICT && total) {
    console.log(`\nThis check is set to must-pass, so the run stops here until these are fixed.`);
    process.exit(1);
  }
  process.exit(0);
}

// Only run when invoked directly — importing for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('⏭  [a11y] skipped - ' + e.message); process.exit(0); });
}
