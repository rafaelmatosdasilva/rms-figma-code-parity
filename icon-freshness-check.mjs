// icon-freshness-check.mjs — Gate [17]
//
// Verifies that figma-icons.snapshot.json is still accurate against live Figma.
// For each DS icon (those with a nodeId in the snapshot), fetches the exported SVG
// from the Figma REST API and compares the path data against the committed snapshot.
//
// When Figma changes an icon, this gate fails with a clear diff message so the dev
// knows to run Phase 1 (which re-exports the SVG and updates the snapshot + sprite).
//
// Requires:
//   FIGMA_TOKEN  — env var with a Figma personal access token (file_content:read scope)
//   ds-config.json  — figmaFileKey, paths.snapshotIcons
//
// Exit 0 = all icon paths match live Figma (or FIGMA_TOKEN missing → skipped).
// Exit 1 = at least one icon changed in Figma since the snapshot was committed.

import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';

const ROOT  = process.cwd();
const TOKEN = process.env.FIGMA_TOKEN;

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const FILE_KEY       = cfg.figmaFileKey;
const SNAP_ICONS_REL = cfg.paths?.snapshotIcons;

if (!TOKEN) {
  console.log('\n⏭  Gate [17] skipped — FIGMA_TOKEN not set (add to .env to enable icon freshness checks)\n');
  process.exit(0);
}
if (!FILE_KEY) {
  console.error('❌ figmaFileKey missing in ds-config.json'); process.exit(1);
}
if (!SNAP_ICONS_REL || !existsSync(join(ROOT, SNAP_ICONS_REL))) {
  console.log(`\n⏭  Gate [17] skipped — ${SNAP_ICONS_REL ?? 'paths.snapshotIcons'} not found\n`);
  process.exit(0);
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
let iconSnap = {};
try { iconSnap = JSON.parse(readFileSync(join(ROOT, SNAP_ICONS_REL), 'utf8')); } catch (e) {
  console.error(`❌ Could not parse ${SNAP_ICONS_REL}: ${e.message}`); process.exit(1);
}

// Collect DS icons that have a nodeId (skip PLUGIN-SPECIFIC icons — no Figma node to check)
const dsIcons = Object.entries(iconSnap).filter(([, entry]) => entry?.nodeId);
if (!dsIcons.length) {
  console.log('\n⏭  Gate [17] skipped — no DS icons with nodeIds in snapshot\n');
  process.exit(0);
}

// ── Figma REST API: export SVGs ───────────────────────────────────────────────
// Batch nodeIds into groups of 20 (safe Figma API limit for image exports).
const BATCH_SIZE = 20;
const batches    = [];
for (let i = 0; i < dsIcons.length; i += BATCH_SIZE) {
  batches.push(dsIcons.slice(i, i + BATCH_SIZE));
}

function normalizePath(d) {
  // Normalize whitespace between SVG path tokens for robust comparison.
  return d.replace(/\s+/g, ' ').trim();
}

// Figma re-renders SVG exports on demand and the coordinates it emits vary in the
// last decimal places between renders of an unchanged component (2.15065 vs 2.15072).
// Exact string comparison therefore reports "changed in Figma" for noise, which trains
// people to ignore this gate. Compare the command sequence exactly and the numbers
// within a tolerance far below one device pixel.
const PATH_TOLERANCE = cfg.iconCheck?.pathTolerance ?? 0.01;

function pathTokens(d) {
  return normalizePath(d).match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
}

function pathsEquivalent(a, b, tol = PATH_TOLERANCE) {
  const ta = pathTokens(a), tb = pathTokens(b);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    const na = parseFloat(ta[i]), nb = parseFloat(tb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if (ta[i] !== tb[i]) return false;          // command letters must match exactly
    } else if (Math.abs(na - nb) > tol) {
      return false;
    }
  }
  return true;
}

function pathListsEquivalent(liveArr, snapArr) {
  if (liveArr.length !== snapArr.length) return false;
  const remaining = [...snapArr];
  for (const lp of liveArr) {
    const hit = remaining.findIndex(sp => pathsEquivalent(lp, sp));
    if (hit === -1) return false;
    remaining.splice(hit, 1);
  }
  return true;
}

function extractPathDs(svgText) {
  const re = /\bd="([^"]+)"/g;
  const ds = [];
  let m;
  while ((m = re.exec(svgText)) !== null) ds.push(normalizePath(m[1]));
  return ds;
}

// Build nodeId → iconId lookup (Figma response keys use ':' format)
const nodeIdToIconId = {};
for (const [iconId, entry] of dsIcons) {
  nodeIdToIconId[entry.nodeId] = iconId;
}

console.log(`\n─── Gate [17] — Icon snapshot freshness (${dsIcons.length} DS icons) ─────────────\n`);

const changed = [];
const checked = [];

// ── Icon RENAME check ─────────────────────────────────────────────────────────
// Code references DS icons by their EXACT Figma name (`#icon-download` ↔ recorded name
// 'Icon-download'; HARD RULE: icon ids = exact Figma names). If the DS renames the node
// (same nodeId, new name — e.g. Icon-download → Icon-export), the code's id is stale and the
// SVG-path check alone can miss it (a rename need not change the geometry). Fetch each icon
// node's LIVE name via /nodes and flag any drift from the snapshot's recorded name.
const renamed = [];
{
  const allIds = dsIcons.map(([, e]) => e.nodeId).filter(Boolean);
  const liveNames = {};
  for (let i = 0; i < allIds.length; i += 50) {
    const slice = allIds.slice(i, i + 50);
    const url = `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(slice.join(','))}&depth=1`;
    try {
      const r = await fetch(url, { headers: { 'X-Figma-Token': TOKEN } });
      if (!r.ok) { console.log(`   ⚠️  icon rename check skipped for a batch — /nodes ${r.status}`); continue; }
      const json = await r.json();
      for (const id of slice) { const doc = json.nodes?.[id]?.document; if (doc?.name) liveNames[id] = doc.name; }
    } catch (e) { console.log(`   ⚠️  icon rename check network error: ${e.message}`); }
  }
  for (const [iconId, entry] of dsIcons) {
    const live = liveNames[entry.nodeId];
    if (!live || !entry.name) continue;
    // A live name like "size=small" is a VARIANT PROPERTY, not an icon name — it means the
    // nodeId now resolves into a component-set variant (the icon gained size variants); the
    // icon's real name (the set) is unchanged, so this is a nodeId restructure, not a rename.
    // Skip it here (the SVG-path check still exports the variant fine).
    if (/^[\w-]+=/.test(live)) continue;
    // Compare case-INSENSITIVELY: icon ids are case-normalised ('Icon-Fit' and 'Icon-fit'
    // both derive to #icon-fit), so a pure case change is not a real id drift. Only a name
    // change that would produce a DIFFERENT id (Icon-download → Icon-export) is flagged.
    if (live.toLowerCase() !== entry.name.toLowerCase()) {
      renamed.push({ iconId, nodeId: entry.nodeId, was: entry.name, now: live });
    }
  }
}

for (const batch of batches) {
  // Figma API accepts node IDs with either ':' or '-' as separator
  const idsParam = encodeURIComponent(batch.map(([, e]) => e.nodeId).join(','));
  const apiUrl   = `https://api.figma.com/v1/images/${FILE_KEY}?ids=${idsParam}&format=svg&svg_outline_text=true&use_absolute_bounds=false`;

  let imageUrls;
  try {
    const resp = await fetch(apiUrl, { headers: { 'X-Figma-Token': TOKEN } });
    if (resp.status === 403) {
      console.log('⏭  Gate [17] skipped — FIGMA_TOKEN lacks file_content:read scope (403)');
      process.exit(0);
    }
    if (!resp.ok) {
      const text = await resp.text();
      console.log(`⏭  Gate [17] skipped — Figma images API ${resp.status}: ${text.slice(0, 120)}`);
      process.exit(0);
    }
    const json = await resp.json();
    imageUrls  = json.images ?? {};
  } catch (e) {
    console.log(`⏭  Gate [17] skipped — network error fetching image URLs: ${e.message}`);
    process.exit(0);
  }

  // Fetch each SVG and compare paths
  for (const [iconId, entry] of batch) {
    const svgUrl = imageUrls[entry.nodeId];
    if (!svgUrl) {
      console.log(`   ⚠️  No SVG URL returned for ${iconId} (${entry.nodeId}) — skipped`);
      continue;
    }

    let svgText;
    try {
      const r = await fetch(svgUrl);
      if (!r.ok) { console.log(`   ⚠️  Could not fetch SVG for ${iconId}: ${r.status}`); continue; }
      svgText = await r.text();
    } catch (e) {
      console.log(`   ⚠️  Network error fetching SVG for ${iconId}: ${e.message}`); continue;
    }

    const livePaths = extractPathDs(svgText);
    const snapPaths = (entry.paths ?? []).map(normalizePath);

    // Compare order-independently, tolerating Figma's render-to-render float noise
    const match = pathListsEquivalent(livePaths, snapPaths);

    if (match) {
      checked.push(iconId);
    } else {
      changed.push({ iconId, nodeId: entry.nodeId, livePaths, snapPaths });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (checked.length) {
  console.log(`✅ MATCH  ${checked.length}/${dsIcons.length} icon paths match live Figma`);
  for (const id of checked) console.log(`   ✅  #${id}`);
  console.log();
}

if (renamed.length) {
  console.log(`❌ RENAMED  ${renamed.length} icon(s) renamed in Figma (code references icons by exact name)`);
  for (const r of renamed) {
    console.log(`\n   ❌  #${r.iconId} (nodeId ${r.nodeId}): "${r.was}" → "${r.now}" in Figma`);
    console.log(`      Rename the CSS/sprite id and the snapshot+contract dsName to match the new`);
    console.log(`      Figma name (HARD RULE: icon ids = exact Figma names). e.g. #${r.iconId} → #${r.now.toLowerCase()}`);
  }
  console.log('');
}

if (!changed.length && !renamed.length) {
  console.log('All DS icon snapshots are fresh (paths + names). ✓\n');
  process.exit(0);
}
if (!changed.length) process.exit(1);   // rename-only failure — report already printed above

console.log(`❌ CHANGED  ${changed.length} icon(s) differ from live Figma`);
for (const { iconId, nodeId, livePaths, snapPaths } of changed) {
  console.log(`\n   ❌  #${iconId} (nodeId ${nodeId}): path data changed in Figma`);
  const snapFirst = snapPaths[0] ? snapPaths[0].slice(0, 80) + '…' : '(none)';
  const liveFirst = livePaths[0] ? livePaths[0].slice(0, 80) + '…' : '(none)';
  console.log(`      Snapshot: ${snapFirst}`);
  console.log(`      Figma:    ${liveFirst}`);
  if (livePaths.length !== snapPaths.length) {
    console.log(`      Path count: snapshot=${snapPaths.length}  figma=${livePaths.length}`);
  }
}
console.log('\n   Fix: update figma-icons.snapshot.json with new Figma path data,');
console.log('        then update the matching <symbol> in ui-shared.js (or equivalent sprite).');
console.log('        Run /rms-figma-code-parity (Phase 1) to do this automatically.\n');
process.exit(1);
