import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRawValues } from '../collect-raw-values.mjs';

// Build a balanced tree of `total` nodes so we can prove the budget bounds the walk. Figma's
// /nodes endpoint expands instance subtrees inline, so a real pathological tree can be millions of
// nodes; here a few thousand is enough to exercise the cap.
function tree(total) {
  const root = { children: [] };
  let made = 1;
  const queue = [root];
  while (made < total && queue.length) {
    const parent = queue.shift();
    for (let i = 0; i < 4 && made < total; i++) {
      const child = { strokeWeight: 1.5, children: [] };
      parent.children.push(child);
      queue.push(child);
      made++;
    }
  }
  return root;
}

test('the node budget bounds a runaway tree — the walk stops instead of visiting every node', () => {
  const nums = new Set(), colors = new Set();
  const budget = { n: 100 };
  collectRawValues(tree(100000), nums, colors, budget); // 100k-node tree, but budget is 100
  assert.equal(budget.n, 0);                            // spent exactly the budget, did not run away
});

test('a normal tree is fully collected and does not exhaust a generous budget', () => {
  const nums = new Set(), colors = new Set();
  const budget = { n: 300000 };
  const root = {
    absoluteBoundingBox: { width: 48, height: 24 },
    children: [
      { cornerRadius: 8, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
      { strokeWeight: 1.5, itemSpacing: 12 },
    ],
  };
  collectRawValues(root, nums, colors, budget);
  assert.ok(budget.n > 299000);          // barely touched — normal sets never hit the cap
  assert.ok(nums.has(48) && nums.has(24) && nums.has(8) && nums.has(12)); // values collected
  assert.ok(colors.has('ff0000'));       // red fill collected
});

test('without a budget it still walks (backward-compatible)', () => {
  const nums = new Set(), colors = new Set();
  collectRawValues({ cornerRadius: 4, children: [{ strokeWeight: 2 }] }, nums, colors);
  assert.ok(nums.has(4) && nums.has(2));
});
