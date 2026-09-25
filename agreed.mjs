// agreed.mjs - what Figma and the code last agreed on, fact by fact (idea I47).
//
// Comparing the two sides directly cannot say which one moved. So every run records, for each fact
// that matches, the value on each side; the next run compares a differing fact with that record:
//   • only Figma's value changed since they agreed  → figma-moved  (the code is behind)
//   • only the code's value changed                 → code-moved   (Figma is behind)
//   • both changed                                  → both-moved   (a conflict for a person to decide)
//   • no record yet, or neither changed             → unknown      (today's behaviour: just a difference)
// A differing fact never overwrites the record: only an agreement (or an explicit decision) does.
// The record lives in parity-agreed.json at the project root and is meant to be committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const AGREED_FILE = 'parity-agreed.json';

export function loadAgreed(root, file = AGREED_FILE) {
  try { const j = JSON.parse(readFileSync(join(root, file), 'utf8')); return j?.facts ? j : { version: 1, facts: {} }; }
  catch { return { version: 1, facts: {} }; }
}

export function classify(fact, agreed) {
  const a = agreed?.facts?.[fact.key];
  if (!a || fact.same) return 'unknown';
  const figmaMoved = a.figma !== fact.figma, codeMoved = a.code !== fact.code;
  if (figmaMoved && codeMoved) return 'both-moved';
  if (figmaMoved) return 'figma-moved';
  if (codeMoved) return 'code-moved';
  return 'unknown';
}

export const MOVED_LABEL = { 'figma-moved': 'Figma moved, code is behind', 'code-moved': 'code moved, Figma is behind', 'both-moved': 'both moved since they agreed' };

// Records every matching fact. Returns { recorded, changed } (changed: the file differs from before).
export function recordAgreed(root, facts, { at = new Date().toISOString(), commit = headCommit(root), file = AGREED_FILE } = {}) {
  const agreed = loadAgreed(root, file);
  let recorded = 0, changed = false;
  for (const f of facts ?? []) {
    if (!f.same) continue;
    recorded++;
    const prev = agreed.facts[f.key];
    if (prev && prev.figma === f.figma && prev.code === f.code) continue;   // same agreement: keep its date
    agreed.facts[f.key] = { figma: f.figma, code: f.code, at, ...(commit ? { commit } : {}) };
    changed = true;
  }
  if (changed) {
    const sorted = Object.fromEntries(Object.entries(agreed.facts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(root, file), JSON.stringify({ version: 1, $description: 'What Figma and the code last agreed on, per fact. Written by rms-figma-code-parity; commit it.', facts: sorted }, null, 1) + '\n');
  }
  return { recorded, changed };
}

function headCommit(root) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
