// component-capture.mjs - measure every DS component where it really renders, and trace each
// value back to the rule, the token and the file:line that produced it.
//
// Used by code-capture.mjs inside its one browser session. For each component:
//   1. find an instance (component-locator.mjs gives the selector), best source first:
//      the generated styleguide, then the built pages; a hidden one is measured as an isolated
//      copy; else a probe declared in structure-contract.mjs; else a bare element built from the
//      selector (lowest confidence: without its content a hug-sized component has no real size).
//   2. measure it: box, padding, gap, radius, borders, font, colours, and the ::before layer.
//   3. trace every measured value with CSS.getMatchedStylesForNode: the declaration that won
//      (importance, then cascade order), its var() token, its rule and its file:line. A value no
//      author rule sets is labelled "inherited" or "browser default".
//   4. produce each state the contract maps (propertyMap): :hover/:focus/:active are forced, a
//      class, attribute or :disabled is applied to the instance, then measured and traced again.
//      A state that cannot be produced is listed with the reason.
//   5. compare with the static reading (the component's base rule in css-source.mjs): agreement
//      is `verified`; the browser showing another rule winning is still `verified`, with the
//      winning rule recorded as the override it is; a disagreement nothing explains is `uncertain`.

import { walkCss, rootTokens, resolveVars } from './css-source.mjs';
import { parseColor, lengthPx } from './css-values.mjs';

// The measured properties, and the declarations (longhand, logical, shorthand) that can set each.
export const TRACE = {
  height: ['height'],
  minHeight: ['min-height'],
  paddingTop: ['padding-top', 'padding-block-start', 'padding-block', 'padding'],
  paddingRight: ['padding-right', 'padding-inline-end', 'padding-inline', 'padding'],
  paddingBottom: ['padding-bottom', 'padding-block-end', 'padding-block', 'padding'],
  paddingLeft: ['padding-left', 'padding-inline-start', 'padding-inline', 'padding'],
  rowGap: ['row-gap', 'gap'],
  columnGap: ['column-gap', 'gap'],
  borderTopLeftRadius: ['border-top-left-radius', 'border-start-start-radius', 'border-radius'],
  borderTopRightRadius: ['border-top-right-radius', 'border-start-end-radius', 'border-radius'],
  borderBottomRightRadius: ['border-bottom-right-radius', 'border-end-end-radius', 'border-radius'],
  borderBottomLeftRadius: ['border-bottom-left-radius', 'border-end-start-radius', 'border-radius'],
  borderTopWidth: ['border-top-width', 'border-top', 'border-width', 'border-block-start', 'border'],
  borderRightWidth: ['border-right-width', 'border-right', 'border-width', 'border-inline-end', 'border'],
  borderBottomWidth: ['border-bottom-width', 'border-bottom', 'border-width', 'border-block-end', 'border'],
  borderLeftWidth: ['border-left-width', 'border-left', 'border-width', 'border-inline-start', 'border'],
  borderTopColor: ['border-top-color', 'border-top', 'border-color', 'border'],
  fontSize: ['font-size', 'font'],
  fontWeight: ['font-weight', 'font'],
  lineHeight: ['line-height', 'font'],
  color: ['color'],
  backgroundColor: ['background-color', 'background'],
  opacity: ['opacity'],
  width: ['width'],
  fontFamily: ['font-family', 'font'],
  letterSpacing: ['letter-spacing'],
  textTransform: ['text-transform'],
};
const MEASURED = [...Object.keys(TRACE), 'maxHeight', 'display', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'];
const COLOR_PROPS = new Set(['color', 'backgroundColor', 'borderTopColor']);
const INHERITED = new Set(['color', 'fontSize', 'fontWeight', 'lineHeight', 'fontFamily', 'letterSpacing', 'textTransform']);

// Which slot of a box shorthand a property reads (1 to 4 values: top right bottom left).
const BOX_SIDE = { paddingTop: 0, paddingRight: 1, paddingBottom: 2, paddingLeft: 3, borderTopWidth: 0, borderRightWidth: 1, borderBottomWidth: 2, borderLeftWidth: 3, borderTopColor: 0 };
export function splitTop(value) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(value).trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// The part of a declaration that sets `prop` (the whole value for a longhand).
export function partFor(declName, value, prop) {
  const parts = splitTop(value);
  if (/^(padding|border-width|border-color|border-style)$/.test(declName)) {
    const side = BOX_SIDE[prop] ?? 0;
    const pick = [[0, 0, 0, 0], [0, 1, 0, 1], [0, 1, 2, 1], [0, 1, 2, 3]][Math.min(parts.length, 4) - 1] ?? [0, 0, 0, 0];
    return parts[pick[side]] ?? value;
  }
  if (/^(padding-block|padding-inline)$/.test(declName)) {
    const end = /Bottom|Right/.test(prop) ? 1 : 0;
    return parts[Math.min(end, parts.length - 1)] ?? value;
  }
  if (declName === 'gap') return prop === 'columnGap' ? (parts[1] ?? parts[0]) : parts[0];
  if (declName === 'border-radius') {
    // Corners in order top-left, top-right, bottom-right, bottom-left (1 to 4 values, like a box).
    const corners = splitTop(value.split('/')[0].trim());
    const corner = { borderTopLeftRadius: 0, borderTopRightRadius: 1, borderBottomRightRadius: 2, borderBottomLeftRadius: 3 }[prop] ?? 0;
    const pick = [[0, 0, 0, 0], [0, 1, 0, 1], [0, 1, 2, 1], [0, 1, 2, 3]][Math.min(corners.length, 4) - 1] ?? [0, 0, 0, 0];
    return corners[pick[corner]] ?? corners[0] ?? value;
  }
  if (/^border(-top|-right|-bottom|-left|-block-start|-block-end|-inline-start|-inline-end)?$/.test(declName) && /^(none|0)$/i.test(String(value).trim())) {
    return /Width$/.test(prop) ? '0px' : 'currentcolor';
  }
  if (declName === 'background' && prop === 'backgroundColor' && /^none$/i.test(String(value).trim())) return 'transparent';
  if (/^border(-top|-right|-bottom|-left|-block-start|-block-end|-inline-start|-inline-end)?$/.test(declName)) {
    if (/Width$/.test(prop)) return parts.find((p) => /^(\d|\.|thin|medium|thick|var\()/.test(p)) ?? value;
    if (/Color$/.test(prop)) return [...parts].reverse().find((p) => !/^(\d|\.|none|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden|thin|medium|thick)/.test(p)) ?? value;
  }
  if (declName === 'background' && prop === 'backgroundColor') return [...parts].reverse().find((p) => /^(#|rgb|hsl|var\(|transparent|[a-z]+$)/i.test(p) && !/url\(/.test(p)) ?? value;
  return value;
}
export const firstVar = (text) => String(text ?? '').match(/var\(\s*(--[\w-]+)/)?.[1] ?? null;

// The declaration that won for `prop` among matched rules (ascending cascade order) and inline style.
export function winningDecl(matched, inlineStyle, prop) {
  const names = TRACE[prop] ?? [];
  let normal = null, important = null;
  const consider = (style, rule) => {
    for (const p of style?.cssProperties ?? []) {
      if (p.disabled || p.parsedOk === false || !names.includes(p.name) || p.implicit) continue;
      if (!String(p.value ?? '').trim()) continue;
      const hit = { name: p.name, value: p.value, important: !!p.important, rule };
      if (hit.important) important = hit; else normal = hit;
    }
  };
  for (const m of matched ?? []) consider(m.rule.style, m.rule);
  consider(inlineStyle, { origin: 'inline', selectorList: { text: '(style attribute)' } });
  return important ?? normal;
}

// ── In-page helpers ─────────────────────────────────────────────────────────────
const HOST = "position:absolute;left:0;top:0;width:600px;display:block;pointer-events:none;";
// Find (or build) one instance of each component and tag it with data-parity-cap="<i>".
function locateExpression(specs) {
  return `(() => {
    const specs = ${JSON.stringify(specs)};
    let host = document.getElementById('__parity_cap_host__');
    if (!host) { host = document.createElement('div'); host.id = '__parity_cap_host__'; host.style.cssText = ${JSON.stringify(HOST)}; document.body.appendChild(host); }
    const shown = (e) => { const r = e.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(e).visibility !== 'hidden'; };
    const build = (sel) => {
      let parent = null, first = null;
      for (const part of sel.replace(/[>+~]/g, ' ').trim().split(/\\s+/)) {
        const tag = (part.match(/^[a-z][\\w-]*/i) || ['div'])[0];
        const el = document.createElement(tag);
        for (const c of part.match(/\\.[\\w-]+/g) || []) el.classList.add(c.slice(1));
        const id = part.match(/#([\\w-]+)/); if (id) el.id = id[1];
        for (const a of part.match(/\\[[^\\]]+\\]/g) || []) { const m = a.slice(1, -1).split('='); el.setAttribute(m[0], (m[1] || '').replace(/^["']|["']$/g, '')); }
        if (parent) parent.appendChild(el); else first = el;
        parent = el;
      }
      if (parent && !parent.children.length && !/^(input|img|hr|br)$/i.test(parent.tagName)) parent.textContent = 'Label';
      return { root: first, target: parent };
    };
    const addChildren = (target, base, children) => {
      for (const c of children || []) {
        const rel = c.startsWith(base + ' ') ? c.slice(base.length + 1) : c;
        try { const k = build(rel); target.appendChild(k.root); if (!k.target.children.length) k.target.textContent = 'Label'; } catch { /* odd selector */ }
      }
    };
    return specs.map((s, i) => {
      let el = null, how = null, count = 0, stripped = null;
      try {
        const all = [...document.querySelectorAll(s.selector)].filter((e) => !host.contains(e));
        count = all.length;
        // A plain instance carries only the component's own classes. One with extra classes or an id is
        // a particular usage (an app styles it for that spot), so it is copied into a neutral host with
        // those extras removed, and the removed extras are recorded.
        const own = new Set((s.selector.split(/\\s+/).pop().match(/\\.[\\w-]+/g) || []).map((c) => c.slice(1)));
        const extras = (e) => [...e.classList].filter((c) => !own.has(c) && !c.startsWith('data-parity'));
        const visible = all.filter(shown);
        // Rank: a plain instance first, then one that carries text (a design's default variant has
        // its label; an icon-only usage is a variant of its own), then the rest.
        const score = (e) => extras(e).length * 10 + (e.id ? 5 : 0) + (e.textContent.trim() ? 0 : 3);
        const ranked = (list) => [...list].sort((a, b) => score(a) - score(b));
        el = ranked(visible).find((e) => !extras(e).length && !e.id) || null; if (el) how = 'found';
        if (!el && all.length) {
          const src = ranked(visible)[0] || ranked(all)[0];
          const copy = src.cloneNode(true);
          stripped = [...extras(src).map((c) => '.' + c), ...(src.id ? ['#' + src.id] : [])];
          for (const c of extras(src)) copy.classList.remove(c);
          copy.removeAttribute('id');
          host.appendChild(copy);
          if (copy.matches(s.selector)) { el = copy; how = visible.length ? 'isolated-copy' : 'hidden-copy'; }
          else { copy.remove(); el = visible[0] || null; if (el) how = 'found'; stripped = null; }
        }
      } catch (e) { return { i, error: String(e.message || e) }; }
      if (!el && s.probe) { host.insertAdjacentHTML('beforeend', s.probe); el = host.querySelector(s.selector); if (el) how = 'probe'; }
      if (!el && s.allowBare) {
        const b = build(s.selector);
        // Its contract children, plus any part the selector map names (a radius on an inner box, …).
        const inner = [...(s.children || []), ...Object.values(s.parts || {}).filter((p) => { try { return !b.target.querySelector(p); } catch { return false; } })];
        if (inner.length) { b.target.textContent = ''; addChildren(b.target, s.selector, [...new Set(inner)]); }
        host.appendChild(b.root); el = b.target.matches(s.selector) ? b.target : null; if (el) how = 'bare';
      }
      if (!el) return { i, how: null, count };
      el.setAttribute('data-parity-cap', ((el.getAttribute('data-parity-cap') || '') + ' ' + i).trim());   // two names can share one element
      // The parts the contract names (fontSel / radiusSel / gapSel / beforeSel), found inside the instance.
      const parts = {};
      for (const [kind, sel] of Object.entries(s.parts || {})) {
        let p = null;
        try { p = el.matches(sel) ? el : el.querySelector(sel) || el.querySelector(sel.split(/\s+/).pop()); } catch { p = null; }
        if (p) { p.setAttribute('data-parity-part', ((p.getAttribute('data-parity-part') || '') + ' ' + i + '-' + kind).trim()); parts[kind] = true; }
      }
      // The first element that holds visible text: what Figma's font fields describe (the first TEXT node).
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (t.textContent.trim() && t.parentElement) { t.parentElement.setAttribute('data-parity-part', ((t.parentElement.getAttribute('data-parity-part') || '') + ' ' + i + '-text').trim()); parts.text = true; break; }
      }
      return { i, how, count, stripped, parts, hasText: !!el.textContent.trim() };
    });
  })()`;
}
const capSel = (i) => `[data-parity-cap~="${i}"]`;
function measureExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), b = getComputedStyle(el, '::before');
    const pick = (s, keys) => Object.fromEntries(keys.map((k) => [k, s[k]]));
    const before = b.content && b.content !== 'none' ? pick(b, ['backgroundColor', 'borderTopLeftRadius', 'top', 'right', 'bottom', 'left', 'borderTopWidth', 'borderTopColor']) : null;
    return { rect: { height: r.height, width: r.width }, cs: pick(cs, ${JSON.stringify(MEASURED)}), before };
  })()`;
}

// ── Static reading of a component's own base rule ───────────────────────────────
export function staticComponentReading(sources, selector, rootVars) {
  const out = {};
  for (const { file, text } of sources) {
    for (const rule of walkCss(text, file)) {
      if (rule.atRules.some((a) => !/^@(layer|supports)\b/i.test(a))) continue;
      if (!rule.selectors.some((s) => s.replace(/\s+/g, ' ') === selector)) continue;
      for (const d of rule.decls) {
        for (const [prop, names] of Object.entries(TRACE)) {
          if (!names.includes(d.prop)) continue;
          const part = partFor(d.prop, d.value, prop);
          out[prop] = { declared: part, value: resolveVars(part, rootVars).value, var: firstVar(part), at: `${file}:${d.line}` };
        }
      }
    }
  }
  return out;
}

// Every static rule by its selector text, so the rule the browser says won can be checked against
// the CSS source (the second reading), whatever rule it is: the component's own, a shared "*",
// a parent context, an app override.
const selKey = (text) => String(text).split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
export function staticRuleIndex(sources) {
  const index = new Map();
  for (const { file, text } of sources) {
    for (const rule of walkCss(text, file)) {
      if (rule.atRules.some((a) => !/^@(layer|supports)\b/i.test(a))) continue;
      const k = selKey(rule.selectors.join(', '));
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({ rule, file });
    }
  }
  return index;
}
export function staticDeclFor(index, selectorText, prop, rootVars) {
  let hit = null;
  for (const { rule, file } of index.get(selKey(selectorText)) ?? []) {
    for (const d of rule.decls) {
      if (!(TRACE[prop] ?? []).includes(d.prop)) continue;
      const part = partFor(d.prop, d.value, prop);
      hit = { declared: part, value: resolveVars(part, rootVars).value, var: firstVar(part), at: `${file}:${d.line}` };
    }
  }
  return hit;
}

// Compare a static value with a computed one: px lengths, colours as rgba, numbers. The reading of
// units and colours is css-values.mjs (rem, calc(), hsl(), oklch(), color(srgb …) included).
function toRgba(v) {
  const c = parseColor(v);
  return c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3] * 100) / 100] : null;
}
function toPx(v) {
  return lengthPx(v, { unitless: true });
}
// Does a declared border width render as `drawn` under whole-pixel snapping?
export function borderSnaps(declared, drawn) {
  if (declared == null || drawn == null) return false;
  if (declared > 0 && declared < 1) return drawn === 1;
  return Math.floor(declared) === drawn;
}
export function sameValue(prop, a, b) {
  if (a == null || b == null) return null;
  if (COLOR_PROPS.has(prop)) { const x = toRgba(a), y = toRgba(b); return x && y ? x.every((n, i) => n === y[i]) : null; }
  const x = toPx(a), y = toPx(b);
  if (x != null && y != null) return Math.abs(x - y) < 0.01;
  return String(a).trim() === String(b).trim() ? true : null;
}

// ── The capture ─────────────────────────────────────────────────────────────────
// ctx: { send, on, openPage(url), pages: [{label, url}], modes, modeSwitch, components: [{ name, selector,
//        locatedBy, probe?, children?, states: [{ label, selector }] }], staticSources, staticRootVars }
export async function captureComponents(ctx) {
  const { send, on, pages, modes, modeSwitch, components, staticSources, staticRootVars } = ctx;
  const result = {};
  const ruleIndex = staticRuleIndex(staticSources);
  const pending = new Map(components.map((c) => [c.name, c]));
  const notes = [];
  const firstMode = modes[0]?.snapshotKey;

  // Open a page and return the helpers bound to it: where / trace / nodeOf / measureAll / close.
  async function preparePage(page) {
    const { targetId, sessionId } = await ctx.openPage(page.url);
    if (!sessionId) return null;
    const sheets = {};
    const off = on('CSS.styleSheetAdded', (p, sid) => { if (sid === sessionId) sheets[p.header.styleSheetId] = p.header; });
    await send('DOM.enable', {}, sessionId);
    await send('CSS.enable', {}, sessionId);
    // Repeatable numbers: a fixed viewport and pixel ratio, fonts loaded, transitions and animations off.
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: ctx.deviceScaleFactor ?? 2, mobile: false }, sessionId);
    await send('Runtime.evaluate', { expression: "(async () => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); await document.fonts.ready; })()", awaitPromise: true }, sessionId);
    const where = (rule) => {
      if (!rule || rule.origin === 'inline') return rule?.origin === 'inline' ? `${page.label} (style attribute)` : null;
      if (rule.origin === 'user-agent') return 'browser default';
      const h = sheets[rule.styleSheetId];
      const line = (h?.startLine ?? 0) + (rule.style?.range?.startLine ?? 0) + 1;
      // The generated styleguide carries a <base> pointing at the project's page, so its own <style>
      // blocks are named after the page rather than the base folder.
      const src = h?.isInline && page.generated ? page.label : h?.sourceURL ? decodeURIComponent(h.sourceURL.replace(/^file:\/\//, '')).split('/').slice(-2).join('/') : page.label;
      return `${src}:${line}`;
    };
    const trace = async (nodeId) => {
      const m = await send('CSS.getMatchedStylesForNode', { nodeId }, sessionId);
      const out = {};
      for (const prop of Object.keys(TRACE)) {
        let w = winningDecl(m.matchedCSSRules, m.inlineStyle, prop), inherited = false;
        // An inherited property no rule sets on the element comes from the nearest ancestor that sets it.
        if (!w && INHERITED.has(prop)) {
          for (const anc of m.inherited ?? []) { w = winningDecl(anc.matchedCSSRules, anc.inlineStyle, prop); if (w) { inherited = true; break; } }
        }
        if (!w) { out[prop] = { from: 'initial' }; continue; }
        if (w.rule?.origin === 'user-agent') { out[prop] = { from: 'browser default', rule: w.rule?.selectorList?.text ?? null }; continue; }
        const part = partFor(w.name, w.value, prop);
        out[prop] = { declared: part, var: firstVar(part), rule: w.rule?.selectorList?.text ?? null, at: where(w.rule), important: w.important || undefined, inherited: inherited || undefined };
      }
      return out;
    };
    // One document node per page: asking for the document again would invalidate every node id
    // handed out so far (a forced :hover would then target nothing).
    let rootId = null;
    const nodeOf = async (sel) => {
      if (rootId == null) rootId = (await send('DOM.getDocument', { depth: 0 }, sessionId)).root.nodeId;
      return (await send('DOM.querySelector', { nodeId: rootId, selector: sel }, sessionId).catch(() => ({}))).nodeId;
    };
    const measureAll = async (sel) => {
      const perMode = {};
      for (const mode of modes) {
        const sw = modeSwitch(mode);
        if (sw.unsupported) continue;
        await send('Emulation.setEmulatedMedia', { features: sw.media }, sessionId);
        if (sw.apply) await send('Runtime.evaluate', { expression: sw.apply }, sessionId);
        perMode[mode.snapshotKey] = (await send('Runtime.evaluate', { expression: measureExpression(sel), returnByValue: true }, sessionId)).result?.value;
        if (sw.undo) await send('Runtime.evaluate', { expression: sw.undo }, sessionId);
      }
      return perMode;
    };
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result?.value;
    const close = async () => { off(); await send('Target.closeTarget', { targetId }).catch(() => {}); };
    return { sessionId, where, trace, nodeOf, measureAll, evaluate, close };
  }

  // One measured + traced element → facts, checked against the static reading of the winning rule.
  function facts(comp, how, base, traced, stat) {
    const props = {};
    const hidden = base?.cs?.display === 'none';
    for (const prop of Object.keys(TRACE)) {
      // height is the CSS height (what a declaration sets); the drawn box is in entry.size.
      const value = base?.cs?.[prop];
      if (value == null) continue;
      const t = traced[prop] ?? {};
      if (hidden && GEOMETRY.has(prop)) {
        // Its own CSS hides it (display: none) until some context shows it: no size to measure here.
        const own = stat[prop];
        props[prop] = { confidence: 'not-read', why: 'the component is display: none in this context', ...(own ? { declared: own.value, at: own.at } : {}) };
        continue;
      }
      const fact = { value };
      if (t.var) fact.var = t.var;
      if (t.rule) fact.rule = t.rule;
      if (t.at) fact.at = t.at;
      if (t.inherited) fact.inherited = true;
      // Not set by any author rule: the browser's own default or the initial value. Not a code fact.
      if (t.from) {
        if (prop === 'height' && how === 'bare' && !traced.minHeight?.rule) { props[prop] = { confidence: 'not-read', why: 'its size depends on content, and a bare element has none' }; continue; }
        fact.from = t.from; fact.confidence = 'default'; props[prop] = fact; continue;
      }
      // Second reading: the same rule the browser says won, read from the CSS source.
      const s = t.rule ? staticDeclFor(ruleIndex, t.rule, prop, staticRootVars) : null;
      if (!s) { fact.confidence = 'single-source'; fact.why = 'the winning rule is only in the built page'; }
      else {
        // A unitless line-height is a multiple of the font size; currentColor is the element's colour.
        let sv = prop === 'lineHeight' && /^\d*\.?\d+$/.test(String(s.value).trim()) && /px$/.test(base?.cs?.fontSize ?? '')
          ? `${parseFloat(s.value) * parseFloat(base.cs.fontSize)}px` : s.value;
        if (/^currentcolor$/i.test(String(sv).trim())) sv = base?.cs?.color;
        let agree = sameValue(prop, sv, value);
        // Browsers draw border widths in whole CSS pixels (1.5px renders 1px, 0.5px renders 1px).
        // The code's fact is what it declares; what the browser drew is kept beside it.
        if (/Width$/.test(prop) && agree === false && borderSnaps(toPx(sv), toPx(value))) { agree = true; fact.value = s.value; fact.drawn = value; fact.note = 'browsers draw border widths in whole pixels'; }
        // A min-height (or max-height) larger than the declared height wins over it.
        if (prop === 'height' && agree === false && (toPx(base?.cs?.minHeight) === toPx(value) || toPx(base?.cs?.maxHeight) === toPx(value))) { agree = true; fact.declared = s.value; fact.note = `${toPx(base?.cs?.minHeight) === toPx(value) ? 'min-height' : 'max-height'} wins over the declared height`; }
        // Agree → verified; disagree → uncertain (a reading problem, never a design difference);
        // not comparable → single-source. Where the value is located is a separate question.
        if (agree === null) { fact.confidence = 'single-source'; fact.why = 'the two readings are not comparable'; }
        else if (agree) fact.confidence = 'verified';
        else { fact.confidence = 'uncertain'; fact.readings = { browser: value, static: s.value, staticAt: s.at }; }
        // Point at the source, not the built page (which may inline and minify it); keep both.
        if (s.at && fact.at && s.at !== fact.at) { fact.renderedAt = fact.at; fact.at = s.at; }
      }
      // The component's own base rule says something else, but another rule wins here.
      const own = stat[prop];
      if (own && t.rule && selKey(t.rule) !== selKey(comp.selector) && sameValue(prop, own.value, fact.value) === false) fact.overrides = { baseRule: comp.selector, baseValue: own.value, baseAt: own.at };
      props[prop] = fact;
    }
    return props;
  }
  const colorsOf = (perMode) => {
    const out = {};
    for (const [mk, mv] of Object.entries(perMode)) {
      if (!mv) continue;
      out[mk] = Object.fromEntries([...COLOR_PROPS].map((k) => [k, mv.cs[k]]));
      if (mv.before) out[mk].beforeBackground = mv.before.backgroundColor;
    }
    return out;
  };
  const stateEntry = (st, produced, sMode, sTrace, props) => {
    const changed = {};
    const sb = sMode[firstMode] ?? {};
    for (const prop of Object.keys(TRACE)) {
      const v = sb?.cs?.[prop];
      if (v != null && v !== props[prop]?.value && v !== props[prop]?.drawn) changed[prop] = { value: v, var: sTrace[prop]?.var ?? undefined, rule: sTrace[prop]?.rule ?? undefined, at: sTrace[prop]?.at ?? undefined };
      // Point at the source rule, not the built page, as the base facts do.
      const c = changed[prop];
      const s = c?.rule ? staticDeclFor(ruleIndex, c.rule, prop, staticRootVars) : null;
      if (s?.at && c.at && s.at !== c.at) { c.renderedAt = c.at; c.at = s.at; }
    }
    const matched = Object.values(changed).some((c) => c.rule && c.rule.replace(/\s+/g, ' ').includes(st.selector.replace(/\s+/g, ' ')));
    return { selector: st.selector, produced, changed, colors: colorsOf(sMode), ruleMatched: matched };
  };

  // Pass 1: every component, and the states that can be produced on its instance.
  const deferred = [];   // states that need an element already in that state, from any page
  for (let pi = 0; pi < pages.length && pending.size; pi++) {
    const page = pages[pi];
    const P = await preparePage(page);
    if (!P) { notes.push(`${page.label}: page did not load`); continue; }
    const list = [...pending.values()];
    // Only the last page builds bare elements, so a real instance anywhere always wins.
    const specs = list.map((c) => ({ selector: c.selector, probe: c.probe ?? null, allowBare: pi === pages.length - 1, children: c.children ?? [], parts: c.parts ?? {} }));
    const located = (await P.evaluate(locateExpression(specs))) ?? [];
    for (const loc of located) {
      const comp = list[loc.i];
      if (loc.error) { notes.push(`${comp.name}: selector ${comp.selector} is not valid CSS (${loc.error})`); pending.delete(comp.name); continue; }
      if (!loc.how) continue;
      pending.delete(comp.name);
      try { await captureOne(P, page, comp, loc); }
      catch (e) { notes.push(`${comp.name}: could not be measured (${String(e.message || e).split('\n')[0]})`); }
    }
    await P.close();
  }
  for (const c of pending.values()) notes.push(`${c.name}: no instance found (selector ${c.selector})`);
  return pass2(notes);

  async function captureOne(P, page, comp, loc) {
    {
      const nodeId = await P.nodeOf(capSel(loc.i));
      const perMode = await P.measureAll(capSel(loc.i));
      const traced = nodeId ? await P.trace(nodeId) : {};
      const base = perMode[firstMode];
      const stat = staticComponentReading(staticSources, comp.selector, staticRootVars);
      const props = facts(comp, loc.how, base, traced, stat);
      const bg = toRgba(base?.cs?.backgroundColor);
      const beforeBg = toRgba(base?.before?.backgroundColor);
      const entry = {
        selector: comp.selector, locatedBy: comp.locatedBy,
        instance: { page: page.label, how: loc.how, count: loc.count, hasText: loc.hasText, ...(loc.stripped?.length ? { usageExtrasRemoved: loc.stripped } : {}) },
        confidence: loc.how === 'bare' ? 'low' : loc.how === 'hidden-copy' ? 'medium' : 'high',
        size: { height: base?.rect?.height, width: base?.rect?.width },
        props, fill: bg && bg[3] > 0 ? 'direct' : beforeBg && beforeBg[3] > 0 ? 'before' : 'none', colors: colorsOf(perMode),
      };
      if (base?.before) entry.before = base.before;
      // Parts: each measured and traced like the instance, keeping only the properties the part is for.
      const PART_PROPS = { font: ['fontSize', 'fontWeight', 'lineHeight', 'color', 'fontFamily', 'letterSpacing', 'textTransform'], text: ['fontSize', 'fontWeight', 'lineHeight', 'color', 'fontFamily', 'letterSpacing', 'textTransform'], radius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'], gap: ['rowGap', 'columnGap'], before: ['borderTopLeftRadius', 'backgroundColor'] };
      for (const kind of Object.keys(loc.parts ?? {})) {
        const sel = `[data-parity-part~="${loc.i}-${kind}"]`;
        const pNode = await P.nodeOf(sel);
        if (!pNode) continue;
        const pMode = await P.measureAll(sel);
        const pTraced = await P.trace(pNode);
        const pSel = kind === 'text' ? null : comp.parts?.[kind];
        const pStat = pSel ? staticComponentReading(staticSources, pSel, staticRootVars) : {};
        const pFacts = facts({ ...comp, selector: pSel ?? comp.selector }, loc.how, pMode[firstMode], pTraced, pStat);
        (entry.parts ??= {})[kind] = { selector: pSel ?? '(first text)', props: Object.fromEntries(Object.entries(pFacts).filter(([k]) => PART_PROPS[kind]?.includes(k))) };
      }
      for (const st of comp.states ?? []) {
        const how = stateRecipe(comp.selector, st.selector);
        if (how.error || !nodeId) { deferred.push({ comp: comp.name, st, why: how.error ?? 'instance not addressable' }); continue; }
        await applyRecipe(send, P.sessionId, loc.i, nodeId, how, true);
        const sMode = await P.measureAll(capSel(loc.i));
        const sTrace = await P.trace(nodeId);
        await applyRecipe(send, P.sessionId, loc.i, nodeId, how, false);
        (entry.states ??= {})[st.label] = stateEntry(st, how.describe, sMode, sTrace, props);
      }
      result[comp.name] = entry;
    }
  }

  async function pass2(notes) {
  // Pass 2: states that cannot be put on the instance: find an element already in that state, on any page.
  let left = deferred.filter((d) => result[d.comp] && !/[@{]/.test(d.st.selector));
  for (const d of deferred) if (!left.includes(d) && result[d.comp]) (result[d.comp].statesNotProduced ??= []).push({ state: d.st.label, selector: d.st.selector, why: `${d.why}, and it is not a selector that can be looked up` });
  for (let pi = 0; pi < pages.length && left.length; pi++) {
    const P = await preparePage(pages[pi]);
    if (!P) continue;
    const still = [];
    for (const [k, d] of left.entries()) {
      const tag = `st${k}`;
      const found = await P.evaluate(`(() => { try {
        const host = document.getElementById('__parity_cap_host__');
        const all = [...document.querySelectorAll(${JSON.stringify(d.st.selector)})].filter((e) => !(host && host.contains(e)));
        let el = all.find((e) => e.getBoundingClientRect().height > 0) || null;
        if (!el && all.length) {
          let h = host; if (!h) { h = document.createElement('div'); h.id = '__parity_cap_host__'; h.style.cssText = ${JSON.stringify(HOST)}; document.body.appendChild(h); }
          const copy = all[0].cloneNode(true); h.appendChild(copy); if (copy.matches(${JSON.stringify(d.st.selector)})) el = copy;
        }
        if (!el) return false; el.setAttribute('data-parity-state', ${JSON.stringify(tag)}); return true; } catch { return false; } })()`);
      const sNode = found ? await P.nodeOf(`[data-parity-state="${tag}"]`) : null;
      if (!sNode) { still.push(d); continue; }
      const sMode = await P.measureAll(`[data-parity-state="${tag}"]`);
      const sTrace = await P.trace(sNode);
      (result[d.comp].states ??= {})[d.st.label] = stateEntry(d.st, `found an element already in this state (${pages[pi].label})`, sMode, sTrace, result[d.comp].props);
    }
    left = still;
    await P.close();
  }
  for (const d of left) (result[d.comp].statesNotProduced ??= []).push({ state: d.st.label, selector: d.st.selector, why: `${d.why}, and no page has an element already in this state` });
  return { components: result, notes, missing: [...pending.keys()] };
  }
}

const GEOMETRY = new Set(['height', 'minHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']);

// ── States: how to put an instance into the state a selector describes ─────────
const FORCEABLE = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited']);
const tokens = (compound) => (compound.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?|^[a-z][\w-]*/gi) || []);
const lastCompound = (sel) => String(sel).trim().split(/\s*[\s>+~]\s*/).pop();
const ancestors = (sel) => String(sel).trim().split(/\s*[\s>+~]\s*/).slice(0, -1).join(' ');
export function stateRecipe(baseSel, stateSel) {
  const b = String(baseSel).replace(/\s+/g, ' ').trim(), s = String(stateSel).replace(/\s+/g, ' ').trim();
  if (ancestors(b) !== ancestors(s)) return { error: 'the state selector targets a different element than the component (context state)' };
  const bt = tokens(lastCompound(b)), stt = tokens(lastCompound(s)).filter((t) => !t.startsWith('::'));
  const add = { classes: [], attrs: [], force: [], disabled: false, checked: false };
  const baseClasses = bt.filter((t) => t.startsWith('.'));
  for (const t of stt) {
    if (bt.includes(t)) continue;
    if (t.startsWith('.')) add.classes.push(t.slice(1));
    else if (t.startsWith('[')) { const [k, v = ''] = t.slice(1, -1).split('='); add.attrs.push([k.trim(), v.replace(/^["']|["']$/g, '')]); }
    else if (/^:not\(/.test(t)) continue;
    else if (t === ':disabled') add.disabled = true;
    else if (t === ':checked') add.checked = true;
    else if (t.startsWith(':') && FORCEABLE.has(t.slice(1))) add.force.push(t.slice(1));
    else return { error: `cannot produce ${t}` };
  }
  // A base class the state selector drops is fine only when a state class extends it (BEM modifier).
  for (const c of baseClasses) if (!stt.includes(c) && !add.classes.some((x) => x.startsWith(c.slice(1)))) return { error: `the state selector drops the base class ${c}` };
  const describe = [...add.force.map((f) => `forced :${f}`), ...add.classes.map((c) => `class .${c}`), ...add.attrs.map(([k, v]) => `attribute ${k}="${v}"`), ...(add.disabled ? ['disabled'] : []), ...(add.checked ? ['checked'] : [])].join(' + ') || 'same as the base selector';
  return { ...add, describe };
}
async function applyRecipe(send, sessionId, capId, nodeId, how, on) {
  const js = `(() => { const el = document.querySelector('[data-parity-cap~="${capId}"]'); if (!el) return;
    ${JSON.stringify(how.classes)}.forEach((c) => el.classList.${on ? 'add' : 'remove'}(c));
    ${JSON.stringify(how.attrs)}.forEach(([k, v]) => ${on ? 'el.setAttribute(k, v)' : 'el.removeAttribute(k)'});
    ${how.disabled ? `el.${on ? 'setAttribute("disabled", "")' : 'removeAttribute("disabled")'};` : ''}
    ${how.checked ? `if ('checked' in el) el.checked = ${on};` : ''} })()`;
  await send('Runtime.evaluate', { expression: js }, sessionId);
  if (how.force.length) await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on ? how.force : [] }, sessionId);
}
