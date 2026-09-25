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
import { parseColor, colorHex } from './css-values.mjs';

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

// A Figma colour token's CSS variable, resolved the way Gate 3 resolves it.
export function colorVarOf(token, spec, maps) {
  const dropColor = (spec.dropSegments ?? []).includes('color');
  const t = dropColor ? String(token).replace(/\/color$/, '') : token;
  return Object.prototype.hasOwnProperty.call(maps.EXPLICIT, t) ? maps.EXPLICIT[t] : tokenToVar(t, spec);
}
// A Figma paint ({ token, hex, opacity }) as the colour it draws in one mode, opacity included.
function paintIn(vars, mode, paint) {
  if (!paint) return null;
  const t = paint.token;
  const v = t ? (vars.color?.[mode]?.[t] ?? vars.color?.[mode]?.[String(t).replace(/\/color$/, '')] ?? vars.color?.[mode]?.[`${t}/color`]) : paint.hex;
  const c = parseColor(v);
  if (!c) return null;
  const a = c[3] * (typeof paint.opacity === 'number' ? paint.opacity : 1);
  return colorHex(`rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`);
}
const axesOf = (name) => Object.fromEntries(String(name).split(',').map((p) => p.split('=').map((x) => x.trim().toLowerCase())).filter((p) => p.length === 2));

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
    out.differ.push({ component: comp, field, figma, figmaValue: extra.figmaValue ?? undefined, code: fact.value, codeVar: fact.var ?? null, expectedVar: extra.expectedVar ?? undefined, rule: fact.rule, at: fact.at, confidence: fact.confidence });
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
    // Padding: both sides of each axis (a component padded on one side only is a difference).
    const bothSides = (label, token, [a, b]) => {
      if (!token) return;
      const extra = { expectedVar: sizeVar(token), figmaValue: tokenValue(token) };
      const fa = pad(c.props?.[a]), fb = pad(c.props?.[b]);
      const bad = [fa, fb].find((x) => x && x.confidence !== 'not-read' && x.confidence !== 'uncertain' && !(x.var === extra.expectedVar || valueMatch(extra.figmaValue, x.value) === true));
      push(name, label, token, bad ?? fa, extra);
    };
    bothSides('padding (left/right)', f.paddingVar?.lr, ['paddingLeft', 'paddingRight']);
    bothSides('padding (top/bottom)', f.paddingVar?.tb, ['paddingTop', 'paddingBottom']);
    const gp = c.parts?.gap?.props ?? c.props;
    if (f.gapVar) {
      const g = [gp?.columnGap, gp?.rowGap].find((x) => x?.var === sizeVar(f.gapVar) || valueMatch(tokenValue(f.gapVar), x?.value) === true) ?? gp?.columnGap;
      push(name, 'gap', f.gapVar, g, { expectedVar: sizeVar(f.gapVar), figmaValue: tokenValue(f.gapVar) });
    }
    if (f.innerRadiusVar) {
      // A fill drawn on ::before carries the radius there.
      const r = c.parts?.radius?.props?.borderTopLeftRadius
        ?? (f.fillStructure === 'before' && c.before && toNum(c.before.borderTopLeftRadius) > 0 ? { value: c.before.borderTopLeftRadius, confidence: 'verified' } : c.props?.borderTopLeftRadius);
      // Every corner: a component rounded on some corners only is a difference (unless Figma's
      // radius itself lives on ::before, where the top-left corner stands for the layer).
      const extra = { expectedVar: sizeVar(f.innerRadiusVar), figmaValue: tokenValue(f.innerRadiusVar) };
      const corners = c.parts?.radius?.props ?? c.props ?? {};
      const others = r === c.props?.borderTopLeftRadius || r === c.parts?.radius?.props?.borderTopLeftRadius
        ? ['borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((k) => corners[k]).filter(Boolean) : [];
      const bad = [r, ...others].find((x) => x && x.confidence !== 'not-read' && x.confidence !== 'uncertain' && !(x.var === extra.expectedVar || valueMatch(extra.figmaValue, x.value) === true));
      push(name, 'radius', f.innerRadiusVar, bad ?? r, extra);
    }
    const ty = (k) => vars.typography?.[k] ?? null;
    // Font: Figma's font fields describe the component's first TEXT node, so the code side is the
    // contract's fontSel part, else the first element holding text, else the root.
    const fp = c.parts?.font?.props ?? c.parts?.text?.props ?? c.props;
    if (f.fontSizeVar && ty(f.fontSizeVar)) push(name, 'font size', f.fontSizeVar, fp?.fontSize, { figmaValue: ty(f.fontSizeVar).size });
    if (f.fontWeightVar && ty(f.fontWeightVar)) push(name, 'font weight', f.fontWeightVar, fp?.fontWeight, { figmaValue: ty(f.fontWeightVar).weight });
    // Line height from the same text style (a unitless line height is a multiple of the font size).
    const lhText = f.text?.lineHeight;   // { unit: 'PIXELS' | 'PERCENT' | 'AUTO', value } from the extended capture
    const lhFig = lhText && lhText.unit !== 'AUTO'
      ? (lhText.unit === 'PERCENT' ? `${(lhText.value / 100) * toNum(fp?.fontSize?.value)}px` : `${lhText.value}px`)
      : (f.fontSizeVar ? ty(f.fontSizeVar)?.lh : null);
    // A line height inherited from a page-level rule (html, body, :root, *) is the page's, not the
    // component's, so it is not compared.
    const pageLevel = (r) => /^(html|body|:root|\*)(\s*,\s*(html|body|:root|\*))*$/i.test(String(r ?? '').trim());
    if (lhFig && fp?.lineHeight && fp.lineHeight.confidence !== 'default' && !(fp.lineHeight.inherited && pageLevel(fp.lineHeight.rule))) {
      const lh = fp.lineHeight, fs = toNum(fp.fontSize?.value);
      const px = /^[\d.]+$/.test(String(lh.value).trim()) && fs ? `${toNum(lh.value) * fs}px` : lh.value;
      push(name, 'line height', f.fontSizeVar, { ...lh, value: px }, { figmaValue: lhFig });
    }
    // Stroke. Figma's root stroke can be drawn on an inner layer in code, and a border can be
    // reserved for a hover state, so only the clear cases are compared: Figma strokes the default
    // variant and the code draws no visible border at all, or Figma names the sides (strokeSides)
    // and the code draws others. Borders Figma never draws are the phantom-border check's job.
    // A root that draws nothing at all (no border, no background, no radius) is a wrapper: the box
    // Figma strokes is a child element in code. That is a naming gap, not a design difference.
    const drawsNothing = ['Top', 'Right', 'Bottom', 'Left'].every((s) => toNum(c.props?.[`border${s}Width`]?.value) === 0)
      && /^(transparent|rgba\([^)]*,\s*0\))$/i.test(String(c.props?.backgroundColor?.value ?? 'transparent').trim())
      && toNum(c.props?.borderTopLeftRadius?.value) === 0;
    if (f.strokeOnDefault === true && !low && c.props?.borderTopWidth && !c.before && drawsNothing) {
      out.notComparable.push({ component: name, field: 'stroke', figma: 'draws a border', why: 'the code root draws nothing (a wrapper); name the part that draws the box in componentSelectors or the contract' });
    } else if (f.strokeOnDefault === true && !low && c.props?.borderTopWidth && !c.before) {
      const visible = (s) => { const w = c.props?.[`border${s}Width`]; return !!w && toNum(w.drawn ?? w.value) > 0; };
      const colorSeen = !/^(transparent|rgba\([^)]*,\s*0\))$/i.test(String(c.props?.borderTopColor?.value ?? '').replace(/\s+/g, ' ').trim());
      const drawn = ['Top', 'Right', 'Bottom', 'Left'].filter(visible).map((s) => s.toLowerCase());
      const named = f.strokeSides && !['all', 'none'].includes(f.strokeSides) ? [f.strokeSides] : null;
      const ok = named ? drawn.length === named.length && named.every((s) => drawn.includes(s)) : (drawn.length > 0 && colorSeen);
      if (ok) out.match++;
      else out.differ.push({ component: name, field: 'stroke', figma: named ? `border on ${named.join(', ')}` : 'draws a border', code: drawn.length && colorSeen ? `border on ${drawn.length === 4 ? 'all sides' : drawn.join(', ')}` : 'no visible border', rule: c.props?.borderTopWidth?.rule, at: c.props?.borderTopWidth?.at });
    }
    // Deeper facts from the extended Step 1c capture (present when the snapshot has them).
    // Width: a component Figma sizes FIXED must have its width fixed in code too.
    if (f.box?.sizing?.h === 'FIXED' && typeof f.box.width === 'number' && !low) {
      const w = c.props?.width;
      if (!w?.rule) out.notComparable.push({ component: name, field: 'width', figma: f.box.width, why: 'the code width follows its content or container' });
      else if (Math.abs((c.size?.width ?? toNum(w.value)) - f.box.width) < 0.5) out.match++;
      else out.differ.push({ component: name, field: 'width', figma: f.box.width, code: c.size?.width ?? toNum(w.value), rule: w.rule, at: w.at });
    }
    // Stroke weight per side, when Figma records it: each side's width, not only whether it draws.
    if (Array.isArray(f.stroke?.weights) && !low && c.props?.borderTopWidth && !drawsNothing) {
      ['Top', 'Right', 'Bottom', 'Left'].forEach((s, i) => {
        const want = f.stroke.weights[i], got = c.props?.[`border${s}Width`];
        if (typeof want !== 'number' || !got) return;
        const drawnPx = toNum(got.drawn ?? got.value), declPx = toNum(got.value);
        if (Math.abs(declPx - want) < 0.01 || Math.abs(drawnPx - want) < 0.01) out.match++;
        else out.differ.push({ component: name, field: `border ${s.toLowerCase()} width`, figma: want, code: got.value, rule: got.rule, at: got.at });
      });
    }
    // Root opacity.
    if (typeof f.opacity === 'number' && f.opacity < 1 && c.props?.opacity) push(name, 'opacity', String(f.opacity), c.props.opacity, { figmaValue: String(f.opacity) });
    // Text: family, letter spacing, text case and line height as Figma records them on the text node.
    if (f.text && fp) {
      const fs = toNum(fp.fontSize?.value);
      const fam = String(fp.fontFamily?.value ?? '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (f.text.fontFamily && fam) {
        if (fam.toLowerCase() === String(f.text.fontFamily).toLowerCase()) out.match++;
        else out.differ.push({ component: name, field: 'font family', figma: f.text.fontFamily, code: fam, rule: fp.fontFamily?.rule, at: fp.fontFamily?.at });
      }
      const ls = f.text.letterSpacing;
      if (ls && fp.letterSpacing && fs) {
        const want = ls.unit === 'PERCENT' ? (ls.value / 100) * fs : ls.value;
        const got = /normal/i.test(fp.letterSpacing.value) ? 0 : toNum(fp.letterSpacing.value);
        if (Math.abs(got - want) < 0.05) out.match++;
        else out.differ.push({ component: name, field: 'letter spacing', figma: `${+want.toFixed(2)}px`, code: fp.letterSpacing.value, rule: fp.letterSpacing.rule, at: fp.letterSpacing.at });
      }
      const CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize', ORIGINAL: 'none' };
      if (f.text.textCase && CASE[f.text.textCase] && fp.textTransform) {
        if (String(fp.textTransform.value) === CASE[f.text.textCase]) out.match++;
        else out.differ.push({ component: name, field: 'text case', figma: CASE[f.text.textCase], code: fp.textTransform.value, rule: fp.textTransform.rule, at: fp.textTransform.at });
      }
    }

    // Per state: height, stroke and opacity Figma records for each variant, against the state the
    // capture produced (labels matched without case or spaces: "State=hover" = "State=Hover").
    const key = (s) => String(s).toLowerCase().replace(/\s+/g, '');
    const states = Object.fromEntries(Object.entries(c.states ?? {}).map(([k, v]) => [key(k), v]));
    for (const [variant, h] of Object.entries(f.variantHeight ?? {})) {
      const st = states[key(variant)];
      if (!st || typeof h !== 'number') continue;
      const hh = st.changed?.height ?? st.changed?.minHeight;
      if (!hh || !hh.rule) continue;                       // same as the default, or only its content's height
      if (Math.abs(toNum(hh.value) - h) < 0.5) out.match++;
      else out.differ.push({ component: name, field: `height (${variant})`, figma: h, code: toNum(hh.value), rule: hh.rule, at: hh.at });
    }
    for (const [variant, op] of Object.entries(f.variantOpacity ?? {})) {
      const st = Object.entries(states).find(([k]) => k.includes(key(variant)))?.[1];
      const o = st?.changed?.opacity ?? null;
      if (!st || typeof op !== 'number') continue;
      const got = o ? toNum(o.value) : toNum(c.props?.opacity?.value ?? 1);
      if (Math.abs(got - op) < 0.01) out.match++;
      else out.differ.push({ component: name, field: `opacity (${variant})`, figma: op, code: got, rule: o?.rule, at: o?.at });
    }
    // Colours, from the extended Step 1c capture (colors: { fill, text, stroke }, each a paint with its
    // token, hex and opacity): the colour rendered in every mode against the token's value in that
    // mode, the paint's opacity included. The token's own variable in code is a match by itself.
    const inlineFill = /\(style attribute\)/.test(String(c.props?.backgroundColor?.rule ?? ''));
    const textFact = c.parts?.text?.props?.color ?? c.props?.color;
    const firstMode = Object.keys(c.colors ?? {})[0];
    const textInherits = !c.parts?.text?.props?.color || c.parts.text.props.color.value === c.colors?.[firstMode]?.color;
    const colourChecks = (label, paints, perMode, suffix = '', changed = {}) => {
      const slots = [
        ['fill', 'background', (col) => (c.fill === 'before' ? col.beforeBackground : col.backgroundColor), c.props?.backgroundColor],
        ['text', 'text colour', (col, m) => (m === firstMode && !suffix ? textFact?.value : textInherits ? col.color : null), textFact],
        ['stroke', 'border colour', (col) => col.borderTopColor, c.props?.borderTopColor],
      ];
      for (const [slot, field, pick, fact] of slots) {
        const paint = paints?.[slot];
        if (!paint) continue;
        if (slot === 'fill' && (inlineFill || !['direct', 'before'].includes(c.fill))) continue;   // painting at all is the background check's job
        if (slot === 'stroke' && drawsNothing) continue;                                          // drawing at all is the stroke check's job
        for (const [mode, col] of Object.entries(perMode ?? {})) {
          const want = paintIn(vars, mode, paint), got = col && pick(col, mode);
          if (!want || !got) continue;
          const expectedVar = paint.token && !suffix ? colorVarOf(paint.token, spec, maps) : undefined;
          const src = changed[{ fill: 'backgroundColor', text: 'color', stroke: 'borderTopColor' }[slot]] ?? fact;
          push(name, `${field}${suffix} [${mode}]`, paint.token ?? paint.hex, { ...(src ?? {}), value: got, confidence: src?.confidence ?? 'single-source' }, { expectedVar, figmaValue: want });
        }
      }
    };
    if (!low) colourChecks('', f.colors, c.colors);

    // Per variant, from the extended capture (variants: { "State=Hover, Size=M": { paddingPx, gapPx,
    // radiusPx, fontSize, colors } }): only what the variant changes from the default variant is
    // compared, against the state the capture produced with the same axis value.
    if (f.variants && !low) {
      const defAxes = axesOf(f.defaultVariant ?? '');
      const vfor = (label) => {
        const want = axesOf(label);
        const all = Object.entries(f.variants).filter(([v]) => { const a = axesOf(v); return Object.entries(want).every(([k, x]) => a[k] === x); });
        return (all.find(([v]) => Object.entries(axesOf(v)).every(([k, x]) => k in want || defAxes[k] === x)) ?? all[0])?.[1];
      };
      const def = f.variants[f.defaultVariant] ?? { paddingPx: f.paddingPx, radiusPx: f.radiusPx, colors: f.colors };
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const setsHeight = [c.props?.height, c.props?.minHeight].some((x) => x?.rule && x.confidence !== 'default');
      const lower = (a) => new Set((a ?? []).map((x) => String(x).toLowerCase()));
      const layerCheck = (label, figLayers, codeLayers, known) => {
        if (!Array.isArray(figLayers) || !codeLayers) return;
        const fig = lower(figLayers);
        for (const [part, shown] of Object.entries(codeLayers)) {
          if (!known.has(part.toLowerCase())) continue;       // Figma has no layer by that name
          const want = fig.has(part.toLowerCase());
          if (want === shown) { out.match++; continue; }
          out.differ.push({ component: name, field: `layer "${part}"${label ? ` (${label})` : ''}`, figma: want ? 'shown' : 'hidden', code: shown ? 'shown' : 'hidden', confidence: 'single-source' });
        }
      };
      const knownLayers = lower(Object.values(f.variants).flatMap((v) => v.layers ?? []));
      layerCheck('', def.layers, c.layers, knownLayers);
      const compareVariant = (label, st, v) => {
        if (!v) return;
        const now = (prop) => st.changed?.[prop] ?? c.props?.[prop];
        const num = (fig, fact, field) => {
          if (typeof fig !== 'number' || !fact) return;
          const got = toNum(fact.value);
          if (Math.abs(got - fig) < 0.5) out.match++;
          else out.differ.push({ component: name, field: `${field} (${label})`, figma: fig, code: fact.value, rule: fact.rule, at: fact.at, confidence: fact.confidence });
        };
        if (!same(v.paddingPx, def.paddingPx)) ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach((p, i) => num(v.paddingPx?.[i], now(p), p.replace('padding', 'padding ').toLowerCase()));
        if (!same(v.radiusPx, def.radiusPx)) ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].forEach((p, i) => num(v.radiusPx?.[i], now(p), 'radius'));
        if (!same(v.gapPx, def.gapPx)) num(v.gapPx, now('columnGap'), 'gap');
        if (!same(v.fontSize, def.fontSize)) num(v.fontSize, st.changed?.fontSize ?? fp?.fontSize, 'font size');
        // Height, only where the code fixes one (otherwise it follows the content).
        if (typeof v.h === 'number' && !same(v.h, def.h) && (setsHeight || st.changed?.height?.rule || st.changed?.minHeight?.rule) && st.size?.height != null)
          num(v.h, { ...(st.changed?.height ?? st.changed?.minHeight ?? c.props?.height ?? {}), value: `${st.size.height}px` }, 'height');
        const changedPaints = Object.fromEntries(['fill', 'text', 'stroke'].filter((k) => v.colors?.[k] && !same(v.colors[k], def.colors?.[k])).map((k) => [k, v.colors[k]]));
        if (Object.keys(changedPaints).length && st.colors) colourChecks('', changedPaints, st.colors, ` (${label})`, st.changed ?? {});
        if (!same(v.layers, def.layers)) layerCheck(label, v.layers, st.layers, knownLayers);
      };
      for (const [label, st] of Object.entries(c.states ?? {})) compareVariant(label, st, vfor(label));
      // Combinations of two or more axes, measured by the capture as one (idea I41).
      for (const [variant, st] of Object.entries(c.combos ?? {})) compareVariant(variant, st, f.variants[variant]);
    }

    // Background: does the component paint one? Figma often draws it on a child layer and code on the
    // element itself; both paint. Only "paints" vs "does not paint" is a difference.
    // A colour set in the element's own style attribute is page content (a swatch showing its colour),
    // not the component's design, so it is not compared.
    if (f.fillStructure && !low && !inlineFill) {
      const paints = (x) => x === 'direct' || x === 'before';
      if (paints(f.fillStructure) === paints(c.fill)) out.match++;
      else out.differ.push({ component: name, field: 'background', figma: paints(f.fillStructure) ? 'paints a background' : 'no background', code: paints(c.fill) ? 'paints a background' : 'no background', rule: c.props?.backgroundColor?.rule, at: c.props?.backgroundColor?.at });
    }
  }
  return out;
}

// Breakpoints: a component's responsive tokens (the sizing tokens the Figma breakpoint collection
// changes per mode) against what the code capture measured at that breakpoint's width.
export function compareBreakpoints(code, structure, vars) {
  const out = { match: 0, differ: [] };
  const bp = vars.breakpoints ?? {};
  if (!Object.keys(bp).length) return out;
  for (const [name, f] of Object.entries(structure ?? {})) {
    const c = code.components?.[name];
    if (!c?.breakpoints) continue;
    const fields = [
      ['padding (top)', f.paddingVar?.tb, 'paddingTop'], ['padding (left)', f.paddingVar?.lr, 'paddingLeft'],
      ['gap', f.gapVar, 'columnGap'], ['radius', f.innerRadiusVar, 'borderTopLeftRadius'],
    ];
    for (const [mode, tokens] of Object.entries(bp)) {
      const at = c.breakpoints[mode];
      if (!at) continue;
      for (const [field, token, prop] of fields) {
        if (!token || tokens[token] == null || at[prop] == null) continue;   // not a responsive token
        const same = valueMatch(tokens[token], at[prop]);
        if (same === true) out.match++;
        else if (same === false) out.differ.push({ component: name, field: `${field} @ ${mode} (${at.width}px)`, figma: token, figmaValue: tokens[token], code: at[prop], rule: c.props?.[prop]?.rule, at: c.props?.[prop]?.at });
      }
    }
  }
  return out;
}

// Every variant built: each axis value Figma defines (from the extended capture's variants) must be
// the default's, or a state the code capture produced or found declared in code. Axis values are
// checked one by one, not every combination: code realizes axes independently (a class per value).
export function compareVariants(code, structure) {
  const out = { built: 0, missing: [], notCaptured: [] };
  for (const [name, f] of Object.entries(structure ?? {})) {
    if (!f?.variants) continue;
    const c = code.components?.[name];
    if (!c) { out.notCaptured.push(name); continue; }
    const def = axesOf(f.defaultVariant ?? '');
    const known = new Set([...Object.keys(c.states ?? {}), ...(c.statesNotProduced ?? []).map((x) => x.state)].flatMap((l) => Object.entries(axesOf(l)).map(([k, v]) => `${k}=${v}`)));
    const values = new Set(Object.keys(f.variants).flatMap((v) => Object.entries(axesOf(v)).map(([k, x]) => `${k}=${x}`)));
    for (const kv of values) {
      const [k, v] = kv.split('=');
      if (def[k] === v || known.has(kv)) out.built++;
      else out.missing.push({ component: name, axis: k, value: v });
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

// One line a person can act on: which value to write, and where. A reading from one source only
// (the browser or the stylesheet, not both) says so, since it has not been confirmed.
export function measuredLine(d) {
  const plain = typeof d.figma === 'number' ? `${d.figma}px` : /^-?[\d.]+(px|%)?$/.test(String(d.figma)) ? String(d.figma) : null;
  const want = d.expectedVar ? `var(${d.expectedVar})` : (d.figmaValue ?? plain);
  const where = d.at ? `${d.rule ? `${d.rule} · ` : ''}${d.at}` : null;
  const figma = `${d.figma}${d.figmaValue ? ` (${d.figmaValue})` : ''}`;
  return `${d.component} ${d.field}: Figma ${figma}, rendered ${d.code}${d.codeVar ? ` via ${d.codeVar}` : ''}`
    + (where ? `  (${where})` : '')
    + (d.confidence === 'single-source' ? '  [read from one source]' : '')
    + (where && want ? `  → set ${want}` : '');
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
