// collect-raw-values.mjs — a bounded sweep of the raw numeric + colour values in a Figma /nodes
// document tree (used to refresh component-values.snapshot.json).
//
// Why the budget: Figma's /nodes endpoint expands instance subtrees inline, so a component set with
// nested instances can return a document tree with millions of nodes. The walk is synchronous, so a
// runaway tree pins the CPU at 100% and — because a synchronous spin also blocks the event loop —
// hangs the whole audit (and, via the pre-commit hook, the commit) with no timer able to fire. The
// budget is a shared { n } counter: once it reaches zero the walk stops descending. The values are a
// coarse "raw values present" sweep, so a truncated walk on a pathological tree still yields a
// representative sample; the caller reports when the cap was hit.

export const COLLECT_NODE_BUDGET =
  Math.max(10000, parseInt(process.env.PARITY_VALUE_NODE_BUDGET, 10) || 300000);

export const _rgbToHex = (c) => {
  if (!c) return null;
  const to = (x) => Math.round((x ?? 0) * 255).toString(16).padStart(2, '0');
  return (to(c.r) + to(c.g) + to(c.b)).toLowerCase();
};

export function collectRawValues(node, nums, colors, budget) {
  if (!node || typeof node !== 'object') return;
  if (budget) { if (budget.n <= 0) return; budget.n--; }
  const pushN = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) { nums.add(Math.round(n * 100) / 100); nums.add(Math.round(n)); }
  };
  const bb = node.absoluteBoundingBox || node.size;
  if (bb) { pushN(bb.width ?? bb.x); pushN(bb.height ?? bb.y); }
  pushN(node.cornerRadius);
  if (Array.isArray(node.rectangleCornerRadii)) node.rectangleCornerRadii.forEach(pushN);
  pushN(node.strokeWeight);
  pushN(node.itemSpacing);
  pushN(node.paddingLeft); pushN(node.paddingRight); pushN(node.paddingTop); pushN(node.paddingBottom);
  if (node.style?.fontSize) pushN(node.style.fontSize);
  for (const f of node.fills   ?? []) if (f?.type === 'SOLID' && f.color) { const h = _rgbToHex(f.color); if (h) colors.add(h); }
  for (const s of node.strokes ?? []) if (s?.color) { const h = _rgbToHex(s.color); if (h) colors.add(h); }
  for (const e of node.effects ?? []) if (e?.color) { const h = _rgbToHex(e.color); if (h) colors.add(h); }
  for (const child of node.children ?? []) { if (budget && budget.n <= 0) break; collectRawValues(child, nums, colors, budget); }
}
