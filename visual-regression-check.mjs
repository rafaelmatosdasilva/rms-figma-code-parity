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

if (!TOKEN) {
  console.log('⏭ FIGMA_TOKEN not set — visual regression skipped (set env var to enable)');
  process.exit(0);
}
if (!FILE_KEY) {
  console.error('❌ figmaFileKey missing in ds-config.json'); process.exit(1);
}
if (!FRAMES.length) {
  console.log('⏭ No frames configured in ds-config.json — visual regression skipped');
  process.exit(0);
}

// Ensure refs directory exists
mkdirSync(REFS_DIR, { recursive: true });

// ── Fetch image export URLs from Figma REST API ───────────────────────────────
// Figma node IDs use ':' in the UI but the API accepts both '-' and ':'.
// Normalize to ':' for the API, use '-' for filenames.
const nodeIds   = FRAMES.map(f => f.nodeId.replace(/-/, ':')); // only first dash → colon
const idsParam  = encodeURIComponent(nodeIds.join(','));
const apiUrl    = `https://api.figma.com/v1/images/${FILE_KEY}?ids=${idsParam}&format=png&scale=2`;

let imageUrls = {};
try {
  const resp = await fetch(apiUrl, { headers: { 'X-Figma-Token': TOKEN } });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`❌ Figma API ${resp.status}: ${text}`); process.exit(1);
  }
  const data = await resp.json();
  if (data.err) { console.error('❌ Figma API error:', data.err); process.exit(1); }
  imageUrls = data.images ?? {};
} catch (e) {
  console.error('❌ Failed to fetch image URLs:', e.message); process.exit(1);
}

// ── Download and compare ──────────────────────────────────────────────────────
const PASS = [], FAIL = [], NEW_REF = [];

for (const frame of FRAMES) {
  const normalized = frame.nodeId.replace(/-/, ':'); // match what we sent
  const slug       = frame.nodeId.replace(/[:\/]/g, '-'); // safe filename
  const refPath    = join(REFS_DIR, `${slug}.png`);
  const newPath    = join(REFS_DIR, `${slug}.new.png`);

  // Try both node ID formats in the response
  const imgUrl = imageUrls[normalized]
    ?? imageUrls[frame.nodeId]
    ?? imageUrls[frame.nodeId.replace(':', '-')];

  if (!imgUrl) {
    console.log(`⚠️  No image URL returned for "${frame.name}" (${frame.nodeId}) — skipped`);
    continue;
  }

  let imgData;
  try {
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
    imgData = Buffer.from(await imgResp.arrayBuffer());
  } catch (e) {
    console.error(`❌ Failed to download image for "${frame.name}": ${e.message}`);
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

if (!FAIL.length && !NEW_REF.length && PASS.length) {
  console.log('\nAll frames match their references. ✓\n');
}

console.log('');
process.exit(FAIL.length > 0 ? 1 : 0);
