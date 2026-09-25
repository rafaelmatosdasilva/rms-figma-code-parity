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
//
// History (ideas I50, I51): `seen` keeps, per fact, both values at the last run and its last 10 moves
// ({ at, side: figma | code | both, lead }), a move being a side whose value changed since the last run.
// `lead` marks a move that broke an agreement: that side moved first. From it:
//   • churn   - a fact whose moving side switched 3 or more times in its last 10 moves: no clear owner;
//   • leaders - per area, over the last 30 days, which side moved first, as a share. Descriptive only.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const AGREED_FILE = 'parity-agreed.json';

export function loadAgreed(root, file = AGREED_FILE) {
  try { const j = JSON.parse(readFileSync(join(root, file), 'utf8')); return j?.facts ? { ...j, seen: j.seen ?? {} } : { version: 1, facts: {}, seen: {} }; }
  catch { return { version: 1, facts: {}, seen: {} }; }
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

const MAX_MOVES = 10;
// Records every matching fact, and every fact's move since the last run. Returns { recorded, changed, agreed }
// (changed: the file differs from before).
export function recordAgreed(root, facts, { at = new Date().toISOString(), commit = headCommit(root), file = AGREED_FILE } = {}) {
  const agreed = loadAgreed(root, file);
  let recorded = 0, changed = false;
  for (const f of facts ?? []) {
    const s = agreed.seen[f.key];
    if (!s) { agreed.seen[f.key] = { figma: f.figma, code: f.code, same: !!f.same }; changed = true; }
    else if (s.figma !== f.figma || s.code !== f.code) {
      const side = s.figma !== f.figma && s.code !== f.code ? 'both' : s.figma !== f.figma ? 'figma' : 'code';
      s.moves = [...(s.moves ?? []), { at, side, ...(s.same ? { lead: true } : {}) }].slice(-MAX_MOVES);
      Object.assign(s, { figma: f.figma, code: f.code, same: !!f.same });
      changed = true;
    }
    if (!f.same) continue;
    recorded++;
    const prev = agreed.facts[f.key];
    if (prev && prev.figma === f.figma && prev.code === f.code) continue;   // same agreement: keep its date
    agreed.facts[f.key] = { figma: f.figma, code: f.code, at, ...(commit ? { commit } : {}) };
    changed = true;
  }
  if (changed) {
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(root, file), JSON.stringify({ version: 1, $description: 'What Figma and the code last agreed on, per fact, and the recent moves of each side. Written by rms-figma-code-parity; commit it.', facts: sorted(agreed.facts), seen: sorted(agreed.seen) }, null, 1) + '\n');
  }
  return { recorded, changed, agreed };
}

// Facts whose moving side keeps switching (figma, code, figma, code): nobody has decided who owns them.
export function churn(agreed, { min = 3 } = {}) {
  const out = [];
  for (const [key, s] of Object.entries(agreed?.seen ?? {})) {
    const sides = (s.moves ?? []).map((m) => m.side);
    const switches = sides.slice(1).filter((x, i) => x !== sides[i]).length;
    if (switches >= min) out.push({ key, switches, sides });
  }
  return out.sort((a, b) => b.switches - a.switches || a.key.localeCompare(b.key));
}

// The area a fact belongs to, for "who moved first".
export function areaOf(key) {
  if (key.startsWith('token ')) return 'tokens';
  const field = key.split(' · ').slice(1).join(' · ');
  if (/while disabled|\([^)]*=/.test(field)) return 'states and variants';
  if (/^layer\b/.test(field)) return 'layers';
  if (/padding|gap|margin/.test(field)) return 'spacing';
  if (/font|line height|letter spacing|text case/.test(field)) return 'typography';
  if (/background|colou?r|stroke|fill|opacity/.test(field)) return 'colour';
  if (/height|width|radius/.test(field)) return 'size and shape';
  return 'other';
}

// Per area, over the last `days` days: how often each side moved first (broke an agreement).
export function leaders(agreed, { now = Date.now(), days = 30 } = {}) {
  const since = now - days * 864e5;
  const by = {};
  for (const [key, s] of Object.entries(agreed?.seen ?? {})) {
    for (const m of s.moves ?? []) {
      if (!m.lead || !(Date.parse(m.at) >= since)) continue;
      const a = (by[areaOf(key)] ??= { figma: 0, code: 0, both: 0, total: 0 });
      a[m.side]++; a.total++;
    }
  }
  return by;
}

export function leadersLine(by) {
  const pct = (n, t) => `${Math.round((100 * n) / t)}%`;
  return Object.entries(by).sort(([, a], [, b]) => b.total - a.total).map(([area, a]) =>
    `${area} ${[a.figma && `Figma ${pct(a.figma, a.total)}`, a.code && `code ${pct(a.code, a.total)}`, a.both && `both ${pct(a.both, a.total)}`].filter(Boolean).join(' · ')} of ${a.total}`).join('; ');
}

function headCommit(root) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
