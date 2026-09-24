// rtl-check.mjs - properties that do not mirror in a right-to-left language (opt-in: ds-config
// rtl: true). A component padded 8px on the left and 16px on the right in English keeps that in
// Arabic or Hebrew, where it should flip. Logical properties flip on their own.
//
// Reported, per rule, with its file and line and the logical property to use:
//   • padding / margin / border on one physical side that the other side does not match;
//   • a four-value padding or margin whose right and left differ;
//   • left / right offsets, text-align: left|right, float: left|right.
// Symmetric values (the same on both sides) mirror trivially and are not reported.
// Pure: sources are [{ file, text }], as css-source.mjs loadCssSources returns them.
import { walkCss } from './css-source.mjs';

const SIDE = /^(padding|margin|border)-(left|right)(-(width|color|style))?$/;
const LOGICAL = { left: 'inline-start', right: 'inline-end' };

export function rtlFindings(sources) {
  const out = [];
  for (const { file, text } of sources ?? []) {
    for (const rule of walkCss(text, file)) {
      const decls = rule.decls ?? [];
      const byProp = new Map(decls.map((d) => [d.prop, d]));
      const sel = rule.selectors?.join(', ') ?? '';
      const add = (d, use) => out.push({ selector: sel, at: `${file}:${d.line}`, property: `${d.prop}: ${d.value}`, use });
      for (const d of decls) {
        const m = d.prop.match(SIDE);
        if (m) {
          const other = byProp.get(`${m[1]}-${m[2] === 'left' ? 'right' : 'left'}${m[3] ?? ''}`);
          if (!other || other.value !== d.value) add(d, `${m[1]}-${LOGICAL[m[2]]}${m[3] ?? ''}`);
          continue;
        }
        if (d.prop === 'padding' || d.prop === 'margin') {
          const parts = d.value.split(/\s+(?![^(]*\))/);
          if (parts.length === 4 && parts[1] !== parts[3]) add(d, `${d.prop}-block and ${d.prop}-inline (or -inline-start / -inline-end)`);
          continue;
        }
        if ((d.prop === 'left' || d.prop === 'right') && !/^(auto|0|0px)$/.test(d.value) && !(byProp.get(d.prop === 'left' ? 'right' : 'left')?.value === d.value)) add(d, `inset-${LOGICAL[d.prop]}`);
        else if (d.prop === 'text-align' && /^(left|right)$/.test(d.value)) add(d, `text-align: ${d.value === 'left' ? 'start' : 'end'}`);
        else if (d.prop === 'float' && /^(left|right)$/.test(d.value)) add(d, `float: ${LOGICAL[d.value]}`);
      }
    }
  }
  return out;
}
