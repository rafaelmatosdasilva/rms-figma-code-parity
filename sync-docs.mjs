#!/usr/bin/env node
// sync-docs.mjs — Validates and auto-patches documentation against audit.mjs.
//
// Run manually:   node sync-docs.mjs
// Run as check:   node sync-docs.mjs --check   (exits 1 if anything would change)
//
// What it does:
//   1. Parses audit.mjs to extract the authoritative gate list (labels + scripts).
//   2. Checks README.md and rms-parity.md for stale gate counts.
//   3. Auto-patches all "N automated gates" / "Run all N audit gates" / trend bar
//      references to match the real count.
//   4. Checks that each gate label (or a keyword form of it) appears in the doc.
//   5. Prints a diff summary. Exits 1 if --check and anything was stale.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }                           from 'path';
import { fileURLToPath }                           from 'url';

const DIR   = dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.includes('--check');
const isTTY = process.stdout.isTTY;
const green  = s => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red    = s => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = s => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const bold   = s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;
const dim    = s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s;

// ── 1. Parse audit.mjs — source of truth ─────────────────────────────────────
const auditSrc = readFileSync(join(DIR, 'audit.mjs'), 'utf8');

// Extract gate labels from addGate('Label', ...) calls (in order)
const gateLabels  = [...auditSrc.matchAll(/addGate\(\s*'([^']+)'/g)].map(m => m[1].trim());
// Extract script names from runScriptAsync('script.mjs') calls (in order)
const scriptNames = [...auditSrc.matchAll(/runScriptAsync\(\s*'([^']+)'/g)].map(m => m[1].trim());

// Extract GATE_PLAIN array from audit.mjs (plain-English gate names for summary table)
const gatePlainMatch = auditSrc.match(/const GATE_PLAIN\s*=\s*\[([\s\S]*?)\];/);
const gatePlain = gatePlainMatch
  ? [...gatePlainMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  : [];

// Extract GATE_PLAN_RISK object from audit.mjs
const planRiskMatch = auditSrc.match(/const GATE_PLAN_RISK\s*=\s*\{([\s\S]*?)\};/);
const gatePlanRisk = {};
if (planRiskMatch) {
  for (const m of planRiskMatch[1].matchAll(/(\d+)\s*:\s*'([^']+)'/g)) {
    gatePlanRisk[Number(m[1])] = m[2];
  }
}

// Gates [1] and [5] are computed inline (combined from former inline gates 1+7 and 5+6)
const INLINE_INDICES = new Set([0, 4]);
const gates = gateLabels.map((label, i) => {
  if (INLINE_INDICES.has(i)) return { n: i + 1, label, script: 'inline' };
  const scriptIdx = [...Array(i).keys()].filter(j => !INLINE_INDICES.has(j)).length;
  return { n: i + 1, label, script: scriptNames[scriptIdx] ?? '?' };
});

const GATE_COUNT = gates.length;

// For label presence checking, reduce each label to its first meaningful word(s)
// (strip trailing parentheticals like "(color · sizing · typography)")
function labelKeyword(label) {
  return label
    .replace(/\s*\(.*$/, '')      // drop trailing parenthetical
    .replace(/\s{2,}/g, ' ')      // collapse runs of spaces
    .trim()
    .split(/\s+/)
    .slice(0, 3)                  // first 3 words — specific enough
    .join(' ');
}

// ── Generate example output block ─────────────────────────────────────────────
function generateExampleOutput() {
  const W = 60;
  const divider = '─'.repeat(W);
  const lines = [];

  lines.push('```');
  lines.push(divider);
  lines.push('  PARITY AUDIT  ·  YYYY-MM-DD');
  lines.push(divider);
  lines.push('');

  // Show first two gates as examples (one pass, one fail with detail)
  lines.push('✅  [1] Figma snapshots are up to date');
  lines.push('       packages/ui/src/figma-vars.snapshot.json ✓ (updated today)');
  lines.push('       ✅ All outputs current');
  lines.push('');
  const gate2Label = gatePlain[1] ?? 'Token values match Figma';
  lines.push(`❌  [2] ${gate2Label}`);
  lines.push('       ✅ PASS  87');
  lines.push('       ❌ FAIL  2');
  lines.push('         ❌ [color/Dark] buttonPrimary/background → --buttonPrimary-background');
  lines.push('              Figma: #ededed   CSS: #d4d4d4');
  lines.push('');
  lines.push('  ... (one block per gate)');
  lines.push('');

  // Gate summary table
  lines.push(divider);
  lines.push('  GATE SUMMARY');
  lines.push(divider);
  for (let i = 0; i < GATE_COUNT; i++) {
    const n = i + 1;
    const plain = gatePlain[i] ?? gateLabels[i] ?? `Gate ${n}`;
    const numPad = `[${n}]`.padEnd(6);
    const labelPad = plain.length > 48 ? plain.slice(0, 47) + '…' : plain.padEnd(48);
    lines.push(`  ✅  ${numPad}${labelPad}Pass`);
  }
  lines.push('');
  lines.push(divider);
  lines.push('');
  lines.push('  ALL GATES PASS ✅');
  lines.push('');
  lines.push('  ⏭  STALE-SNAPSHOT MODE — when a gate shows ⏭ instead of ✅:');
  lines.push('');
  for (const [num, risk] of Object.entries(gatePlanRisk)) {
    const plain = gatePlain[Number(num) - 1] ?? `Gate ${num}`;
    lines.push(`  [${num}] ${plain}`);
    lines.push(`      Shown as ⏭ only when a snapshot is >24h old and the REST auto-refresh`);
    lines.push(`      is not available on this plan. The Phase 1 Plugin API captures refresh`);
    lines.push(`      every snapshot on any plan — commit them and the gate is ✅.`);
    lines.push(`      ${risk}`);
    lines.push('');
  }
  lines.push(divider);
  lines.push('```');

  return lines.join('\n');
}

console.log(bold(`\nrms-figma-code-parity sync-docs — source of truth: ${GATE_COUNT} gates\n`));
for (const g of gates) {
  console.log(dim(`  [${String(g.n).padStart(2)}] ${g.label}  (${g.script})`));
}
console.log('');

// ── 2. Doc files to check ─────────────────────────────────────────────────────
const DOCS = [
  { path: join(DIR, 'README.md'),                        label: 'README.md'       },
  { path: join(DIR, 'rms-figma-code-parity.md'),         label: 'rms-figma-code-parity.md' },
  { path: join(DIR, '.claude/commands/rms-figma-code-parity.md'), label: 'rms-figma-code-parity.md (commands)' },
];

let anyStale = false;

for (const doc of DOCS) {
  if (!existsSync(doc.path)) {
    console.log(yellow(`  ⚠️  ${doc.label} not found — skipped`));
    continue;
  }

  const original = readFileSync(doc.path, 'utf8');
  let patched    = original;
  const changes  = [];

  // ── Patch: example output block (README only, between sentinel comments)
  if (doc.label === 'README.md') {
    const START = '<!-- EXAMPLE-OUTPUT-START -->';
    const END   = '<!-- EXAMPLE-OUTPUT-END -->';
    const si = patched.indexOf(START);
    const ei = patched.indexOf(END);
    if (si !== -1 && ei !== -1 && ei > si) {
      const fresh = `${START}\n${generateExampleOutput()}\n${END}`;
      const current = patched.slice(si, ei + END.length);
      if (current !== fresh) {
        changes.push('example output block regenerated');
        patched = patched.slice(0, si) + fresh + patched.slice(ei + END.length);
      }
    }
  }

  // ── Patch: "N automated gates"
  patched = patched.replace(/\b(\d+)( automated gates\b)/g, (_, n, post) => {
    if (Number(n) !== GATE_COUNT) changes.push(`"${n} automated gates" → "${GATE_COUNT} automated gates"`);
    return `${GATE_COUNT}${post}`;
  });

  // ── Patch: "N automated checks"
  patched = patched.replace(/\b(\d+)( automated checks\b)/g, (_, n, post) => {
    if (Number(n) !== GATE_COUNT) changes.push(`"${n} automated checks" → "${GATE_COUNT} automated checks"`);
    return `${GATE_COUNT}${post}`;
  });

  // ── Patch: "Run all N audit gates" / "all N audit gates" / "All N gates" (any case)
  patched = patched.replace(/(Run all |[Aa]ll )(\d+)( audit gates| gates)/g, (_, pre, n, post) => {
    if (Number(n) !== GATE_COUNT) changes.push(`"${pre}${n}${post}" → "${pre}${GATE_COUNT}${post}"`);
    return `${pre}${GATE_COUNT}${post}`;
  });

  // ── Patch: "(N gates)" parenthetical, e.g. "...and more (17 gates)."
  patched = patched.replace(/(\()(\d+)( gates\))/g, (_, pre, n, post) => {
    if (Number(n) !== GATE_COUNT) changes.push(`"(${n} gates)" → "(${GATE_COUNT} gates)"`);
    return `${pre}${GATE_COUNT}${post}`;
  });

  // ── Patch: "## The N checks" heading
  patched = patched.replace(/(##\s*The )(\d+)( checks)/g, (_, pre, n, post) => {
    if (Number(n) !== GATE_COUNT) changes.push(`"The ${n} checks" → "The ${GATE_COUNT} checks"`);
    return `${pre}${GATE_COUNT}${post}`;
  });

  // ── Patch: trend bar fractions — only inside trend bar lines (e.g. "  13/13 [")
  patched = patched.replace(/(^\s*(?:✅|❌)\s+\S+\s+)(\d+)\/(\d+)(\s*\[)/gm, (match, pre, a, b, post) => {
    if (a !== b) return match; // unequal fractions are pass/fail ratios — don't touch
    if (Number(a) !== GATE_COUNT) changes.push(`trend fraction "${a}/${b}" → "${GATE_COUNT}/${GATE_COUNT}"`);
    return `${pre}${GATE_COUNT}/${GATE_COUNT}${post}`;
  });

  // ── Patch: trend bar block-fill — match bar length to GATE_COUNT
  patched = patched.replace(/(\[)(█+)(░*)\]/g, (match, open, filled, empty) => {
    const total = filled.length + empty.length;
    if (total !== GATE_COUNT) {
      const ratio   = filled.length / total;
      const newFill = Math.round(ratio * GATE_COUNT);
      const newStr  = `[${'█'.repeat(newFill)}${'░'.repeat(GATE_COUNT - newFill)}]`;
      changes.push(`trend bar length ${total} → ${GATE_COUNT}`);
      return newStr;
    }
    return match;
  });

  // ── Check: each gate's label keyword appears in the doc.
  // Checks both the technical label and the plain-English GATE_PLAIN name so docs
  // can use either form without false positives.
  const missingLabels = gates
    .map((g, i) => {
      const anchor      = labelKeyword(g.label);
      const plainAnchor = gatePlain[i] ? labelKeyword(gatePlain[i]) : null;
      return { g, anchor, plainAnchor };
    })
    .filter(({ anchor, plainAnchor }) =>
      !original.includes(anchor) && (!plainAnchor || !original.includes(plainAnchor))
    )
    .map(({ g, anchor, plainAnchor }) => `[${g.n}] ${g.label}  (looking for: "${anchor}"${plainAnchor ? ` or "${plainAnchor}"` : ''})`);

  // ── Check: "## The N checks" table has exactly GATE_COUNT numbered rows.
  // Catches a table that's been truncated/under-grown even though every gate
  // label still appears elsewhere in the doc (e.g. inside the auto-generated
  // example-output block, which always lists all gates regardless of the
  // human-written table's state).
  let tableRowIssue = null;
  {
    const headingMatch = patched.match(/##\s*The \d+ checks\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
    if (headingMatch) {
      const rowNums = [...headingMatch[1].matchAll(/^\|\s*(\d+)\s*\|/gm)].map(m => Number(m[1]));
      if (rowNums.length !== GATE_COUNT) {
        tableRowIssue = `"The N checks" table has ${rowNums.length} row(s), expected ${GATE_COUNT} (update manually — row content isn't auto-generated)`;
      }
    }
  }

  // ── Report
  if (changes.length === 0 && missingLabels.length === 0 && !tableRowIssue) {
    console.log(green(`  ✅ ${doc.label} — in sync`));
  } else {
    anyStale = true;
    if (changes.length) {
      const verb = CHECK ? 'would patch' : 'patched';
      console.log(yellow(`  ⚠️  ${doc.label} — ${verb}:`));
      for (const c of changes) console.log(dim(`       ${c}`));
    }
    if (missingLabels.length) {
      console.log(red(`  ❌ ${doc.label} — gate labels missing from doc (update manually):`));
      for (const l of missingLabels) console.log(`       ${l}`);
    }
    if (tableRowIssue) {
      console.log(red(`  ❌ ${doc.label} — ${tableRowIssue}`));
    }
    if (!CHECK && changes.length) {
      writeFileSync(doc.path, patched);
      console.log(dim(`       Written.`));
    }
  }
}

console.log('');
if (anyStale && CHECK) {
  console.log(red('  Docs are stale. Run: node sync-docs.mjs\n'));
  process.exit(1);
} else if (!anyStale) {
  console.log(green('  All docs in sync.\n'));
}
