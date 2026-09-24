// reimplementation-check.mjs - Gate: local reimplementation of a DS component (code -> Figma).
// Run from project root: node scripts/reimplementation-check.mjs
//
// The Notion DS manuals put it plainly: "não uses HTML/CSS local para simular componentes."
// Every other code->Figma gate checks names (an invented var, an invented prop). None catches the
// subtler drift: a screen that RE-BUILDS a DS component by hand — a native <button> given a local
// class with its own background/border/radius/padding — instead of using the DS component. The
// markup looks bespoke, passes every token gate (its literals are its own), and silently forks the
// button from the design system.
//
// This gate flags exactly that: an interactive element of a role the DS OWNS (it defines a
// component for it) that (a) does NOT carry a DS component class for that role, yet (b) is locally
// styled to reconstruct the component (background / border / border-radius / padding, via a local
// class rule or an inline style). That pairing — "styled like the component, but not the component"
// — is the signature of a hand-rolled reimplementation.
//
// Direction: code -> Figma. Scope is OPT-IN and generic, exactly like docs.surfaces / screens[]:
//   ds-config.json -> "reimplementationSurfaces": ["apps/*/ui.src.html", "src/views/*.vue", …]
// With none configured the gate is a no-op PASS (unaffected, byte-identical). Roles default to
// ["button"] — the highest-signal, lowest-false-positive case — and can be widened with
// "reimplementationRoles". ADVISORY by default (never blocks); a hard fail only under
// "reimplementationStrict": true. This keeps a brand-new heuristic gate from breaking a build.
//
// Deliberately NOT covered in v1 (kept for a v2, to stay low-false-positive):
//   - native radio/checkbox/input reimplementation — form-control-check.mjs already owns those.
//   - container components (card/modal/badge) rebuilt as <div> — needs shape inference, higher FP.
//
// Reads at project root:
//   ds-config.json - reimplementationSurfaces[], reimplementationRoles[], reimplementationStrict,
//                    knownReimplementations[], componentSelectors, paths.themeCSS, paths.pluginCSS,
//                    plus the DS component universe (componentSelectors + composition/structure snapshots).
//
// Exit 0 = no local reimplementation found (or advisory-only / not configured).
// Exit 1 = a reimplementation found AND reimplementationStrict is set.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { loadLocator } from './component-locator.mjs';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

// ── Opt-in: no surfaces configured → no-op PASS ──────────────────────────────────
const SURFACE_GLOBS = (cfg.reimplementationSurfaces ?? []).flat().filter(Boolean);
if (!SURFACE_GLOBS.length) {
  console.log('✅ [reimplementation] no reimplementationSurfaces configured — skipped');
  process.exit(0);
}

const STRICT = cfg.reimplementationStrict === true;
const ROLES  = (cfg.reimplementationRoles ?? ['button']).map(r => String(r).toLowerCase());
const KNOWN  = new Set(cfg.knownReimplementations ?? []);
const norm   = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Resolve surface files (supports a trailing `*` glob on the basename) ─────────
function expandGlob(g) {
  if (!g.includes('*')) return existsSync(join(ROOT, g)) ? [g] : [];
  // Support "dir/*/file" and "dir/*.ext" — one wildcard segment, generic and dependency-free.
  const parts = g.split('/');
  let bases = [''];
  for (const part of parts) {
    if (!part.includes('*')) { bases = bases.map(b => (b ? b + '/' + part : part)); continue; }
    const re = new RegExp('^' + part.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const next = [];
    for (const b of bases) {
      const dir = join(ROOT, b);
      let entries = []; try { entries = readdirSync(dir); } catch { continue; }
      for (const e of entries) if (re.test(e)) next.push(b ? b + '/' + e : e);
    }
    bases = next;
  }
  return bases.filter(p => existsSync(join(ROOT, p)));
}
const SURFACES = [...new Set(SURFACE_GLOBS.flatMap(expandGlob))];

// ── DS component universe + the classes that realize each owned role ─────────────
const universe = new Set(Object.keys(cfg.componentSelectors ?? {}));
function addSnap(file, pick) {
  try { const s = JSON.parse(readFileSync(join(ROOT, file), 'utf8')); pick(s); } catch {}
}
addSnap('component-composition.snapshot.json', (s) => {
  for (const [k, v] of Object.entries(s)) { if (k.startsWith('_')) continue; universe.add(k); if (Array.isArray(v)) for (const n of v) universe.add(n); }
});
const SNAP_STRUCT = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';
addSnap(SNAP_STRUCT, (s) => { for (const k of Object.keys(s.components ?? {})) universe.add(k); });

const LOCATOR = await loadLocator(ROOT, cfg);   // the one shared component finder
const selOf = (name) => LOCATOR.classFor(name);
// A role -> set of normalized DS class tokens that realize it (buttonprimary, buttonsecondary, …),
// plus a generic role token (button). ownedRoles = the roles the DS actually defines a component for.
const roleClasses = {};   // role -> Set(normClassToken)
for (const role of ROLES) {
  const set = new Set();
  const roleRe = new RegExp(role, 'i');
  for (const name of universe) if (roleRe.test(name)) set.add(norm(selOf(name).replace(/^\./, '')));
  if (set.size) roleClasses[role] = set;
}
const ownedRoles = Object.keys(roleClasses);
if (!ownedRoles.length) {
  console.log(`✅ [reimplementation] the DS defines no component for role(s) [${ROLES.join(', ')}] — nothing to reimplement`);
  process.exit(0);
}

// ── Read a surface + gather CSS that could style it ──────────────────────────────
const readFile = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const VISUAL_RE = /(?:^|[;{])\s*(?:background|background-color|border|border-color|border-radius|padding|padding-top|padding-right|padding-bottom|padding-left)\s*:/i;

// class token -> concatenated declaration text, for "does this local class reconstruct a component?"
function collectClassDecls(css, map) {
  if (!css) return;
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) || [];
  for (const b of blocks) {
    const i = b.indexOf('{');
    const selector = b.slice(0, i);
    const decls = b.slice(i + 1, b.lastIndexOf('}'));
    for (const m of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      const k = norm(m[1]);
      map.set(k, (map.get(k) || '') + ';' + decls);
    }
  }
}

// ── Scan ────────────────────────────────────────────────────────────────────────
const THEME = [cfg.paths?.themeCSS ?? []].flat().filter(Boolean);
const PLUGIN = (cfg.paths?.pluginCSS ?? []).flat().filter(Boolean).filter(p => !/^https?:\/\//.test(p));

const findings = [];
for (const surface of SURFACES) {
  const raw = readFile(surface);
  if (!raw) continue;
  const doc = stripComments(raw);

  // CSS in scope for this surface: its own <style>/rules + the shared theme + plugin CSS.
  const classDecls = new Map();
  collectClassDecls(doc, classDecls);
  for (const p of [...THEME, ...PLUGIN]) collectClassDecls(stripComments(readFile(p)), classDecls);

  for (const role of ownedRoles) {
    const dsSet = roleClasses[role];
    // Element openers for this role. v1 covers <button> and role="button"; extendable per role.
    const openers = [];
    if (role === 'button') {
      for (const m of doc.matchAll(/<button\b[^>]*>/gi)) openers.push(m[0]);
      for (const m of doc.matchAll(/<[a-z][a-z0-9]*\b[^>]*\brole=["']button["'][^>]*>/gi)) openers.push(m[0]);
    } else {
      // Generic: an element whose tag equals the role name (e.g. <select>) or role="<role>".
      const tagRe = new RegExp(`<${role}\\b[^>]*>`, 'gi');
      for (const m of doc.matchAll(tagRe)) openers.push(m[0]);
      for (const m of doc.matchAll(new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\brole=["']${role}["'][^>]*>`, 'gi'))) openers.push(m[0]);
    }

    for (const tag of openers) {
      const classAttr = (tag.match(/\bclass=["']([^"']*)["']/i) || [])[1] || '';
      const styleAttr = (tag.match(/\bstyle=["']([^"']*)["']/i) || [])[1] || '';
      const classTokens = classAttr.split(/[\s:]+/).map(norm).filter(Boolean);   // split Vue :class noise too

      // Uses the DS component for this role? → not a reimplementation.
      if (classTokens.some(t => dsSet.has(t) || [...dsSet].some(d => d.length >= 4 && t.includes(d)))) continue;

      // Locally styled to reconstruct the component? inline style, or one of its classes carries
      // visual declarations (background/border/radius/padding) in the gathered CSS.
      const inlineVisual = VISUAL_RE.test(';' + styleAttr);
      const classVisual  = classTokens.some(t => VISUAL_RE.test(classDecls.get(t) || ''));
      if (!inlineVisual && !classVisual) continue;   // a bare/utility element — not a simulated component

      const label = classAttr ? `.${classAttr.trim().split(/\s+/)[0]}` : (styleAttr ? 'inline-styled' : role);
      const key = `${basename(surface)}#${label}`;
      if (KNOWN.has(key) || KNOWN.has(`${surface}#${label}`)) continue;
      findings.push({ surface, role, label });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
// Dedupe (surface, role, label): the same local class often appears many times.
const seen = new Set();
const unique = findings.filter(f => { const k = `${f.surface}|${f.role}|${f.label}`; if (seen.has(k)) return false; seen.add(k); return true; });

if (!unique.length) {
  console.log(`✅ [reimplementation] no local component reimplementation found (${SURFACES.length} surface${SURFACES.length > 1 ? 's' : ''}, role(s): ${ownedRoles.join(', ')})`);
  process.exit(0);
}

const tag = STRICT ? '❌' : '⚠️ ';
console.log(`${STRICT ? '❌' : '⚠️ '} [reimplementation] ${unique.length} possible local reimplementation${unique.length > 1 ? 's' : ''} — element styled like a DS component but not using it${STRICT ? '' : ' (advisory)'}:`);
const bySurface = {};
for (const f of unique) (bySurface[f.surface] ??= []).push(f);
for (const [surface, fs] of Object.entries(bySurface)) {
  console.log(`  ${surface}`);
  for (const f of fs) console.log(`    ${tag} <${f.role}> "${f.label}" — locally styled, not using the DS ${f.role} component`);
}
console.log(`  Fix: use the DS ${ownedRoles.join('/')} component/class instead of hand-styling it; or, if deliberate, add "${unique[0].surface.split('/').pop()}#${unique[0].label}" to ds-config.json → knownReimplementations.`);

process.exit(STRICT ? 1 : 0);
