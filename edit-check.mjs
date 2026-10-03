// edit-check.mjs - every UI edit an agent makes is checked when it is made (idea I62).
//
// The audit checks when someone runs it; the agents that write most of the drift never do. S30 measured it:
// rules and an MCP server changed nothing for a small model (it never called the MCP), a hook that checked each
// edit took invented values to zero in 14 of 15 runs. So, as a Claude Code PostToolUse hook (installed with the
// guard), after an Edit, MultiEdit or Write on a UI file this reads only what the edit ADDED and returns what in
// it the design system does not have, with the right name:
//   • var(--x) that is declared nowhere (not in the theme, not in the file itself);
//   • a colour written as a literal: the token that has that value when one does, or "not a design-system colour";
//   • on a design-system component's tag, a prop value it does not take or a prop name written another way
//     (the catalog and the code API, exactly as the steering check reads them);
//   • in a Tailwind project, a class with a value in brackets (rounded-[4px]): the theme's utility when a theme
//     value is the same, or that it is not a design-system value (tailwind-check.mjs);
//   • a comment that switches a check off (I73): eslint-disable, stylelint-disable, @ts-ignore, @ts-expect-error,
//     @ts-nocheck, biome-ignore, oxlint-disable. It is a way round a finding, not a fix;
//   • what the static accessibility check finds (I74, a11y-static.mjs) where the edit added the line, with its fix:
//     a button or link with only an icon and no name, an image with no alt, a click handler on a div, a focus
//     outline removed with none put back anywhere in the project, an aria-* that does not exist;
//   • a size written by hand (I75): a padding, margin, gap, corner radius or font size in px or rem, with the token
//     that has that value, or the nearest ones when none has it. Only a kind of size the theme names (no spacing
//     tokens, no spacing finding); 0, 1px hairlines, a pill's 999px, negatives and calc() are left alone.
// Silent when the edit added none of these. Precise before complete: component tags the catalog does not know
// are the app's own components, never flagged; a custom-property declaration is a token being defined, and
// the theme file's own literals are its values.
import { resolveNamingSpec, tokenToVar } from './naming-convention.mjs';
import { TOKENS_TO_BUILD } from './build-list.mjs';   // build mode: the tokens still to build
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { steeringTruth, steeringFindings } from './steering-check.mjs';
import { usesTailwind, themeValues, arbitraryFindings } from './tailwind-check.mjs';
import { primitiveTable, projectClassRules, primitiveFindings, primitiveTag } from './primitives.mjs';
import { markupFindings, cssFindings, styleOnly, projectStyleText } from './a11y-static.mjs';
import { codeSnapshotPath } from './names.mjs';

const UI = /\.(css|scss|sass|less|html?|vue|svelte|jsx|tsx)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|contracts|\.design-system-engine-out|\.design-system-engine-refs)\//;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const NOT_COLOUR = /(href|to|src|action|xlink:href)\s*=\s*\{?\s*["'`]$|url\(\s*["']?$|&$/i;   // #add in a link is a fragment
// Outside a style sheet, a colour counts only where it styles something: after a colour-bearing property
// (color, background, border-color, fill, stroke, box-shadow; a JS style key like backgroundColor). A colour in a
// data table or a comment is data.
const STYLE_PROP = /(colou?r|background|border|fill|stroke|shadow|outline|caret|accent|decoration)[\w-]*["'`]?\s*[:=]\s*\{?\s*[^;:=]*$/i;
const COMMENT = /^\s*(\/\/|\/?\*|<!--)/;
// A directive starts its comment (// eslint-disable-next-line, /* stylelint-disable */, {/* @ts-ignore */}); the
// same words later in a comment are prose about it.
const SILENCER = /(?:\/\/+|\/\*+|<!--)\s*(eslint-disable(?:-next-line|-line)?|stylelint-disable(?:-next-line|-line)?|oxlint-disable(?:-next-line|-line)?|biome-ignore(?:-all|-start)?|@ts-(?:ignore|expect-error|nocheck))(?![\w-])/;
const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The kind of size a token holds, by its name, and the kind a style property takes (I75).
const SIZE_KIND = [
  ['radius', /radi|rounded|corner/],
  ['font size', /font-?size|text-?size|type-?size|(^|-)fs(-|$)|^--text-(2xs|xs|sm|md|base|lg|xl|[2-9]xl)$|(body|heading|title|label|caption|display|headline)[\w-]*-size/],
  ['spacing', /spac|gap|gutter|inset|padding|margin/],
];
const tokenKind = (name) => SIZE_KIND.find(([, re]) => re.test(String(name).toLowerCase()))?.[0] ?? null;
const propKind = (prop) => (/radius/i.test(prop) ? 'radius' : /font-?size/i.test(prop) ? 'font size' : /^(padding|margin|gap|row-?gap|column-?gap)/i.test(prop) ? 'spacing' : null);
const toPx = (n, unit) => +(Number(n) * (/rem/i.test(unit) ? 16 : 1)).toFixed(3);

// The sizes the theme defines, by kind, in px (a rem is 16px): { spacing: Map(px → [token]), radius, 'font size' }.
export function themeSizes(css) {
  const out = { spacing: new Map(), radius: new Map(), 'font size': new Map() };
  for (const m of String(css ?? '').matchAll(/(--[\w-]+)\s*:\s*(\d*\.?\d+)(px|rem)\s*(?:!important\s*)?(?=[;}\n]|$)/g)) {
    const kind = tokenKind(m[1]);
    if (!kind || m[1] === '--spacing') continue;   // Tailwind's --spacing is the step every spacing multiplies, not a value
    const px = toPx(m[2], m[3]), list = out[kind].get(px) ?? [];
    if (!list.includes(m[1])) list.push(m[1]);
    out[kind].set(px, list);
  }
  return out;
}

const SIZE_CSS = /(?:^|[\s;{"'`(])((?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|font-size)\s*:\s*([^;}"'`\n]+)/gi;
const SIZE_JS = /(?:^|[\s{,(])((?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?|gap|rowGap|columnGap|border(?:TopLeft|TopRight|BottomLeft|BottomRight|StartStart|StartEnd|EndStart|EndEnd)?Radius|fontSize)\s*:\s*(?:(["'`])([^"'`]+)\2|(\d+(?:\.\d+)?)(?![\w.%]))/g;

// → the text of each size written by hand on this line. `styled`: the line sets a style attribute, where a bare
// number is px (React's style={{ padding: 12 }}).
export function sizeFindings(line, sizes, { styled = false } = {}) {
  const out = [];
  const check = (prop, raw, values) => {
    const kind = propKind(prop), table = sizes?.[kind];
    if (!table?.size) return;   // the system names no sizes of this kind
    for (const [text, px] of values) {
      if (px <= 1) continue;
      const names = table.get(px);
      if (names) { out.push(`${prop}: ${text} is written by hand; use var(${names[0]})${names.length > 1 ? ` (or ${names.slice(1, 3).map((t) => `var(${t})`).join(', ')})` : ''}`); continue; }
      if (px >= 999) continue;   // a pill's radius, when no token holds it
      const all = [...table.keys()].sort((a, b) => a - b);
      const below = all.filter((v) => v < px).pop(), above = all.find((v) => v > px);
      const near = [below, above].filter((v) => v !== undefined).map((v) => `var(${table.get(v)[0]}) (${v}px)`);
      out.push(`${prop}: ${text} is not a ${kind === 'spacing' ? 'spacing value' : kind} of the design system${near.length ? `; the nearest ${near.length > 1 ? 'are' : 'is'} ${near.join(' and ')}` : ''}`);
    }
  };
  const lengths = (v) => (/calc\(|min\(|max\(|clamp\(/i.test(v) ? [] : [...v.matchAll(/(^|[\s,(])(\d*\.?\d+)(px|rem)\b/gi)].map((m) => [`${m[2]}${m[3]}`, toPx(m[2], m[3])]));
  for (const m of String(line).matchAll(SIZE_CSS)) check(m[1], m[2], lengths(m[2]));
  for (const m of String(line).matchAll(SIZE_JS)) {
    if (m[3] !== undefined) check(m[1], m[3], lengths(m[3]));
    else if (styled) check(m[1], m[4], [[m[4], Number(m[4])]]);
  }
  return out;
}

// A design-system component's tag on this line: <Chip>, <ButtonPrimary>, <hb-chip>. A lowercase single word
// (<button>, <input>) is the HTML element, whose attributes are the platform's, never the system's props.
export function componentTagIn(line, components) {
  const names = new Set(components.map(normName));
  for (const m of String(line).matchAll(/<([A-Za-z][\w.-]*)/g)) {
    const tag = m[1];
    if (/^[A-Z]/.test(tag) && names.has(normName(tag))) return tag;
    if (tag.includes('-')) { const n = normName(tag); for (const c of names) if (n.endsWith(c) && /^[a-z]{1,4}$/.test(n.slice(0, -c.length))) return tag; }
  }
  return null;
}

// #abc → #aabbcc, lower case; 8-digit keeps its alpha.
export function normHex(h) {
  let x = String(h).toLowerCase().replace('#', '');
  if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
  return `#${x}`;
}

// The lines an edit added, as the tool call states them. Edit and MultiEdit: lines of the new text that the old
// text did not have. Write: lines the committed version did not have (all of them for a new file).
export function addedLines(event, { headText = null } = {}) {
  const input = event?.tool_input ?? {};
  const diff = (oldT, newT) => {
    const before = new Map();
    for (const l of String(oldT ?? '').split('\n')) before.set(l, (before.get(l) ?? 0) + 1);
    return String(newT ?? '').split('\n').filter((l) => {
      const n = before.get(l) ?? 0;
      if (n > 0) { before.set(l, n - 1); return false; }
      return l.trim().length > 0;
    });
  };
  if (event?.tool_name === 'Edit') return diff(input.old_string, input.new_string);
  if (event?.tool_name === 'MultiEdit') return (input.edits ?? []).flatMap((e) => diff(e.old_string, e.new_string));
  if (event?.tool_name === 'Write') return diff(headText ?? '', input.content);
  return [];
}

// What the check compares against, read once per edit from what the audit already wrote.
export function editTruth(ROOT, cfg = {}) {
  const read = (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return ''; } };
  const json = (p) => { try { return JSON.parse(read(p)); } catch { return {}; } };
  const themePaths = [cfg.paths?.themeCSS ?? 'src/theme.css', ...[cfg.paths?.pluginCSS ?? []].flat()].flat();
  // Build mode: the tokens Figma defines and the theme does not declare yet (written by the token check) count as the
  // system's own, so a component written before or alongside its tokens is still checked against them.
  const theme = [...themePaths.map(read), cfg.build === true ? read(TOKENS_TO_BUILD) : ''].join('\n');
  const cssVars = [...new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))];
  const tokenByValue = new Map();
  for (const m of theme.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    const k = normHex(m[2]);
    const list = tokenByValue.get(k) ?? [];
    if (!list.includes(m[1])) list.push(m[1]);
    tokenByValue.set(k, list);
  }
  // The colours a Figma component paints with no variable bound: Figma's own value, written as it is (the build sheet
  // says so, and the audit's literal check accepts it), so not an invented colour.
  const figmaRaw = new Set();
  const walkRaw = (o) => { if (typeof o === 'string') { if (/^#[0-9a-f]{3,8}$/i.test(o)) figmaRaw.add(normHex(o)); } else if (o && typeof o === 'object') Object.values(o).forEach(walkRaw); };
  walkRaw(json(cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json').components ?? {});
  // Every CSS variable Figma's variables map to (the naming convention), so a token an edit invents is told apart from
  // one the system has.
  const figmaVars = new Set();
  const vars = json(cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json');
  const spec = resolveNamingSpec(cfg);
  // Both conventions the token check uses: colours drop their trailing segment (`button/background/color` →
  // --button-background), sizing and other scalars keep every segment (`stroke/default` → --stroke-default).
  const addName = (n) => {
    if (typeof n !== 'string' || n.startsWith('_')) return;
    for (const opts of [{}, { raw: true }]) { try { const v = tokenToVar(n, spec, opts); if (v) figmaVars.add(v); } catch { /* a name the convention cannot map */ } }
  };
  for (const mode of Object.values(vars.color ?? {})) Object.keys(mode ?? {}).forEach(addName);
  for (const k of ['sizing', 'strings', 'booleans', 'primitives', 'typography', 'breakpoints']) Object.keys(vars[k] ?? {}).forEach(addName);
  for (const c of Object.values(vars.modeVariants ?? {})) Object.keys(c?.vars ?? {}).forEach(addName);
  // Build mode: every token the engine wrote out to build is Figma's, whatever the project's own mapping does.
  if (cfg.build === true) for (const m of read(TOKENS_TO_BUILD).matchAll(/(--[\w-]+)\s*:/g)) figmaVars.add(m[1]);
  // Figma's own values: a new name holding one of them is a rename at most, not a value the system lacks.
  const figmaValues = new Set();
  for (const mode of Object.values(vars.color ?? {})) for (const v of Object.values(mode ?? {})) if (/^#[0-9a-f]{3,8}$/i.test(String(v))) figmaValues.add(normHex(v));
  for (const v of Object.values(vars.sizing ?? {})) if (typeof v === 'string') figmaValues.add(v.trim().toLowerCase());
  const contracts = cfg.contracts?.out ?? 'contracts';
  const catalog = json(join(contracts, 'catalog.json'));
  const api = json(codeSnapshotPath(cfg)).api ?? {};
  const truth = steeringTruth({ catalog, api, cssVars });
  const tailwind = cfg.tailwind !== false && usesTailwind(theme, ROOT) ? themeValues(theme) : null;
  // The owner's primitives table (I42), with the project's class rules to read a styled element by its classes.
  const primitives = primitiveTable(cfg);
  const rules = primitives.length ? projectClassRules(ROOT) : new Map();
  // The static accessibility rules (I74), with the project's styles read only when an edit removes an outline.
  let styles = null;
  const a11y = cfg.a11yStatic === false ? null : { styles: () => (styles ??= projectStyleText(ROOT)) };
  return { truth, tokenByValue, figmaRaw, figmaVars, figmaValues, tailwind, primitives, rules, a11y, sizes: themeSizes(theme), themeFiles: new Set(themePaths.map((p) => resolve(ROOT, p))) };
}

// → [{ line, text }] for the lines the edit added. `fullText` is the file after the edit (for line numbers and
// the variables it declares itself).
export function editFindings(added, fullText, { truth, tokenByValue, figmaRaw = new Set(), figmaVars = null, figmaValues = new Set(), tailwind = null, primitives = [], rules = new Map(), a11y = null, sizes = null }, { isTheme = false, sheet = false, component = false, declaredBefore = null } = {}) {
  const out = [];
  const all = String(fullText ?? '').split('\n');
  const declared = new Set([...String(fullText ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const lineOf = (l) => { const i = all.indexOf(l); return i >= 0 ? i + 1 : null; };
  const seen = new Set();
  const push = (line, text, extra = {}) => { const k = `${line}|${text}`; if (!seen.has(k)) { seen.add(k); out.push({ line, text, ...extra }); } };
  for (const l of added) {
    const line = lineOf(l);
    const off = SILENCER.exec(l);
    if (off) {
      // The rules it names, so the agent knows what to fix (eslint's "-- why" and biome's ": why" are left out).
      const rules = off[1].startsWith('@ts-') ? '' : l.slice(off.index + off[0].length).replace(/\*\/[\s\S]*|-->[\s\S]*|\s--\s[\s\S]*|:[\s\S]*/, '').trim().slice(0, 80);
      push(line, `${off[1]}${rules ? ` ${rules}` : ''} switches a check off; fix what the check reports, or ask the person first`, { kind: 'silencer' });
    }
    for (const f of steeringFindings(l, truth)) {
      if (f.kind === 'variable' && !declared.has(f.found)) push(line, `var(${f.found}) is not a declared CSS variable${f.want ? `; the system has ${f.want}` : ''}`);
      else if ((f.kind === 'prop value' || f.kind === 'prop name') && componentTagIn(l, truth.components)) {
        push(line, f.kind === 'prop name'
          ? `${f.found}= is not the prop's name as the code writes it; write ${f.want}=`
          : `${f.found} is not a value this prop takes${f.want ? `; write ${f.want}` : f.valid?.length ? `; it takes ${f.valid.join(', ')}` : ''}`);
      }
    }
    if (tailwind) for (const f of arbitraryFindings(l, tailwind)) push(line, `${f.cls} is outside the theme; ${f.fix ? `write ${f.fix}` : `${f.value} is not a design-system value`}`);
    // A token the edit adds with a value of its own (a colour, a size) that Figma has no variable for: a value the
    // system does not have, wherever it is declared. One that only points at the system's tokens is composition.
    if (figmaVars?.size && declaredBefore && !COMMENT.test(l)) {
      for (const d of l.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
        const [, name, value] = d;
        if (declaredBefore.has(name) || figmaVars.has(name) || !/#[0-9a-f]{3,8}\b|\b(rgb|hsl|oklch|lab)a?\(|\d(px|rem|em)\b/i.test(value) || /^\s*var\(/.test(value)) continue;
        const v = value.trim().toLowerCase(), hex = /^#[0-9a-f]{3,8}$/.test(v) ? normHex(v) : null;
        if (figmaValues.has(hex ?? v)) continue;   // one of Figma's own values under a name of the project's
        push(line, `${name} is a new token Figma has no variable for; use one of the system's tokens, or tell the person the system has no such value (rms-design-system-engine --query <name>)`);
      }
    }
    if (/^\s*--[\w-]+\s*:/.test(l) || COMMENT.test(l)) continue;   // a token being defined, a comment
    // A custom-property declaration anywhere on the line (a minified :root{--x: #fff;…}) defines a token.
    const scan = l.replace(/--[\w-]+\s*:[^;}]*/g, ' ').replace(/var\([^)]*\)/g, ' ').replace(/&#x?[0-9a-fA-F]+;/g, ' ');
    for (const m of scan.matchAll(HEX)) {
      if (NOT_COLOUR.test(scan.slice(Math.max(0, m.index - 14), m.index))) continue;
      if (tailwind && scan[m.index - 1] === '[') continue;   // a Tailwind arbitrary value, reported above
      if (!sheet && !STYLE_PROP.test(scan.slice(0, m.index))) continue;
      if (/\.(fill|stroke|shadow)(Style|Color)\s*=\s*[^;]*$/.test(scan.slice(0, m.index))) continue;   // a canvas being painted, not the page
      const tokens = tokenByValue.get(normHex(m[0])) ?? [];
      if (!tokens.length && figmaRaw.has(normHex(m[0]))) continue;   // Figma paints it raw: reported, not invented
      // The theme file holds the system's own values: one Figma has is its to write; one Figma has nowhere is not.
      if (isTheme && (tokens.length || figmaValues.has(normHex(m[0])))) continue;
      push(line, tokens.length
        ? `${m[0]} is written by hand; use var(${tokens[0]})${tokens.length > 1 ? ` (or ${tokens.slice(1, 3).map((t) => `var(${t})`).join(', ')})` : ''}`
        : `${m[0]} is not a design-system colour; use one of its colour tokens`);
    }
    if (sizes && !isTheme) for (const f of sizeFindings(scan, sizes, { styled: /\bstyle\s*=/.test(l) })) push(line, f);   // MUI's sx={{ padding: 2 }} is a theme step, not 2px
  }
  // A plain element the edit added that is styled as a primitive the owner declared (I42).
  if (primitives.length && !sheet) {
    const addedAt = new Set(added.map(lineOf).filter(Boolean));
    for (const f of primitiveFindings(fullText, primitives, { rules })) {
      if (addedAt.has(f.line)) push(f.line, `<${f.tag}> styled by hand is the system's ${primitiveTag(f.primitive)}; use the component`);
    }
  }
  // What the static accessibility check finds where the edit added the line (I74). A rule that removes the focus
  // outline counts only when no style in the project puts focus back.
  if (a11y) {
    const addedAt = new Set(added.map(lineOf).filter(Boolean)), text = String(fullText ?? '');
    const found = sheet ? [] : markupFindings(text);
    if ((sheet || component) && /outline(-style)?\s*:\s*(none|0)\b/i.test(added.join('\n'))) {
      const css = sheet ? text : styleOnly(text);
      found.push(...cssFindings(css, `${css}\n${a11y.styles()}`));
    }
    for (const f of found) if (addedAt.has(f.line)) push(f.line, `${f.desc}${f.fix ? `; ${f.fix}` : ''}`, { kind: 'a11y' });
  }
  return out;
}

// The hook's answer: the reason Claude Code hands back to the agent, or null to stay silent.
export function editCheck(event, { root, cfg = {}, headOf = null } = {}) {
  if (cfg.hooks === false || cfg.editCheck === false) return null;
  const file = event?.tool_input?.file_path;
  if (!file || !UI.test(file)) return null;
  const abs = resolve(root, file), rel = relative(root, abs);
  if (rel.startsWith('..') || SKIP.test(rel) || /\.snapshot\.json$/.test(rel)) return null;
  if (/\.html?$/i.test(abs) && existsSync(abs.replace(/\.(html?)$/i, '.src.$1'))) return null;   // built from the .src beside it
  const head = headOf ? headOf(rel) : (() => { try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } })();
  const added = addedLines(event, { headText: head });
  if (!added.length) return null;
  const ctx = editTruth(root, cfg);
  let full = ''; try { full = existsSync(abs) ? readFileSync(abs, 'utf8') : ''; } catch { /* the edit's own text is enough */ }
  // The tokens the file declared before this edit (its committed text, else the text the edit replaced).
  const before = head ?? (event?.tool_name === 'Edit' ? String(event.tool_input?.old_string ?? '') : event?.tool_name === 'MultiEdit' ? (event.tool_input?.edits ?? []).map((e) => e.old_string).join('\n') : '');
  const declaredBefore = new Set([...String(before).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const found = editFindings(added, full || added.join('\n'), ctx, { isTheme: ctx.themeFiles.has(abs), sheet: /\.(css|scss|sass|less)$/i.test(abs), component: /\.(vue|svelte)$/i.test(abs), declaredBefore });
  if (!found.length) return null;
  const lines = found.slice(0, 12).map((f) => `  ${basename(rel)}${f.line ? `:${f.line}` : ''}  ${f.text}`);
  const n = found.length, them = n === 1 ? 'it' : 'them', count = (k) => found.filter((f) => f.kind === k).length;
  const system = n - count('silencer') - count('a11y');
  const title = system === n
    ? `rms-design-system-engine checked this edit against the design system: ${n} thing${n === 1 ? '' : 's'} it added the system does not have.`
    : `rms-design-system-engine checked this edit: ${n} thing${n === 1 ? '' : 's'} to fix.`;
  const next = count('silencer') === n
    ? `Take ${them} out and fix what the check reports. When that cannot be done, ask the person before switching a check off.`
    : `Fix ${them} in this file now.${system ? ' Not sure of a name? rms-design-system-engine --query <name>.' : ''}${count('silencer') ? ' A comment that switches a check off comes out; when what it hides cannot be fixed, ask the person.' : ''}`;
  return `${title}\n${lines.join('\n')}${n > 12 ? `\n  and ${n - 12} more` : ''}\n${next}`;
}

export function editHookOutput(reason) {
  return reason ? JSON.stringify({ decision: 'block', reason }) : '';
}

// Before the agent says it is done (the Stop hook, I81 second part): the same check over every UI file the session
// changed against the last commit, so a value the system does not have that an edit left in place (the agent asked
// the person instead of taking it out) is handed back once. → [lines] ('ui.html:12  #2d8659 is not …'), [] when clean.
export function sessionLeftovers(root, cfg = {}) {
  if (cfg.hooks === false || cfg.editCheck === false) return [];
  const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  const changed = [...new Set([...git(['diff', '--name-only', 'HEAD']).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')])]
    .map((f) => f.trim()).filter((f) => f && UI.test(f) && !SKIP.test(f) && existsSync(join(root, f))).slice(0, 40);
  const out = [];
  for (const rel of changed) {
    let now = ''; try { now = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const head = (() => { try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } })();
    const reason = editCheck({ tool_name: 'Write', tool_input: { file_path: join(root, rel), content: now } }, { root, cfg, headOf: () => head });
    if (reason) out.push(...reason.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => `  ${rel}${l.trim().replace(/^[^\s:]+/, '')}`));
  }
  return out;
}
