// visual-diff.mjs - each component as the page draws it, against its Figma image (idea I43).
//
// Field-by-field comparison misses what only pixels show: an icon on the wrong side, an alignment, a wrong
// glyph. With ds-config.json → codeReading.visual: true, the capture saves a PNG of each component's instance
// (first mode, default state, at scale 2). This compares it with the Figma image of the component's default
// variant, from the first of:
//   1. <visualRefs>/components/<name>.png (default .parity-refs), saved by hand or with the Figma MCP;
//   2. the Figma REST images API (FIGMA_TOKEN and figmaFileKey), cached under .parity-out/visual/figma/.
// A component with neither is listed as not compared, never guessed. The images are compared in Chrome on
// a canvas (no image library needed): the Figma image is drawn on the background the component sits on,
// then every pixel whose colour differs by more than the tolerance, and is not found within one pixel in
// the other image (anti-aliasing), counts. The result is advisory: two
// percentages per component, with and without its text, worst first, and a diff image under
// .parity-out/visual/diff/. The one without text decides the ⚠️ (codeReading.visualThreshold, default 2%).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { findChrome, launchChrome, connectCDP, openPage } from './cdp.mjs';

const safe = (name) => String(name).replace(/[^\w.-]+/g, '_');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const axes = (n) => String(n ?? '').toLowerCase().replace(/\s+/g, '');

// Where the Figma image of a component comes from. Returns { file, from } or { why }.
export async function figmaImage(ROOT, cfg, name, { nodeId, defaultVariant, version, token = process.env.FIGMA_TOKEN, fetchImpl = fetch, outDir = '.parity-out' } = {}) {
  const ref = resolve(ROOT, cfg.visualRefs ?? '.parity-refs', 'components', `${safe(name)}.png`);
  if (existsSync(ref)) return { file: ref, from: 'reference' };
  if (!token) return { why: 'no reference image and no FIGMA_TOKEN' };
  if (!cfg.figmaFileKey) return { why: 'no reference image and no figmaFileKey in ds-config.json' };
  if (!nodeId) return { why: 'no reference image and no node id in the structure snapshot' };
  const dir = resolve(ROOT, outDir, 'visual', 'figma'), file = join(dir, `${safe(name)}.png`), meta = join(dir, `${safe(name)}.json`);
  const m = readJson(meta);
  if (existsSync(file) && m?.nodeId === nodeId && m?.version === (version ?? null)) return { file, from: 'figma (cached)' };
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Figma answered ${r.status}`);
    return r;
  };
  try {
    const key = cfg.figmaFileKey, id = String(nodeId).replace('-', ':');
    // A component set renders every variant at once: take its default variant's own node.
    let target = id;
    const nodes = await (await get(`https://api.figma.com/v1/files/${key}/nodes?ids=${encodeURIComponent(id)}&depth=1`)).json();
    const doc = nodes?.nodes?.[id]?.document;
    if (doc?.type === 'COMPONENT_SET' && doc.children?.length) {
      target = (doc.children.find((c) => axes(c.name) === axes(defaultVariant)) ?? doc.children[0]).id;
    }
    const img = await (await get(`https://api.figma.com/v1/images/${key}?ids=${encodeURIComponent(target)}&format=png&scale=2`)).json();
    const url = img?.images?.[target];
    if (!url) return { why: 'Figma returned no image' };
    const bytes = Buffer.from(await (await fetchImpl(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, bytes);
    writeFileSync(meta, JSON.stringify({ nodeId, target, version: version ?? null }) + '\n');
    return { file, from: 'figma' };
  } catch (e) { return { why: `could not fetch the Figma image (${String(e.message || e).split('\n')[0]})` }; }
}

// Runs in the page: both images on one canvas size, the Figma one over the component's background.
// `text` are the component's text boxes in CSS pixels ([x, y, w, h]); `scale` the image scale. Pixels in
// them (grown by one CSS pixel) are left out of the second score: glyphs never rasterise the same way in
// two renderers, so that score is about shape and colour only.
export function compareExpression(figmaUrl, codeUrl, background, tolerance, text = [], scale = 2) {
  return `(async () => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image did not load')); i.src = src; });
    const [a, b] = await Promise.all([load(${JSON.stringify(figmaUrl)}), load(${JSON.stringify(codeUrl)})]);
    const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
    const pixels = (img) => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.fillStyle = ${JSON.stringify(background)}; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const pa = pixels(a), pb = pixels(b);
    const out = new OffscreenCanvas(w, h), ox = out.getContext('2d'), od = ox.createImageData(w, h);
    let diff = 0, outside = 0, outsideTotal = 0;
    const mask = new Uint8Array(w * h);
    for (const [x, y, bw, bh] of ${JSON.stringify(text)}) {
      const s = ${Number(scale)}, x0 = Math.max(0, Math.floor((x - 1) * s)), y0 = Math.max(0, Math.floor((y - 1) * s));
      const x1 = Math.min(w, Math.ceil((x + bw + 1) * s)), y1 = Math.min(h, Math.ceil((y + bh + 1) * s));
      for (let Y = y0; Y < y1; Y++) mask.fill(1, Y * w + x0, Y * w + x1);
    }
    const T = ${Number(tolerance)};
    const near = (p, i, q, j) => Math.max(Math.abs(p[i] - q[j]), Math.abs(p[i + 1] - q[j + 1]), Math.abs(p[i + 2] - q[j + 2])) <= T;
    // Anti-aliasing and sub-pixel text differ between any two renderers: a pixel that has its colour
    // within one pixel in the other image (both ways) is not a difference.
    const within1 = (p, i, q) => {
      const x = (i / 4) % w, y = Math.floor(i / 4 / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h && near(p, i, q, (Y * w + X) * 4)) return true;
      }
      return false;
    };
    for (let i = 0; i < pa.length; i += 4) {
      const inText = mask[i / 4] === 1;
      if (!inText) outsideTotal++;
      if (!near(pa, i, pb, i) && !(within1(pa, i, pb) && within1(pb, i, pa))) { diff++; if (!inText) outside++; od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 64; od.data[i + 3] = 255; }
      else { const g = pb[i] * 0.3 + pb[i + 1] * 0.59 + pb[i + 2] * 0.11; od.data[i] = od.data[i + 1] = od.data[i + 2] = g; od.data[i + 3] = 60; }
    }
    ox.putImageData(od, 0, 0);
    const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { figma: [a.width, a.height], code: [b.width, b.height], diff, total: w * h, outside, outsideTotal, png: btoa(bin) };
  })()`;
}

// Every component the capture drew, compared with its Figma image. Returns { rows, missing, note }.
export async function visualDiff(ROOT, cfg, code, structure, { outDir = '.parity-out', version = null, chromePath = findChrome({ playwright: true }), token, fetchImpl } = {}) {
  const drawn = Object.entries(code?.components ?? {}).filter(([, c]) => c.visual?.file);
  if (!drawn.length) return { rows: [], missing: [], note: null };
  const tolerance = Number.isFinite(cfg.codeReading?.visualTolerance) ? cfg.codeReading.visualTolerance : 10;
  const threshold = Number.isFinite(cfg.codeReading?.visualThreshold) ? cfg.codeReading.visualThreshold : 2;
  const pairs = [], missing = [];
  for (const [name, c] of drawn) {
    const f = structure?.[name] ?? {};
    const img = await figmaImage(ROOT, cfg, name, { nodeId: f.nodeId, defaultVariant: f.defaultVariant, version, token, fetchImpl, outDir });
    if (img.file) pairs.push({ name, figma: img.file, from: img.from, code: resolve(ROOT, c.visual.file), background: c.visual.background ?? '#ffffff', text: c.visual.text ?? [], scale: c.visual.scale ?? 2 });
    else missing.push({ name, why: img.why });
  }
  if (!pairs.length) return { rows: [], missing, note: null };
  if (!chromePath || typeof WebSocket === 'undefined') return { rows: [], missing, note: 'Chrome not found, images not compared' };
  const diffDir = resolve(ROOT, outDir, 'visual', 'diff');
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(diffDir, { recursive: true });
  const rows = [];
  const chrome = await launchChrome(chromePath, { tmpPrefix: 'visual-diff-' });
  try {
    const cdp = await connectCDP(chrome.wsUrl);
    try {
      const { sessionId } = await openPage(cdp.send, 'about:blank');
      const dataUrl = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
      for (const p of pairs) {
        const r = (await cdp.send('Runtime.evaluate', { expression: compareExpression(dataUrl(p.figma), dataUrl(p.code), p.background, tolerance, p.text, p.scale), awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
        if (!r) { missing.push({ name: p.name, why: 'the images could not be compared' }); continue; }
        const file = join(diffDir, `${safe(p.name)}.png`);
        writeFileSync(file, Buffer.from(r.png, 'base64'));
        const pct = Math.round((1000 * r.diff) / r.total) / 10;
        const noText = r.outsideTotal ? Math.round((1000 * r.outside) / r.outsideTotal) / 10 : 0;
        rows.push({ name: p.name, pct, noText, over: noText > threshold, figmaSize: r.figma, codeSize: r.code, from: p.from, diff: relative(ROOT, file) });
      }
    } finally { cdp.close(); }
  } finally { chrome.kill(); }
  return { rows: rows.sort((a, b) => b.noText - a.noText || b.pct - a.pct || a.name.localeCompare(b.name)), missing, note: null, threshold };
}

export function visualLines(r, refsDir = '.parity-refs') {
  const lines = [];
  if (r.rows.length) {
    const over = r.rows.filter((x) => x.over);
    lines.push(`🖼  VISUAL ${r.rows.length} compared with their Figma image (advisory, worst first): ${over.length} differ by more than ${r.threshold}% of pixels outside text`);
    for (const x of r.rows) {
      const size = x.figmaSize.join('×') === x.codeSize.join('×') ? '' : `, Figma ${x.figmaSize.join('×')} and code ${x.codeSize.join('×')} px`;
      lines.push(`   🖼  ${x.over ? '⚠️ ' : '✓ '} ${x.name}: ${x.noText}% of pixels differ outside text, ${x.pct}% with it${size}  → ${x.diff}`);
    }
  }
  if (r.note) lines.push(`   🖼  ⏭ ${r.note}`);
  if (r.missing.length) {
    const by = new Map();
    for (const m of r.missing) by.set(m.why, [...(by.get(m.why) ?? []), m.name]);
    for (const [why, names] of by) lines.push(`   🖼  ⏭ not compared (${names.length}), ${why}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? `, ${names.length - 12} more` : ''}`);
    lines.push(`   🖼  ⏭ to compare them: set FIGMA_TOKEN, or save each default variant at scale 2 as ${refsDir}/components/<name>.png`);
  }
  return lines;
}
