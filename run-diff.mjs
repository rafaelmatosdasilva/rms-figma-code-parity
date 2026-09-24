// run-diff.mjs - what changed since the last run. The audit records the findings it printed; the
// next run lists the ones that are new, the ones that are gone, and the ones whose count or value
// moved, so a long report still says at a glance what this change did.
//
// A finding is a line the report printed in a failing or warning place:
//   • a failing gate's name, its lines that are not passes, and every ❌ or ⚠️ line under any gate;
//   • after the verdict, every listed item (indented, or a • bullet) under a ⚠️/❌/ℹ️ heading.
// Headers and counts vary with the numbers in them, so each finding is keyed by its section and its
// own text. Two findings whose text differs only in numbers are one finding that changed.
// Pure: the audit reads and writes the file.

const ANSI = /\x1b\[[0-9;]*m/g;
const GATE = /^(✅|❌|⚠️|⏭)\s+\[(\d+)\]\s+(.+?)(?:\s{2}\(.*)?$/;
const HEADING = /^(⚠️|ℹ️|❌|✅|📌)\s+(?:\[[^\]]+\]\s+)?([^:]+?)(?::|$)/;
// A zero count on a fail line is not a finding: "❌ FAIL  0", "❌ MISSING  0 selectors".
export const ZERO_FAIL = /^❌\s+[A-Z][A-Z ?]*?\s+0(\s|$)/;

export function collectFindings(lines) {
  const out = new Set();
  let phase = 'gates', section = null, sectionBad = false;
  for (const raw of lines) {
    for (const l0 of String(raw).replace(ANSI, '').split('\n')) {
      const line = l0.replace(/\s+$/, '');
      const t = line.trim();
      if (!t) continue;
      if (/^(PARITY  ·|GATE SUMMARY)/.test(t)) { phase = 'skip'; continue; }
      if (/^(AUDIT FAILED|ALL GATES PASS|EVERY GATE THAT RAN|NO REGRESSIONS)/.test(t)) { phase = 'advisory'; section = null; continue; }
      if (/^(AI-READINESS SCORECARD|📓|📐)/.test(t)) { section = null; continue; }
      if (phase === 'gates') {
        const g = line.match(GATE);
        if (g) { section = g[3].trim(); sectionBad = g[1] === '❌'; if (sectionBad) out.add(`${section} :: gate fails`); continue; }
        if (!section || ZERO_FAIL.test(t)) continue;
        if (/^(❌|⚠️|✗)/.test(t) || (sectionBad && !/✓|^(✅|ℹ️|➡️)/.test(t))) out.add(`${section} :: ${t}`);
      } else if (phase === 'advisory') {
        if (/^─/.test(t)) { section = t.includes('Accessibility') ? 'Accessibility' : section; continue; }
        const h = !/^\s/.test(line) && line.match(HEADING);
        if (h) { section = h[2].replace(/\d+/g, '#').trim(); continue; }
        if (section && (/^\s{4,}\S/.test(line) || t.startsWith('•')) && !/^(Why it matters|What to do|Run with|Want the exact)/.test(t)) out.add(`${section} :: ${t}`);
      }
    }
  }
  return [...out];
}

const shape = (k) => k.replace(/-?\d+(\.\d+)?/g, '#');

export function diffFindings(prev, cur) {
  const p = new Set(prev), c = new Set(cur);
  let added = cur.filter((k) => !p.has(k));
  let gone = prev.filter((k) => !c.has(k));
  const changed = [];
  const goneByShape = new Map();
  for (const k of gone) { const s = shape(k); if (!goneByShape.has(s)) goneByShape.set(s, []); goneByShape.get(s).push(k); }
  added = added.filter((k) => {
    const same = goneByShape.get(shape(k));
    if (!same?.length) return true;
    changed.push({ from: same.shift(), to: k });
    return false;
  });
  const moved = new Set(changed.map((x) => x.from));
  gone = gone.filter((k) => !moved.has(k));
  return { added, gone, changed };
}

export function diffReport(d, { max = 15 } = {}) {
  const lines = [];
  const list = (icon, items, fmt) => {
    for (const x of items.slice(0, max)) lines.push(`     ${icon} ${fmt(x)}`);
    if (items.length > max) lines.push(`       … ${items.length - max} more`);
  };
  const tail = (k) => k.split(' :: ').slice(1).join(' :: ');
  const head = (k) => k.split(' :: ')[0];
  list('new     ', d.added, (k) => `${head(k)}: ${tail(k)}`);
  list('gone    ', d.gone, (k) => `${head(k)}: ${tail(k)}`);
  list('changed ', d.changed, (x) => `${head(x.to)}: ${tail(x.from)}  →  ${tail(x.to)}`);
  return lines;
}
