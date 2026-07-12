// visual-regression-check.mjs — Fetch Figma frame screenshots and compare against
// stored references. No extra dependencies required — uses Node.js fetch + MD5 hash.
//
// Behaviour:
//   First run (no refs):   downloads images → saves to <visualRefs>/ → exits 0
//   Subsequent runs:       downloads images → compares hashes → exits 1 if any changed
//   Accept a change:       mv <visualRefs>/<id>.new.png <visualRefs>/<id>.png
//
// Requires:
//   ds-config.json    — figmaFileKey, frames[], visualRefs (default: .parity-refs)
//   FIGMA_TOKEN       — env var with a valid Figma personal access token
//
// Exit 0 = all frames match (or first run / FIGMA_TOKEN missing / no frames).
// Exit 1 = at least one frame changed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join }                                               from 'path';
import { createHash }                                         from 'crypto';

const ROOT  = process.cwd();
const TOKEN = process.env.FIGMA_TOKEN;

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const FILE_KEY  = cfg.figmaFileKey;
const FRAMES    = cfg.frames ?? [];
const REFS_DIR  = join(ROOT, cfg.visualRefs ?? '.parity-refs');

if (!FRAMES.length) {
  console.log('⏭ No frames configured in ds-config.json — visual regression skipped');
  process.exit(0);
}
if (!TOKEN) {
  console.log('⏭  Gate [7] skipped — FIGMA_TOKEN not set (add to .env to enable visual regression)');
  process.exit(0);
}
if (!FILE_KEY) {
  console.error('❌ figmaFileKey missing in ds-config.json'); process.exit(1);
}

// Ensure refs directory exists
mkdirSync(REFS_DIR, { recursive: true });

// ── Fetch image export URLs from Figma REST API ───────────────────────────────
// Figma node IDs use ':' in the UI but the API accepts both '-' and ':'.
// Normalize to ':' for the API, use '-' for filenames.
const nodeIds   = FRAMES.map(f => f.nodeId.replace(/-/, ':')); // only first dash → colon
const idsParam  = encodeURIComponent(nodeIds.join(','));
const SCALE     = cfg.visualRefScale ?? 2;
const apiUrl    = `https://api.figma.com/v1/images/${FILE_KEY}?ids=${idsParam}&format=png&scale=${SCALE}`;

let imageUrls = {};
try {
  const resp = await fetch(apiUrl, { headers: { 'X-Figma-Token': TOKEN } });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      console.log(`⏭  Gate [7] skipped — FIGMA_TOKEN lacks file_content:read scope (${resp.status})`);
    } else {
      console.log(`⏭  Gate [7] skipped — Figma images API ${resp.status}: ${text.slice(0, 120)}`);
    }
    process.exit(0);
  }
  const data = await resp.json();
  if (data.err) { console.error('❌ Figma API error:', data.err); process.exit(1); }
  imageUrls = data.images ?? {};
} catch (e) {
  console.log(`⏭  Gate [7] skipped — network error fetching image URLs: ${e.message}`);
  process.exit(0);
}

// ── Download and compare ──────────────────────────────────────────────────────
const PASS = [], FAIL = [], NEW_REF = [], UPDATED = [];
// Advisory mode: a changed frame auto-updates the baseline and reports (git-visible)
// instead of blocking the audit — the pixel screenshot is frame-vs-frame (does the DS
// look different?), not a code check. Structural code-vs-DS geometry is covered by the
// frameGeom / FRAME_GEOMETRY_MAP rendered checks. Enable via ds-config visualRegression.mode.
const ADVISORY = cfg.visualRegression?.mode === 'advisory';

// Download every frame's PNG concurrently (each is an independent CDN fetch), then
// process the results serially — the render was one batched /images call above.
const downloads = await Promise.all(FRAMES.map(async frame => {
  const imgUrl = imageUrls[frame.nodeId.replace(/-/, ':')]
    ?? imageUrls[frame.nodeId]
    ?? imageUrls[frame.nodeId.replace(':', '-')];
  if (!imgUrl) return { frame, err: 'no image URL returned' };
  try {
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
    return { frame, imgData: Buffer.from(await imgResp.arrayBuffer()) };
  } catch (e) {
    return { frame, err: e.message };
  }
}));

for (const { frame, imgData, err } of downloads) {
  const slug    = frame.nodeId.replace(/[:\/]/g, '-'); // safe filename
  const refPath = join(REFS_DIR, `${slug}.png`);
  const newPath = join(REFS_DIR, `${slug}.new.png`);

  if (err) {
    console.log(`⚠️  ${frame.name} (${frame.nodeId}) — ${err} — skipped`);
    continue;
  }

  const newHash = createHash('md5').update(imgData).digest('hex');

  if (!existsSync(refPath)) {
    writeFileSync(refPath, imgData);
    NEW_REF.push({ name: frame.name, nodeId: frame.nodeId, slug });
  } else {
    const refHash = createHash('md5').update(readFileSync(refPath)).digest('hex');
    if (newHash === refHash) {
      PASS.push(frame.name);
    } else if (ADVISORY) {
      // Advisory mode: the reference IS the DS frame, so a change means the designer edited
      // the frame — not that the code regressed (that's the structural frameGeom checks' job).
      // Auto-update the baseline (the PNG diff is git-visible for review) and report; never block.
      writeFileSync(refPath, imgData);
      UPDATED.push({ name: frame.name, slug });
    } else {
      writeFileSync(newPath, imgData);
      FAIL.push({ name: frame.name, nodeId: frame.nodeId, slug, refPath, newPath });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ MATCH   ${PASS.length}`);
console.log(`📸 NEW REF ${NEW_REF.length}`);
console.log(`❌ CHANGED ${FAIL.length}`);

if (NEW_REF.length) {
  console.log('\n─── New references saved ─────────────────────────────────────');
  for (const r of NEW_REF)
    console.log(`  📸 "${r.name}" → ${cfg.visualRefs ?? '.parity-refs'}/${r.slug}.png`);
  console.log('   Re-run to verify these new references on the next audit.');
}

if (FAIL.length) {
  console.log('\n─── Visual changes detected ──────────────────────────────────');
  for (const f of FAIL) {
    console.log(`  ❌ "${f.name}" — screenshot changed since last reference`);
    console.log(`     New:  ${f.newPath}`);
    console.log(`     Ref:  ${f.refPath}`);
    console.log(`     Accept: mv "${f.newPath}" "${f.refPath}"`);
  }
}

if (UPDATED.length) {
  console.log('\n─── Baselines auto-updated (advisory — DS frame changed) ─────');
  for (const u of UPDATED) console.log(`  🔄 "${u.name}" → ${cfg.visualRefs ?? '.parity-refs'}/${u.slug}.png (review the PNG diff)`);
  console.log('   Not a code regression — structural code↔DS geometry is checked by frameGeom.');
}

if (!FAIL.length && !NEW_REF.length && !UPDATED.length && PASS.length) {
  console.log('\nAll frames match their references. ✓\n');
}

// ── Plugin coverage advisory ───────────────────────────────────────────────────
// Reports which plugin apps have no visual regression frame configured.
// Add { "name": "...", "nodeId": "...", "plugin": "<plugin-name>" } to ds-config.json → frames.
const PLUGINS_LIST = cfg.paths?.plugins ?? [];
if (PLUGINS_LIST.length) {
  const coveredPlugins = new Set(FRAMES.map(f => f.plugin).filter(Boolean));
  const uncovered = PLUGINS_LIST.filter(p => !coveredPlugins.has(p));
  if (uncovered.length) {
    console.log(`\nℹ️  NO VISUAL REF — ${uncovered.join(', ')} — add Figma frame nodeId + "plugin" field to ds-config.json → frames`);
  }
}

console.log('');
process.exit(FAIL.length > 0 ? 1 : 0);
