// icon-inventory-check.mjs - part of Gate 15 (Icons).
// Run from project root: node scripts/icon-inventory-check.mjs
//
// The other icon checks verify the icons the CODE declares. This closes the loop the
// other way: every icon the DS defines in FIGMA must have a code symbol. The DS icon
// set often lives in a SEPARATE Figma library file, so the inventory is captured from
// that library (REST /components on its file key with a token, OR the plugin) into
// figma-icons.snapshot.json: { "icons": ["arrow-left", "check", ...] }.
//
// Inert until that snapshot exists, so it never false-positives before capture.
//
// Exit 0 = every Figma icon has a code symbol (or nothing to check).
// Exit 1 = a Figma icon has no code symbol (an unimplemented DS icon).

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const SNAP = 'figma-icons.snapshot.json';
if (!existsSync(join(ROOT, SNAP))) {
  console.log('⏭  icon inventory: no figma-icons.snapshot.json - skipped (capture it to enable)');
  process.exit(0);
}
let icons = [];
try { icons = JSON.parse(readFileSync(join(ROOT, SNAP), 'utf8')).icons ?? []; } catch { /* malformed */ }
if (!Array.isArray(icons) || !icons.length) {
  console.log('⏭  icon inventory: figma-icons.snapshot.json has no icons - skipped');
  process.exit(0);
}

const PREFIX = cfg.iconSpritePrefix ?? 'icon-';
const EXEMPT = new Set((cfg.knownUnimplementedIcons ?? []).map(s => norm(s)));
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// ── Collect the icon names the CODE defines (sprite symbols + #icon-... references) ──
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs']);
const EXT = new Set(['.vue', '.tsx', '.jsx', '.ts', '.js', '.html', '.svg', '.svelte', '.css']);
function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (EXT.has(extname(e.name))) out.push(p);
  }
}
const files = [];
walk(ROOT, files);
const codeIcons = new Set();
const pfx = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const symRe  = new RegExp(`<symbol[^>]*\\bid\\s*=\\s*['"\`]${pfx}([\\w-]+)['"\`]`, 'gi');
const hrefRe = new RegExp(`href\\s*=\\s*['"\`]?#${pfx}([\\w-]+)`, 'gi');
const idRe   = new RegExp(`['"\`]#?${pfx}([\\w-]+)['"\`]`, 'gi');
for (const f of files) {
  let t = ''; try { t = readFileSync(f, 'utf8'); } catch { continue; }
  for (const re of [symRe, hrefRe, idRe]) { re.lastIndex = 0; let m; while ((m = re.exec(t))) codeIcons.add(norm(m[1])); }
}

// ── Compare ─────────────────────────────────────────────────────────────────
const OK = [], MISSING = [];
for (const name of icons) {
  const n = norm(name);
  if (!n || EXEMPT.has(n)) continue;
  if (codeIcons.has(n)) OK.push(name);
  else MISSING.push(`Figma icon "${name}" has no code symbol (${PREFIX}${name}) - the DS icon is not implemented`);
}

console.log(`\n✅ IN CODE   ${OK.length}`);
console.log(`❌ MISSING   ${MISSING.length}   (Figma icon with no code symbol)`);
if (MISSING.length) { console.log('\n─── Figma icons missing from the code sprite ──'); for (const l of MISSING.slice(0, 40)) console.log(`  ❌ ${l}`); }
else console.log('   Every Figma icon has a code symbol. ✓');

process.exit(MISSING.length ? 1 : 0);
