// icon-check.mjs — Run from project root: node ../rms-figma-code-parity/icon-check.mjs
//
// Hard Rule #15 — SVG symbol audit:
//   Every <symbol> defined in any plugin HTML file must be declared in ICON_SYMBOLS
//   in structure-contract.mjs with either:
//     DS ICON         — sourced from the Figma DS; must record the Figma node ID
//     PLUGIN-SPECIFIC — custom icon with no DS backing; must describe visual purpose
//
//   ICON_SYMBOLS values can be a string OR an object:
//     String:  'DS ICON — ...' | 'PLUGIN-SPECIFIC — ...'
//     Object:  { desc: 'DS ICON — ...', transform?: 'rotate(-45)' }
//              transform — if set, symbol must contain <g transform="..."> matching value
//
//   Every DS entry's sprite id must derive from its DS component's own name
//   ("Icon/Fit" → #icon-fit). Name authority is the Figma snapshot, then a declared
//   dsName, then the name parsed out of desc. A deliberate difference must be
//   declared with idDiffersFromDsName: '<reason>'. This catches the rename class of
//   miss: an icon renamed in Figma, or an entry pointing at the wrong component,
//   both of which leave the contract documenting one icon while the code ships
//   another — invisible to path checks, which only compare against the node the
//   (possibly wrong) entry names.
//
//   The viewBox attribute on <symbol> is the icon's container — it is verified against
//   the Figma snapshot automatically. Render size (<svg width height>) is a design
//   decision and is not policed; the viewBox + path data checks ensure the correct
//   icon is used at whatever size the design calls for.
//
//   Why: hand-drawn paths, missing transforms, and wrong render sizes all produce
//   visually wrong icons that no color/token check would catch.
//
// Requires at project root:
//   ds-config.json         — paths.pluginCSS (HTML files to scan for <symbol> elements)
//   structure-contract.mjs — ICON_SYMBOLS export
//
// Exit 0 = all symbols documented, transforms and sizes verified. Exit 1 = failures found.

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const PLUGIN_SOURCES = (cfg.paths?.pluginCSS ?? [])
  .filter(f => existsSync(join(ROOT, f)) && f.endsWith('.html'));
const SHARED_SOURCES = (cfg.paths?.sharedIconSources ?? [])
  .filter(f => existsSync(join(ROOT, f)));

const HTML_SOURCES = [...PLUGIN_SOURCES, ...SHARED_SOURCES];

// Configuring sharedIconSources declares the intent to keep one icon sheet. Once that
// exists, a symbol defined inside an individual plugin is a fork waiting to happen: it
// sits outside the shared sheet, drifts from the DS copy of the same icon, and every
// other plugin silently keeps the old artwork. Exempt specific ids only deliberately.
const CENTRALIZED       = SHARED_SOURCES.length > 0 && cfg.iconCheck?.allowPerPluginSymbols !== true;
const PER_PLUGIN_EXEMPT = new Set(cfg.iconCheck?.perPluginSymbolExemptions ?? []);

// ── Load ICON_SYMBOLS from structure-contract.mjs ─────────────────────────────
let ALLOWED = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.ICON_SYMBOLS && typeof m.ICON_SYMBOLS === 'object') ALLOWED = m.ICON_SYMBOLS;
} catch { /* optional export */ }

function entryDesc(val)        { return typeof val === 'string' ? val : val.desc; }
function entryTransform(val)   { return typeof val === 'string' ? null  : (val.transform   ?? null); }
function entryStrokeNone(val)  { return typeof val === 'string' ? false : (val.strokeNone  ?? false); }
function entryStrokeBased(val) { return typeof val === 'string' ? false : (val.strokeBased ?? false); }
function entryNodeId(val)      { return typeof val === 'string' ? null  : (val.nodeId      ?? null); }
function entryDsName(val)      { return typeof val === 'string' ? null  : (val.dsName      ?? null); }
function entryIdWaiver(val)    { return typeof val === 'string' ? null  : (val.idDiffersFromDsName ?? null); }
function isDsEntry(val)        { return /^DS ICON\b/.test(entryDesc(val) ?? ''); }

// ── DS component name → expected sprite id ───────────────────────────────────
// The sprite id must be derivable from the DS component's own name, so a renamed
// or mis-sourced icon cannot hide behind a stale contract key. Purely mechanical:
//   "Icon/Fit"                  → icon-fit
//   "Icon/arrowRight"           → icon-arrow-right
//   "Icon/check size=small"     → icon-check      (variant assignments dropped)
//   "Icon/object/component"     → icon-component  (last path segment wins)
const SPRITE_PREFIX = cfg.iconCheck?.spriteIdPrefix ?? 'icon-';

function kebab(seg) {
  return String(seg)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')          // camelCase → kebab
    .replace(/[\s_]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}

// A namespaced DS name has more than one faithful derivation, and which one is right
// is a judgement the DS can't make for us: "Icon/var/color" could reasonably be
// #icon-color or #icon-var-color, and dropping "var" loses real meaning. So accept any
// suffix of the path — every candidate is genuinely derived from the DS name, and
// demanding one exact form would force waivers onto correct, well-named icons.
function spriteIdCandidates(name) {
  let s = String(name ?? '').trim();
  if (!s) return [];
  s = s.replace(/\b[\w-]+=[\w-]+\b/g, ' ');          // drop variant assignments (size=small)

  let segs = s.split('/').map(w => kebab(w)).filter(Boolean);
  // A leading segment equal to the prefix root ("Icon" for "icon-") is the namespace
  // marker, not part of the name — otherwise every id would start icon-icon-.
  const root = SPRITE_PREFIX.replace(/-+$/, '');
  if (segs.length > 1 && segs[0] === root) segs = segs.slice(1);
  if (!segs.length) return [];

  const out = [];
  for (let i = segs.length - 1; i >= 0; i--) out.push(SPRITE_PREFIX + segs.slice(i).join('-'));
  return out;                                        // shortest (most canonical) first
}

function spriteIdFromDsName(name) { return spriteIdCandidates(name)[0] ?? null; }

// Pull the DS component name out of a "DS ICON — <name> node <id>; ..." description.
function dsNameFromDesc(desc) {
  const m = /^DS ICON\s*[—–-]\s*(.+?)\s+node\s+[\d:\-]+/.exec(desc ?? '');
  return m ? m[1].trim() : null;
}

function normalizeNodeId(id) { return String(id ?? '').replace(/[:\-]/g, ''); }

function nodeIdFromDesc(desc) {
  const m = /\bnode\s+([\d]+[:\-][\d]+)/.exec(desc ?? '');
  return m ? m[1] : null;
}

// ── Extract <symbol id="...">...</symbol> blocks from HTML files ──────────────
// Captures the full symbol body so we can check for transform attributes.
const SYMBOL_BLOCK_RE = /<symbol\s([^>]*)>([\s\S]*?)<\/symbol>/g;
const ID_RE           = /\bid="([^"]+)"/;

// ── Load figma-icons.snapshot.json (path comparison ground truth) ─────────────
let iconSnap = {};
const snapIconsPath = cfg.paths?.snapshotIcons;
if (snapIconsPath && existsSync(join(ROOT, snapIconsPath))) {
  try { iconSnap = JSON.parse(readFileSync(join(ROOT, snapIconsPath), 'utf8')); } catch {}
}

function extractPathDs(body) {
  const re = /\bd="([^"]+)"/g;
  const ds = [];
  let m;
  while ((m = re.exec(body)) !== null) ds.push(m[1]);
  return ds;
}

const documented       = [];
const undocumented     = [];
const transformFails   = [];
const strokeFails      = [];
const strokeBasedFails = [];
const pathFails        = [];
const viewBoxFails     = [];
const dsNameFails      = [];
const dsNameUnknown    = [];
const staleNameFails   = [];
const staleWaivers     = [];
const nodeIdFails      = [];
const decentralized    = [];
const seenIds          = new Set();

for (const srcPath of HTML_SOURCES) {
  const text = readFileSync(join(ROOT, srcPath), 'utf8');
  let m;
  SYMBOL_BLOCK_RE.lastIndex = 0;
  while ((m = SYMBOL_BLOCK_RE.exec(text)) !== null) {
    const attrs = m[1], body = m[2];
    const idMatch = ID_RE.exec(attrs);
    if (!idMatch) continue;
    const id  = idMatch[1];
    const val = ALLOWED[id];
    seenIds.add(id);

    if (CENTRALIZED && PLUGIN_SOURCES.includes(srcPath) && !PER_PLUGIN_EXEMPT.has(id)) {
      const alsoShared = SHARED_SOURCES.some(s =>
        new RegExp(`<symbol\\s[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)
          .test(readFileSync(join(ROOT, s), 'utf8')));
      decentralized.push({ id, file: srcPath, duplicate: alsoShared });
    }

    if (!val) {
      undocumented.push({ id, file: srcPath });
      continue;
    }

    const desc            = entryDesc(val);
    const reqTransform    = entryTransform(val);
    const reqStrokeNone   = entryStrokeNone(val);
    const reqStrokeBased  = entryStrokeBased(val);

    if (reqStrokeBased) {
      // Verify the <symbol> tag itself has fill="none" — ensures stroke-based rendering.
      // Catches a fill-based SVG replacing a stroke DS icon without any size/color gate failing.
      const hasFillNone = /\bfill="none"/.test(attrs) || /\bfill='none'/.test(attrs);
      if (!hasFillNone) {
        strokeBasedFails.push({ id, file: srcPath, desc });
        continue;
      }
    }

    if (reqTransform) {
      const hasTransform = body.includes(`transform="${reqTransform}"`) ||
                           body.includes(`transform='${reqTransform}'`);
      if (!hasTransform) {
        transformFails.push({ id, reqTransform, file: srcPath, desc });
        continue;
      }
    }

    if (reqStrokeNone) {
      // Verify the symbol body contains stroke="none" on a path/shape element.
      // This prevents CSS-inherited stroke (e.g. .buttonTertiary svg { stroke: ... })
      // from making fill-only icons appear thicker in button contexts than elsewhere.
      const hasStrokeNone = /stroke="none"/.test(body) || /stroke='none'/.test(body);
      if (!hasStrokeNone) {
        strokeFails.push({ id, file: srcPath, desc });
        continue;
      }
    }

    // ── DS component name must match the sprite id ──────────────────────────
    // A sprite id that no longer derives from its DS component's name means the
    // icon was renamed in Figma, or the entry points at the wrong component. Both
    // leave the contract describing one icon while the code ships another.
    // Name authority: Figma snapshot > declared dsName > parsed from desc.
    if (isDsEntry(val)) {
      const snapName  = iconSnap[id]?.name ?? null;
      const declared  = entryDsName(val);
      const descName  = dsNameFromDesc(entryDesc(val));
      const dsName    = snapName ?? declared ?? descName;
      const waiver    = entryIdWaiver(val);

      // A declared name that contradicts live Figma is stale documentation.
      if (snapName && declared && snapName !== declared) {
        staleNameFails.push({ id, file: srcPath, snapName, declared });
      }

      if (!dsName) {
        dsNameUnknown.push({ id, file: srcPath, desc: entryDesc(val) });
      } else {
        const candidates = spriteIdCandidates(dsName);
        const derives    = candidates.includes(id);
        if (candidates.length && !derives && !waiver) {
          dsNameFails.push({ id, file: srcPath, dsName, expected: candidates.join('" or "#'),
                             source: snapName ? 'figma snapshot' : declared ? 'dsName' : 'desc' });
        } else if (derives && waiver) {
          staleWaivers.push({ id, file: srcPath, dsName, waiver });
        }
      }

      // The node id quoted in the prose must match the machine-readable field.
      const fieldNode = entryNodeId(val);
      const descNode  = nodeIdFromDesc(entryDesc(val));
      if (fieldNode && descNode && normalizeNodeId(fieldNode) !== normalizeNodeId(descNode)) {
        nodeIdFails.push({ id, file: srcPath, fieldNode, descNode });
      }
    }

    // ── Path comparison against Figma snapshot ──────────────────────────────
    const snapEntry = iconSnap[id];
    if (snapEntry) {
      // Verify viewBox matches Figma export — skip for transformed icons (rotation adjusts bounding box)
      if (!reqTransform) {
        const viewBoxMatch = /\bviewBox="([^"]+)"/.exec(attrs);
        const codeViewBox  = viewBoxMatch ? viewBoxMatch[1] : null;
        if (codeViewBox && codeViewBox !== snapEntry.viewBox) {
          viewBoxFails.push({ id, file: srcPath, expected: snapEntry.viewBox, actual: codeViewBox });
        }
      }
      // Verify path d values match Figma export exactly
      const codePaths = extractPathDs(body);
      const snapPaths = snapEntry.paths ?? [];
      if (JSON.stringify([...codePaths].sort()) !== JSON.stringify([...snapPaths].sort())) {
        pathFails.push({ id, file: srcPath,
          expectedCount: snapPaths.length, actualCount: codePaths.length,
          expected: snapPaths[0] ? snapPaths[0].slice(0, 60) + '…' : '(none)',
          actual:   codePaths[0] ? codePaths[0].slice(0, 60) + '…' : '(none — non-path elements used)',
        });
      }
    }

    documented.push({ id, desc, file: srcPath });
  }
}


// ── Orphaned DS contract entries ─────────────────────────────────────────────
// A DS entry whose key matches no <symbol> anywhere is debris — usually the old
// half of a rename. Left in place it keeps "documenting" an icon that no longer
// ships, while the renamed sprite reads as undocumented.
const orphaned = Object.entries(ALLOWED)
  .filter(([id, val]) => isDsEntry(val) && !seenIds.has(id))
  .map(([id, val]) => ({ id, desc: entryDesc(val) }));

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n─── SVG symbol audit (Hard Rule #15) ───────────────────────────────\n');

if (documented.length) {
  console.log(`✅ DOCUMENTED  ${documented.length}  (SVG symbols declared and verified in contract)`);
  for (const r of documented) {
    const tag = r.desc.startsWith('DS ICON') ? '✅ DS    ' : '✅ PLUGIN';
    console.log(`   ${tag}  #${r.id}`);
    console.log(`            ${r.desc}`);
  }
  console.log();
}

const allFails = [
  ...undocumented.map(r => ({ ...r, kind: 'undocumented' })),
  ...strokeBasedFails.map(r => ({ ...r, kind: 'strokeBased' })),
  ...transformFails.map(r => ({ ...r, kind: 'transform' })),
  ...strokeFails.map(r => ({ ...r, kind: 'stroke' })),
  ...viewBoxFails.map(r => ({ ...r, kind: 'viewBox' })),
  ...pathFails.map(r => ({ ...r, kind: 'path' })),
  ...dsNameFails.map(r => ({ ...r, kind: 'dsName' })),
  ...dsNameUnknown.map(r => ({ ...r, kind: 'dsNameUnknown' })),
  ...staleNameFails.map(r => ({ ...r, kind: 'staleName' })),
  ...staleWaivers.map(r => ({ ...r, kind: 'staleWaiver' })),
  ...nodeIdFails.map(r => ({ ...r, kind: 'nodeId' })),
  ...orphaned.map(r => ({ ...r, kind: 'orphaned' })),
  ...decentralized.map(r => ({ ...r, kind: 'decentralized' })),
];

if (allFails.length === 0) {
  console.log('✅ No undocumented or misconfigured SVG symbols.\n');
  process.exit(0);
}

if (undocumented.length) {
  console.log(`❌ UNDOCUMENTED  ${undocumented.length}  (SVG symbols with no contract entry)\n`);
  for (const r of undocumented) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      → DS icon? Fetch from Figma (get_design_context), add as DS ICON with nodeId.`);
    console.log(`        Also check: does the Figma component apply a rotation wrapper? If so, add transform field.`);
    console.log(`        Custom icon? Add as PLUGIN-SPECIFIC with a description.\n`);
  }
}

if (transformFails.length) {
  console.log(`❌ MISSING TRANSFORM  ${transformFails.length}  (DS icons require a <g transform> that is absent)\n`);
  for (const r of transformFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires: <g transform="${r.reqTransform}">`);
    console.log(`      → Figma component applies this rotation to orient the path correctly.`);
    console.log(`        Wrap the <path> in: <g transform="${r.reqTransform}">...</g>\n`);
  }
}


if (strokeBasedFails.length) {
  console.log(`❌ NOT STROKE-BASED  ${strokeBasedFails.length}  (DS stroke icons must have fill="none" on <symbol> tag)\n`);
  for (const r of strokeBasedFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires strokeBased: true — <symbol> tag must have fill="none" attribute.`);
    console.log(`      → The DS icon uses stroke rendering (not fill). A fill-based replacement would have`);
    console.log(`        wrong visual weight. Add fill="none" to the <symbol ...> opening tag.\n`);
  }
}

if (strokeFails.length) {
  console.log(`❌ MISSING STROKE=NONE  ${strokeFails.length}  (fill-only DS icons missing stroke="none" guard)\n`);
  for (const r of strokeFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires strokeNone: true — no stroke="none" found on any element inside the symbol.`);
    console.log(`      → Broad CSS rules (e.g. .buttonTertiary svg { stroke: ... }) will inherit stroke into fill-only`);
    console.log(`        paths, making the icon appear thicker in button contexts than in other contexts.`);
    console.log(`        Add stroke="none" to the <path> inside the symbol to prevent inherited stroke.\n`);
  }
}

if (viewBoxFails.length) {
  console.log(`❌ WRONG VIEWBOX  ${viewBoxFails.length}  (DS icons with wrong viewBox — coordinate space mismatch)\n`);
  for (const r of viewBoxFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Figma export: viewBox="${r.expected}"  —  code has: viewBox="${r.actual}"`);
    console.log(`      → The symbol viewBox must match the Figma node dimensions exactly.`);
    console.log(`        Update the <symbol viewBox="..."> attribute.\n`);
  }
}

if (dsNameFails.length) {
  console.log(`❌ SPRITE ID ≠ DS NAME  ${dsNameFails.length}  (sprite id does not derive from its DS component name)\n`);
  for (const r of dsNameFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      DS component (${r.source}): "${r.dsName}"  →  expected sprite id "#${r.expected}"`);
    console.log(`      → The id and the DS component have drifted apart. Either:`);
    console.log(`        • rename the sprite to "#${r.expected}" (and every <use href="#${r.id}">), or`);
    console.log(`        • point the entry at the DS component this sprite really is, or`);
    console.log(`        • if the difference is deliberate, declare it:`);
    console.log(`          idDiffersFromDsName: '<why this id intentionally differs>'\n`);
  }
}

if (dsNameUnknown.length) {
  console.log(`❌ DS NAME UNKNOWN  ${dsNameUnknown.length}  (DS entry with no resolvable component name)\n`);
  for (const r of dsNameUnknown) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      desc: ${r.desc}`);
    console.log(`      → The name could not be read from the snapshot or parsed from the description,`);
    console.log(`        so the sprite id is verified against nothing. Add the component's exact`);
    console.log(`        Figma name: dsName: 'Icon/Example'\n`);
  }
}

if (staleNameFails.length) {
  console.log(`❌ STALE DS NAME  ${staleNameFails.length}  (declared dsName contradicts live Figma)\n`);
  for (const r of staleNameFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Figma snapshot: "${r.snapName}"  —  contract declares: "${r.declared}"`);
    console.log(`      → The component was renamed in Figma. Update dsName to match, and check`);
    console.log(`        whether the sprite id should follow the rename too.\n`);
  }
}

if (staleWaivers.length) {
  console.log(`❌ STALE WAIVER  ${staleWaivers.length}  (idDiffersFromDsName declared, but the id matches)\n`);
  for (const r of staleWaivers) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      DS name "${r.dsName}" derives to "#${r.id}" — the waiver is no longer needed.`);
    console.log(`      Reason on file: ${r.waiver}`);
    console.log(`      → Remove idDiffersFromDsName so a future real divergence still fails.\n`);
  }
}

if (nodeIdFails.length) {
  console.log(`❌ NODE ID MISMATCH  ${nodeIdFails.length}  (desc quotes a different node than the nodeId field)\n`);
  for (const r of nodeIdFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      nodeId field: ${r.fieldNode}  —  desc says: ${r.descNode}`);
    console.log(`      → One of the two was copy-pasted from another icon. Verify against Figma`);
    console.log(`        and make both agree.\n`);
  }
}

if (decentralized.length) {
  console.log(`❌ PER-PLUGIN SYMBOL  ${decentralized.length}  (icon defined outside the shared sprite sheet)\n`);
  for (const r of decentralized) {
    console.log(`   ❌ "#${r.id}"  defined in ${r.file}`);
    if (r.duplicate) {
      console.log(`      A symbol with this id ALSO exists in the shared sheet — the two will drift,`);
      console.log(`      and which one wins depends on document order. Delete the plugin-local copy.`);
    } else {
      console.log(`      → Move the <symbol> into: ${SHARED_SOURCES.join(', ')}`);
      console.log(`        Icons defined per plugin can't be reused, and a DS update fixes only one copy.`);
    }
    console.log(`      (Deliberate exception? add the id to iconCheck.perPluginSymbolExemptions,`);
    console.log(`       or set iconCheck.allowPerPluginSymbols: true to opt out entirely.)\n`);
  }
}

if (orphaned.length) {
  console.log(`❌ ORPHANED DS ENTRY  ${orphaned.length}  (contract entry with no matching <symbol>)\n`);
  for (const r of orphaned) {
    console.log(`   ❌ "#${r.id}"  declared but never defined`);
    console.log(`      ${r.desc}`);
    console.log(`      → Usually the old half of a rename. Delete the entry, or restore the symbol`);
    console.log(`        if it was dropped by mistake.\n`);
  }
}

if (pathFails.length) {
  console.log(`❌ WRONG PATH DATA  ${pathFails.length}  (DS icon paths diverge from Figma export)\n`);
  for (const r of pathFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Figma has ${r.expectedCount} path(s). Code has ${r.actualCount} path(s).`);
    console.log(`      Expected (first 60 chars): ${r.expected}`);
    console.log(`      Actual   (first 60 chars): ${r.actual}`);
    console.log(`      → DS icons must use the exact SVG exported from Figma via exportAsync({ format: 'SVG' }).`);
    console.log(`        Never hand-draw stroke paths (<circle>, <line>, <polyline>) for DS fill icons.`);
    console.log(`        Run the icon export step in Phase 1 and copy the exact <path d="..."> value.\n`);
  }
}

process.exit(1);
