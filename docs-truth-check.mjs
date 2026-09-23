// docs-truth-check.mjs - Gate: documentation surfaces reference ONLY DS truth.
//
// A living styleguide or any DS doc must never invent tokens,
// vars, or values. This gate verifies that every DS reference in a configured
// documentation surface actually EXISTS in the DS:
//
//   1. CSS var references — every `var(--x)` used in the doc must be declared
//      somewhere real: the canonical theme.css / pluginCSS, or the doc's own
//      `:root`/scope declarations (a self-contained doc may inline the theme
//      and add its own chrome vars). A `var(--x)` declared nowhere is either a
//      typo or an invented token → FAIL. (This is what a `--radius-sm` chip
//      referencing a var that doesn't exist trips on.)
//
//   2. DS token-path references — any `radii/… · gap/… · padding/… ·
//      typography/…` path shown as a label must be a real key in the vars/
//      sizing snapshot. An invented `radii/whatever` → FAIL.
//
// Scope is OPT-IN and generic: it runs only when ds-config declares
//   "docs": { "surfaces": ["apps/styleguide/index.html", …] }
// With no `docs.surfaces`, the gate is a no-op PASS (projects without a doc
// surface are unaffected, byte-identical).
//
// Not covered here (deliberately, to stay generic + low-false-positive):
// completeness ("the DS has 8 radii, the doc shows 5") and non-token claims
// (a fake text style). Those belong to the design-intent GENERATOR, which
// derives the doc from canonical sources so invention is impossible upstream.
//
// Requires at project root: ds-config.json (paths.themeCSS, paths.pluginCSS,
// paths.snapshotVars, docs.surfaces).
//
// Exit 0 = every DS reference resolves (or no surfaces configured).
// Exit 1 = invented / dangling DS references found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}

const SURFACES = (cfg.docs?.surfaces ?? []).flat().filter(Boolean);
if (!SURFACES.length) {
  console.log('✅ [docs-truth] no documentation surfaces configured — skipped');
  process.exit(0);
}

const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const PLUGIN_CSS  = (cfg.paths?.pluginCSS ?? []).flat();
const SNAP_VARS   = cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json';

// Sizing token prefixes whose paths are unambiguous enough to validate as labels.
const TOKEN_PREFIXES = ['radii', 'gap', 'padding', 'typography', 'general'];

function readLocal(p) {
  // Only local files are validated; a URL-hosted stylesheet is skipped (its vars
  // can't be read offline — the gate stays best-effort, never a false failure).
  if (/^https?:\/\//.test(p)) return null;
  const abs = join(ROOT, p);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

// ── Declared CSS vars (canonical) ─────────────────────────────────────────────
const declared = new Set();
function collectDeclared(css) {
  if (!css) return;
  const re = /(^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g;
  let m; while ((m = re.exec(css))) declared.add(m[2]);
}
for (const p of [...THEME_PATHS, ...PLUGIN_CSS]) collectDeclared(readLocal(p));

// ── Valid DS token paths (from the vars/sizing snapshot) ──────────────────────
const tokenKeys = new Set();
try {
  const snap = JSON.parse(readLocal(SNAP_VARS) || '{}');
  for (const mode of Object.values(snap.color || {})) for (const k of Object.keys(mode)) tokenKeys.add(k);
  for (const k of Object.keys(snap.sizing || {})) tokenKeys.add(k);
  for (const k of Object.keys(snap.typography || {})) tokenKeys.add('typography/' + k);
} catch {}

// ── Scan each surface ─────────────────────────────────────────────────────────
const findings = [];
const advisories = [];
for (const surface of SURFACES) {
  const doc = readLocal(surface);
  if (doc == null) { console.log(`⚠️  [docs-truth] surface not found, skipped: ${surface}`); continue; }

  // The doc's OWN declarations count as real (inlined theme copy + chrome vars).
  // Declarations are read from the RAW doc (comments can't declare, but a comment
  // never contains a `--x:` we'd want to trust either).
  const docDeclared = new Set(declared);
  { const re = /(^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g; let m; while ((m = re.exec(doc))) docDeclared.add(m[2]); }

  // Usage is scanned with comments stripped: a `/* … */` or `<!-- … -->` that
  // mentions a token path is prose ABOUT the DS, not an invented reference shown
  // to a reader. (JS `//` line comments are left — they rarely carry token paths
  // and stripping them risks eating `https://` etc.)
  const usable = doc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

  // 1. var(--x) references
  const usedVars = new Set();
  { const re = /var\(\s*(--[a-zA-Z0-9_-]+)/g; let m; while ((m = re.exec(usable))) usedVars.add(m[1]); }
  for (const v of usedVars) {
    if (!docDeclared.has(v)) findings.push({ surface, kind: 'css-var', ref: v });
  }

  // 2. DS token-path references (validated only when a snapshot is present)
  if (tokenKeys.size) {
    const re = new RegExp('\\b(' + TOKEN_PREFIXES.join('|') + ')\\/[a-zA-Z0-9][a-zA-Z0-9/_-]*', 'g');
    let m; const seen = new Set();
    while ((m = re.exec(usable))) {
      const path = m[0];
      if (seen.has(path)) continue; seen.add(path);
      // typography/l|m|s are stored under typography/<tier>; others are direct keys.
      if (!tokenKeys.has(path)) findings.push({ surface, kind: 'token-path', ref: path });
    }
  }

  // 3. Icons — a doc must reuse DS icons, not invent or hand-draw them.
  //    (a) every <use href="#id"> must resolve to a <symbol id="id"> defined in
  //        the doc's own DS icon sheet (or the pluginCSS/HTML surfaces). A dangling
  //        icon reference is an invented/typo'd icon → FAIL.
  //    (b) an inline <svg> that DRAWS an icon (its own path/circle/… ) outside a
  //        <symbol>/<defs> is a hand-drawn icon → ADVISORY (heuristic, never fails,
  //        but surfaced so the DS icon can replace it).
  const symbolIds = new Set();
  { const re = /<symbol\b[^>]*\bid=["']([^"']+)["']/g; let m;
    while ((m = re.exec(doc))) symbolIds.add(m[1]);
    for (const p of PLUGIN_CSS) { const c = readLocal(p); if (c) { let n; const r2 = /<symbol\b[^>]*\bid=["']([^"']+)["']/g; while ((n = r2.exec(c))) symbolIds.add(n[1]); } }
  }
  { const re = /<use\b[^>]*?(?:xlink:)?href=["']#([^"']+)["']/g; let m; const seen = new Set();
    while ((m = re.exec(usable))) {
      const id = m[1]; if (seen.has(id)) continue; seen.add(id);
      if (!symbolIds.has(id)) findings.push({ surface, kind: 'icon-ref', ref: '#' + id });
    }
  }
  // Advisory hand-drawn detection: strip the symbol sheet + all <symbol> blocks,
  // then any remaining <svg> that contains a drawing primitive is drawing its own
  // icon rather than <use>-ing a DS one.
  { const stripped = usable.replace(/<symbol\b[\s\S]*?<\/symbol>/g, ' ');
    const svgs = stripped.match(/<svg\b[\s\S]*?<\/svg>/g) || [];
    let handDrawn = 0;
    for (const svg of svgs) {
      if (/<use\b/.test(svg)) continue;                       // references a symbol — fine
      if (/<(path|circle|rect|line|polyline|polygon|ellipse)\b/.test(svg)) handDrawn++;
    }
    if (handDrawn) advisories.push({ surface, kind: 'hand-drawn-icon', count: handDrawn });
  }

  // 4. CSS hygiene — construction rules for a DS doc/styleguide:
  //    (a) NO ALL-CAPS: the DS has none, so `text-transform: uppercase` is invented
  //        styling → FAIL.
  //    (b) COLOURS ARE VARIABLES: a colour literal (#hex / rgb() / hsl()) as the
  //        value of a visual property in a RULE is a hardcoded colour → FAIL.
  //        (A `--token: #hex` declaration is fine — that IS the variable; matched
  //        by the visual property name, so `--x:` never trips.)
  //    (c) TEXT STYLES ARE DS: a hardcoded `font-size` in a rule should be a DS
  //        text-scale var (--s/m/l-size) → ADVISORY (a doc legitimately needs a
  //        few display heading sizes the 3-tier component scale doesn't provide).
  { const re = /text-transform\s*:\s*uppercase/gi; let m;
    while ((m = re.exec(usable))) findings.push({ surface, kind: 'uppercase' }); }
  { const re = /(?:^|[;{"'\s])(color|background|background-color|border|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|fill|stroke|box-shadow|outline|outline-color)\s*:\s*[^;"'}]*?(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/gi;
    let m; const seen = new Set();
    while ((m = re.exec(usable))) { const lit = m[0].replace(/\s+/g, ' ').trim(); if (!seen.has(lit)) { seen.add(lit); findings.push({ surface, kind: 'hardcoded-color', ref: lit.slice(0, 60) }); } } }
  { const re = /font-size\s*:\s*\d/gi; let n = 0; while (re.exec(usable)) n++; if (n) advisories.push({ surface, kind: 'hardcoded-font-size', count: n }); }
}

// ── Report ────────────────────────────────────────────────────────────────────
function printAdvisories() {
  for (const a of advisories) {
    if (a.kind === 'hand-drawn-icon')
      console.log(`  ⚠️  ${a.surface}: ${a.count} inline <svg> icon${a.count > 1 ? 's' : ''} drawn in the doc — reuse a DS icon (<use href="#…">) instead of hand-drawing (advisory)`);
    if (a.kind === 'hardcoded-font-size')
      console.log(`  ⚠️  ${a.surface}: ${a.count} hardcoded font-size${a.count > 1 ? 's' : ''} — prefer a DS text-scale var (--s-size/--m-size/--l-size) (advisory)`);
  }
}

if (!findings.length) {
  console.log(`✅ [docs-truth] every DS reference resolves (${SURFACES.length} surface${SURFACES.length > 1 ? 's' : ''})`);
  printAdvisories();
  process.exit(0);
}

const MSG = {
  'css-var': (r) => `var(${r}) — used but declared nowhere in theme.css / pluginCSS / the doc`,
  'token-path': (r) => `${r} — not a token in the DS snapshot`,
  'icon-ref': (r) => `<use href="${r}"> — no such DS icon symbol (invented or typo'd icon)`,
  'uppercase': () => `text-transform: uppercase — the DS has no all-caps; remove it`,
  'hardcoded-color': (r) => `${r}… — hardcoded colour in a rule; use a DS token / var, never a literal`,
};
console.log(`❌ [docs-truth] ${findings.length} invented / dangling DS reference${findings.length > 1 ? 's' : ''} — the doc names DS things that don't exist:`);
const bySurface = {};
for (const f of findings) (bySurface[f.surface] ??= []).push(f);
for (const [surface, fs] of Object.entries(bySurface)) {
  console.log(`  ${surface}`);
  for (const f of fs) console.log(`    • ${(MSG[f.kind] || ((r) => r))(f.ref)}`);
}
console.log('  Fix: reference a real DS token/var/icon, or remove the invented one. Never invent DS content in docs.');
printAdvisories();
process.exit(1);
