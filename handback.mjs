// handback.mjs - every measured difference says which way to send it back (idea I48).
//
//   • Figma moved (or no record of an agreement): the code is behind. The change to the declaration at
//     the rule's file:line is written as a patch, .parity-out/handback/code-changes.diff, which a person
//     applies with `git apply` (or not). Only single-value declarations are patched; the rest are listed.
//   • Code moved: Figma is behind. The Figma change (component, variant, property, value) is listed in
//     .parity-out/handback/figma-changes.md, with a link to the component.
//   • Both moved: a person decides; listed in the Figma list as a decision.
// Nothing is ever applied here.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The CSS value Figma asks for: its variable when Figma names a token, else its value.
export function wantOf(d) {
  if (d.expectedVar) return `var(${d.expectedVar})`;
  if (d.suggestVar) return `var(${d.suggestVar})`;
  if (d.figmaValue != null && typeof d.figmaValue !== 'object') return String(d.figmaValue);
  if (typeof d.figma === 'number') return `${d.figma}px`;
  if (/^-?[\d.]+(px|%)?$/.test(String(d.figma))) return String(d.figma);
  return null;
}

// Which declarations a field lives in. `slot` picks a value inside a shorthand: 0 = first, 1 = second.
const FIELD_PROPS = [
  [/^gap\b/, [['gap'], ['column-gap'], ['row-gap']]],
  [/^padding \(top\/bottom\)/, [['padding-block'], ['padding', 0]]],
  [/^padding \(left\/right\)/, [['padding-inline'], ['padding', 1]]],
  [/^padding top\b/, [['padding-top']]], [/^padding bottom\b/, [['padding-bottom']]],
  [/^padding left\b/, [['padding-left']]], [/^padding right\b/, [['padding-right']]],
  [/^radius\b/, [['border-radius']]],
  [/^(min )?height\b/, [['height'], ['min-height']]],
  [/^width\b/, [['width']]],
  [/^font size\b/, [['font-size']]],
  [/^line height\b/, [['line-height']]],
  [/^letter spacing\b/, [['letter-spacing']]],
];

// The patched line, or null when the line holds no declaration this field can change safely.
export function patchLine(line, field, want) {
  const rule = FIELD_PROPS.find(([re]) => re.test(field));
  if (!rule || !want) return null;
  for (const [prop, slot] of rule[1]) {
    const m = line.match(new RegExp(`(^|[\\s;{])(${prop})(\\s*:\\s*)([^;}]+?)(\\s*(!important)?\\s*)(;|}|$)`));
    if (!m) continue;
    const parts = m[4].trim().split(/\s+(?![^(]*\))/);
    let value;
    if (slot == null) { if (parts.length !== 1) return null; value = want; }
    else if (parts.length === 2) { parts[slot] = want; value = parts.join(' '); }
    else if (parts.length === 1 && slot === 0) return null;   // a one-value shorthand sets both axes: by hand
    else return null;
    const start = m.index + m[1].length;
    return line.slice(0, start) + m[2] + m[3] + value + line.slice(start + m[2].length + m[3].length + m[4].length);
  }
  return null;
}

// A unified diff for the patchable differences (one hunk per changed line, one line of context).
export function codePatch(root, diffs) {
  const byFile = new Map(), manual = [];
  for (const d of diffs) {
    const m = String(d.at ?? '').match(/^(.+):(\d+)$/);
    const want = wantOf(d);
    if (!m || !want) { manual.push(d); continue; }
    let text;
    try { text = readFileSync(resolve(root, m[1]), 'utf8'); } catch { manual.push(d); continue; }
    const lines = text.split('\n'), n = Number(m[2]);
    const next = patchLine(lines[n - 1] ?? '', d.field, want);
    if (next == null || next === lines[n - 1]) { manual.push(d); continue; }
    if (!byFile.has(m[1])) byFile.set(m[1], { lines, changes: new Map() });
    byFile.get(m[1]).changes.set(n, next);
  }
  let out = '';
  for (const [file, { lines, changes }] of byFile) {
    out += `--- a/${file}\n+++ b/${file}\n`;
    // Changed lines close together share one hunk, so hunks never overlap.
    const ns = [...changes.keys()].sort((a, b) => a - b);
    const groups = [];
    for (const n of ns) { const g = groups[groups.length - 1]; if (g && n - g[g.length - 1] <= 2) g.push(n); else groups.push([n]); }
    for (const g of groups) {
      const from = Math.max(1, g[0] - 1), to = Math.min(lines.length, g[g.length - 1] + 1);
      const ctx = [];
      for (let i = from; i <= to; i++) {
        if (changes.has(i)) ctx.push(`-${lines[i - 1]}`, `+${changes.get(i)}`);
        else ctx.push(` ${lines[i - 1]}`);
      }
      const len = to - from + 1;
      out += `@@ -${from},${len} +${from},${len} @@\n${ctx.join('\n')}\n`;
    }
  }
  return { diff: out, patched: [...byFile.values()].reduce((k, f) => k + f.changes.size, 0), manual };
}

// The Figma side: what to change in the design, per component.
export function figmaChanges(items, linkFor = () => null) {
  const rows = ['# Figma changes to make', '', 'Proposed by rms-figma-code-parity. Nothing was changed in Figma.', ''];
  const by = new Map();
  for (const it of items) { if (!by.has(it.d.component)) by.set(it.d.component, []); by.get(it.d.component).push(it); }
  for (const [comp, list] of by) {
    const u = linkFor(comp);
    rows.push(`## ${comp}${u ? `  ([open in Figma](${u}))` : ''}`, '');
    for (const { d, moved } of list) {
      const code = `${d.code}${d.codeVar ? ` via ${d.codeVar}` : ''}`;
      rows.push(moved === 'both-moved'
        ? `- **${d.field}**: both sides changed since they agreed. Figma ${d.figma}${d.figmaValue ? ` (${d.figmaValue})` : ''}, code ${code}${d.at ? ` (${d.at})` : ''}. Decide which wins.`
        : `- **${d.field}**: set it to ${d.codeVar ? `the token behind ${d.codeVar}` : code} (now ${d.figma}${d.figmaValue ? `, ${d.figmaValue}` : ''})${d.at ? `. Code: ${d.at}` : ''}`);
    }
    rows.push('');
  }
  return rows.join('\n');
}

// Writes both files (or removes them when there is nothing to hand back). Returns what it wrote.
export function writeHandback(root, outDir, { codeDiffs, figmaItems, linkFor }) {
  const dir = join(root, outDir, 'handback');
  const res = { code: null, figma: null, patched: 0, manual: [] };
  rmSync(dir, { recursive: true, force: true });
  if (!codeDiffs.length && !figmaItems.length) return res;
  mkdirSync(dir, { recursive: true });
  if (codeDiffs.length) {
    const p = codePatch(root, codeDiffs);
    res.patched = p.patched; res.manual = p.manual;
    if (p.diff) { writeFileSync(join(dir, 'code-changes.diff'), p.diff); res.code = join(outDir, 'handback', 'code-changes.diff'); }
  }
  if (figmaItems.length) { writeFileSync(join(dir, 'figma-changes.md'), figmaChanges(figmaItems, linkFor)); res.figma = join(outDir, 'handback', 'figma-changes.md'); }
  return res;
}
