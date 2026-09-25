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

// Burndown (idea I45): the open findings per component, most first, so a library is worked down one
// component at a time with --component. A finding belongs to the most specific component named in its
// text (buttonPrimary before button; "button-primary" and "radii/chip" count). A gate's own "gate fails"
// line is not a finding of any component. `prev` (the last run's findings for the same scope) gives the
// count each component had then.
const words = (name) => [name, name.replace(/([a-z0-9])([A-Z])/g, '$1-$2')].map((x) => x.toLowerCase());
export function componentOf(finding, names) {
  const text = String(finding).toLowerCase();
  let best = null;
  for (const n of names) {
    const hit = words(n).some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text));
    if (hit && (!best || n.length > best.length)) best = n;
  }
  return best;
}

export function burndown(findings, names, prev = null) {
  const count = (list) => {
    const by = new Map();
    let loose = 0;
    for (const f of list ?? []) {
      if (/ :: gate fails$/.test(f) || / :: (🔗|↳)/.test(f)) continue;   // a gate's own verdict, a link or a note
      const c = componentOf(f, names);
      if (c) by.set(c, (by.get(c) ?? 0) + 1); else loose++;
    }
    return { by, loose };
  };
  const now = count(findings), was = prev ? count(prev) : null;
  const rows = [...now.by].map(([name, open]) => ({ name, open, was: was ? (was.by.get(name) ?? 0) : null }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  const done = was ? [...was.by.keys()].filter((n) => !now.by.has(n)).sort() : [];
  return { rows, loose: now.loose, done };
}

export function burndownLines(b, { top = 8, scoped = false } = {}) {
  if (!b.rows.length && !b.done.length) return [];
  const fmt = (r) => `${r.name} ${r.open}${r.was != null && r.was !== r.open ? ` (was ${r.was})` : ''}`;
  const lines = [`Burndown, open findings per component: ${b.rows.slice(0, top).map(fmt).join(' · ') || 'none'}${b.rows.length > top ? ` · ${b.rows.length - top} more` : ''}${b.loose ? ` · ${b.loose} not tied to a component` : ''}`];
  if (b.done.length) lines.push(`   cleared since the last run: ${b.done.join(', ')}`);
  if (b.rows.length && !scoped) lines.push(`   next up: ${b.rows[0].name}. Run with --component ${b.rows[0].name}, fix, run again.`);
  return lines;
}
