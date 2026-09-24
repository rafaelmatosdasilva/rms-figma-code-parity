// capture-compare.mjs - compare the code capture with the Figma snapshots, field by field.
//
// Two uses:
//   • calibration: on a project whose parity is green, Figma and code already agree, so every
//     difference found here is a bug in the code capture, not in the project;
//   • the foundation for the authoring model: the same neutral comparison works whichever side
//     leads (the author decides who is behind, this module only says what differs).
//
// Tokens: every Figma colour and sizing token (per mode) through the project's own naming
// (parity-map.mjs EXPLICIT / EXPLICIT_SIZING, else naming-convention.mjs), and the text scale
// through parity-map TYPO. Components: height, padding, gap, radius, font size and weight,
// fill structure and default stroke, from figma-structure.snapshot.json.
// A code fact the capture could not read reliably is "not comparable", never a difference.

import { pathHash } from './icon-source.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNamingSpec, tokenToVar } from './naming-convention.mjs';
import { sameValue } from './component-capture.mjs';

export async function loadParityMaps(ROOT, cfg) {
  const p = resolve(ROOT, cfg.paths?.parityMap ?? 'parity-map.mjs');
  let m = {};
  if (existsSync(p)) { try { m = await import(pathToFileURL(p).href); } catch { /* optional */ } }
  return {
    EXPLICIT: m.EXPLICIT ?? {}, EXPLICIT_SIZING: m.EXPLICIT_SIZING ?? {},
    SKIP_TOKENS: m.SKIP_TOKENS ?? new Set(), NULL_TOKENS: m.NULL_TOKENS ?? new Set(), KNOWN_NULL: m.KNOWN_NULL ?? new Set(),
    SIZING_SKIP: m.SIZING_SKIP ?? new Map(), TYPO: m.TYPO ?? {},
  };
}

const toNum = (v) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };
const isColor = (v) => /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|color\(|transparent$)/i.test(String(v ?? '').trim());
const valueMatch = (a, b) => {
  const kind = isColor(a) || isColor(b) ? 'color' : 'height';
  return sameValue(kind, String(a).trim(), String(b).trim());
};

// Tokens: Figma value vs the code capture's resolved value for the mapped CSS var, per mode.
export function compareTokens(code, vars, cfg, maps) {
  const spec = resolveNamingSpec(cfg);
  const out = { match: 0, differ: [], missingInCode: [], notComparable: [], skipped: 0 };
  const check = (token, cssVar, mode, figmaValue) => {
    const fact = code.tokens?.[cssVar]?.modes?.[mode];
    if (!fact) { out.missingInCode.push({ token, cssVar, mode }); return; }
    if (fact.confidence === 'uncertain') { out.notComparable.push({ token, cssVar, mode, why: 'the code reading is uncertain' }); return; }
    const same = valueMatch(figmaValue, fact.value);
    if (same === true) out.match++;
    else if (same === null) out.notComparable.push({ token, cssVar, mode, figma: figmaValue, code: fact.value, why: 'values are not comparable' });
    else out.differ.push({ token, cssVar, mode, figma: figmaValue, code: fact.value, at: code.tokens[cssVar].declaredAt });
  };
  // Token names resolve exactly as Gate 3 resolves them: the trailing "/color" is dropped first
  // (when the naming convention drops it), then parity-map EXPLICIT, then the convention.
  const dropColor = (spec.dropSegments ?? []).includes('color');
  for (const [mode, tokens] of Object.entries(vars.color ?? {})) {
    for (const [key, value] of Object.entries(tokens ?? {})) {
      const token = dropColor ? key.replace(/\/color$/, '') : key;
      if (maps.SKIP_TOKENS.has(token) || maps.NULL_TOKENS.has(token) || value == null) { out.skipped++; continue; }
      const cssVar = Object.prototype.hasOwnProperty.call(maps.EXPLICIT, token) ? maps.EXPLICIT[token] : tokenToVar(token, spec);
      if (!cssVar) { out.skipped++; continue; }   // the project maps it to no variable on purpose
      check(token, cssVar, mode, value);
    }
  }
  const firstMode = Object.keys(code.tokens ? Object.values(code.tokens)[0]?.modes ?? {} : {})[0] ?? 'light';
  for (const [token, value] of Object.entries(vars.sizing ?? {})) {
    if (maps.SIZING_SKIP.has(token) || value == null) { out.skipped++; continue; }
    check(token, maps.EXPLICIT_SIZING[token] ?? tokenToVar(token, spec, { raw: true }), firstMode, value);
  }
  for (const [cssVar, [scale, prop]] of Object.entries(maps.TYPO)) {
    const value = vars.typography?.[scale]?.[prop];
    if (value == null) { out.skipped++; continue; }
    check(`typography/${scale}/${prop}`, cssVar, firstMode, value);
  }
  return out;
}

// Components: each Figma structure field against the measured and traced code facts.
export function compareComponents(code, structure, vars, cfg, maps) {
  const spec = resolveNamingSpec(cfg);
  const sizeVar = (t) => (t ? maps.EXPLICIT_SIZING[t] ?? tokenToVar(t, spec, { raw: true }) : null);
  const out = { match: 0, differ: [], notComparable: [], notCaptured: [] };
  const push = (comp, field, figma, fact, extra = {}) => {
    if (!fact || fact.confidence === 'not-read' || fact.confidence === 'uncertain') {
      out.notComparable.push({ component: comp, field, figma, why: fact?.why ?? (fact?.confidence === 'uncertain' ? 'the code reading is uncertain' : 'not read in code') });
      return;
    }
    const byVar = extra.expectedVar && fact.var === extra.expectedVar;
    const byValue = extra.figmaValue != null ? valueMatch(extra.figmaValue, fact.value) : null;
    if (byVar || byValue === true) { out.match++; return; }
    out.differ.push({ component: comp, field, figma, figmaValue: extra.figmaValue ?? undefined, code: fact.value, codeVar: fact.var ?? null, expectedVar: extra.expectedVar ?? undefined, rule: fact.rule, at: fact.at });
  };
  for (const [name, f] of Object.entries(structure ?? {})) {
    const c = code.components?.[name];
    if (!c) { out.notCaptured.push(name); continue; }
    const low = c.confidence === 'low' || c.confidence === 'static-only';   // no measured box or fill
    // Height: only where the code fixes it (a height or min-height rule). Otherwise the code's
    // height follows its content, and Figma's h is just the height of its sample frame.
    // A fixed height is compared as the drawn box; a min-height (which lets content grow the box)
    // is compared as its own declared value.
    if (f.h != null) {
      const h = c.props?.height, mh = c.props?.minHeight;
      const setsHeight = h?.rule && h.confidence !== 'default' && toNum(h.value) > 0 && !/min-height|max-height/.test(h.note ?? '');
      const setsMin = mh?.rule && mh.confidence !== 'default' && toNum(mh.value) > 0;
      if (setsHeight && c.size?.height != null) {
        if (Math.abs(c.size.height - f.h) < 0.5) out.match++;
        else out.differ.push({ component: name, field: 'height', figma: f.h, code: c.size.height, rule: h.rule, at: h.at });
      } else if (setsMin) {
        if (Math.abs(toNum(mh.value) - f.h) < 0.5) out.match++;
        else out.differ.push({ component: name, field: 'min height', figma: f.h, code: toNum(mh.value), rule: mh.rule, at: mh.at });
      } else out.notComparable.push({ component: name, field: 'height', figma: f.h, why: 'the code height follows its content' });
    }
    const tokenValue = (t) => (t ? vars.sizing?.[t] ?? null : null);
    // The design's default variant has a label; if every instance in the code is icon-only, its
    // padding belongs to the icon-only variant and says nothing about the labelled one.
    const iconOnly = c.instance && c.instance.hasText === false && f.fontSizeVar;
    const pad = (x) => (iconOnly ? { confidence: 'not-read', why: 'only icon-only instances were found; the design default has a label' } : x);
    if (f.paddingVar?.lr) push(name, 'padding (left/right)', f.paddingVar.lr, pad(c.props?.paddingLeft), { expectedVar: sizeVar(f.paddingVar.lr), figmaValue: tokenValue(f.paddingVar.lr) });
    if (f.paddingVar?.tb) push(name, 'padding (top/bottom)', f.paddingVar.tb, pad(c.props?.paddingTop), { expectedVar: sizeVar(f.paddingVar.tb), figmaValue: tokenValue(f.paddingVar.tb) });
    const gp = c.parts?.gap?.props ?? c.props;
    if (f.gapVar) {
      const g = [gp?.columnGap, gp?.rowGap].find((x) => x?.var === sizeVar(f.gapVar) || valueMatch(tokenValue(f.gapVar), x?.value) === true) ?? gp?.columnGap;
      push(name, 'gap', f.gapVar, g, { expectedVar: sizeVar(f.gapVar), figmaValue: tokenValue(f.gapVar) });
    }
    if (f.innerRadiusVar) {
      // A fill drawn on ::before carries the radius there.
      const r = c.parts?.radius?.props?.borderTopLeftRadius
        ?? (f.fillStructure === 'before' && c.before && toNum(c.before.borderTopLeftRadius) > 0 ? { value: c.before.borderTopLeftRadius, confidence: 'verified' } : c.props?.borderTopLeftRadius);
      push(name, 'radius', f.innerRadiusVar, r, { expectedVar: sizeVar(f.innerRadiusVar), figmaValue: tokenValue(f.innerRadiusVar) });
    }
    const ty = (k) => vars.typography?.[k] ?? null;
    // Font: Figma's font fields describe the component's first TEXT node, so the code side is the
    // contract's fontSel part, else the first element holding text, else the root.
    const fp = c.parts?.font?.props ?? c.parts?.text?.props ?? c.props;
    if (f.fontSizeVar && ty(f.fontSizeVar)) push(name, 'font size', f.fontSizeVar, fp?.fontSize, { figmaValue: ty(f.fontSizeVar).size });
    if (f.fontWeightVar && ty(f.fontWeightVar)) push(name, 'font weight', f.fontWeightVar, fp?.fontWeight, { figmaValue: ty(f.fontWeightVar).weight });
    // Background: does the component paint one? Figma often draws it on a child layer and code on the
    // element itself; both paint. Only "paints" vs "does not paint" is a difference.
    // A colour set in the element's own style attribute is page content (a swatch showing its colour),
    // not the component's design, so it is not compared.
    const inlineFill = /\(style attribute\)/.test(String(c.props?.backgroundColor?.rule ?? ''));
    if (f.fillStructure && !low && !inlineFill) {
      const paints = (x) => x === 'direct' || x === 'before';
      if (paints(f.fillStructure) === paints(c.fill)) out.match++;
      else out.differ.push({ component: name, field: 'background', figma: paints(f.fillStructure) ? 'paints a background' : 'no background', code: paints(c.fill) ? 'paints a background' : 'no background', rule: c.props?.backgroundColor?.rule, at: c.props?.backgroundColor?.at });
    }
  }
  return out;
}

// Icons: each Figma icon (figma-icons.snapshot.json, keyed by sprite id) against the code's symbol of
// the same id, by viewBox and path data. Code-only symbols are counted (they may be app icons).
export function compareIcons(code, figmaIcons) {
  const out = { match: 0, differ: [], missingInCode: [], codeOnly: 0 };
  const icons = code.icons ?? {};
  for (const [id, f] of Object.entries(figmaIcons ?? {})) {
    if (id.startsWith('_') || !f || typeof f !== 'object' || Array.isArray(f)) continue;   // an inventory list is not an icon
    const c = icons[id];
    if (!c) { out.missingInCode.push(id); continue; }
    const diffs = [];
    if (f.viewBox && c.viewBox && f.viewBox !== c.viewBox) diffs.push(`viewBox Figma ${f.viewBox}, code ${c.viewBox}`);
    if (Array.isArray(f.paths) && pathHash(f.paths) !== c.pathHash) diffs.push(`path data differs (Figma ${f.paths.length} path(s), code ${c.paths})`);
    if (diffs.length) out.differ.push({ id, what: diffs.join(' · '), at: c.definedAt?.[0] });
    else out.match++;
  }
  out.codeOnly = Object.keys(icons).filter((id) => !(id in (figmaIcons ?? {}))).length;
  return out;
}

// Nesting: the sub-components Figma nests in each component (component-composition.snapshot.json)
// against what the code nests (rendered page or source). A parent never seen in the code is not
// comparable; a child Figma nests that the code never shows inside it is a difference.
export function compareNesting(code, composition) {
  const out = { match: 0, differ: [], notComparable: [], codeOnly: [] };
  const nest = code.nesting ?? {};
  const skip = (n) => /^icon[-/ ]/i.test(n) || String(n).startsWith('.');
  for (const [parent, list] of Object.entries(composition ?? {})) {
    if (parent.startsWith('_') || !Array.isArray(list)) continue;
    const kids = list.filter((k) => k !== parent && !skip(k));
    if (!kids.length) continue;
    const seen = nest[parent];
    if (!seen) { out.notComparable.push({ parent, why: 'not seen in the code' }); continue; }
    for (const k of kids) {
      if (seen.contains?.[k]) out.match++;
      else out.differ.push({ parent, child: k, figma: 'nests it', code: seen.instancesSeen ? `not inside any of ${seen.instancesSeen} rendered instance(s)` : 'not in its source' });
    }
    for (const k of Object.keys(seen.contains ?? {})) if (!kids.includes(k) && !skip(k)) out.codeOnly.push({ parent, child: k });
  }
  return out;
}

export async function compareCapture(ROOT, cfg, code, { readJSON }) {
  const vars = readJSON(resolve(ROOT, cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json')) ?? {};
  const structure = readJSON(resolve(ROOT, cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json'))?.components ?? {};
  const figmaIcons = cfg.paths?.snapshotIcons ? readJSON(resolve(ROOT, cfg.paths.snapshotIcons)) : null;
  const composition = readJSON(resolve(ROOT, 'component-composition.snapshot.json'));
  const maps = await loadParityMaps(ROOT, cfg);
  return {
    tokens: compareTokens(code, vars, cfg, maps),
    components: compareComponents(code, structure, vars, cfg, maps),
    ...(figmaIcons ? { icons: compareIcons(code, figmaIcons) } : {}),
    ...(composition ? { nesting: compareNesting(code, composition) } : {}),
  };
}

export function compareReport(r) {
  const t = r.tokens, c = r.components;
  const lines = ['Code capture vs Figma'];
  lines.push(`  tokens      ${t.match} match · ${t.differ.length} differ · ${t.missingInCode.length} missing in code · ${t.notComparable.length} not comparable · ${t.skipped} skipped by the project`);
  lines.push(`  components  ${c.match} match · ${c.differ.length} differ · ${c.notComparable.length} not comparable · ${c.notCaptured.length} not captured`);
  for (const d of t.differ.slice(0, 20)) lines.push(`    ✗ token ${d.token} (${d.mode}) → ${d.cssVar}: Figma ${d.figma}, code ${d.code}${d.at ? `  (${d.at})` : ''}`);
  for (const d of t.missingInCode.slice(0, 20)) lines.push(`    ✗ token ${d.token} (${d.mode}) → ${d.cssVar}: not in the code`);
  if (r.icons) lines.push(`  icons       ${r.icons.match} match · ${r.icons.differ.length} differ · ${r.icons.missingInCode.length} missing in code · ${r.icons.codeOnly} only in code`);
  if (r.nesting) lines.push(`  nesting     ${r.nesting.match} match · ${r.nesting.differ.length} differ · ${r.nesting.notComparable.length} not comparable · ${r.nesting.codeOnly.length} only in code`);
  for (const d of c.differ.slice(0, 30)) lines.push(`    ✗ ${d.component} ${d.field}: Figma ${d.figma}${d.figmaValue ? ` (${d.figmaValue})` : ''}, code ${d.code}${d.codeVar ? ` via ${d.codeVar}` : ''}${d.at ? `  (${d.rule} · ${d.at})` : ''}`);
  for (const d of (r.icons?.differ ?? []).slice(0, 20)) lines.push(`    ✗ icon #${d.id}: ${d.what}${d.at ? `  (${d.at})` : ''}`);
  for (const id of (r.icons?.missingInCode ?? []).slice(0, 20)) lines.push(`    ✗ icon #${id}: not in the code`);
  for (const d of (r.nesting?.differ ?? []).slice(0, 20)) lines.push(`    ✗ ${d.parent} → ${d.child}: Figma nests it, code ${d.code}`);
  return lines.join('\n');
}
