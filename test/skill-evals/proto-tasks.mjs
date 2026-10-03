// test/skill-evals/proto-tasks.mjs - the prototype evaluation: a designer asks for a screen made with the design system,
// to Claude alone and to Claude with the skill. Same project (Tidepool with its tokens and four components built), same
// prompt, same model. Each request holds one thing the system does not have (a switch, an illustration) or none. Two
// more ask what Figma alone does not say: a page for the same app as the Settings page already made (its frame and
// heading kept), a request one of the team's written guidelines changes (one button per screen), and the same with the
// guidelines as they arrive from the team's GitLab and Notion links (a confirmation is not a tag).
//
// Scored without the engine, the same way whoever made it:
//   • the design system is unchanged (no token, component or stylesheet of it edited, no new component added);
//   • nothing is invented: no component defined for the prototype, no look of its own (a class styled with colour,
//     border, radius, shadow or type other than one of the system's tokens), no colour or size the system does not have;
//   • it is built from the system's components the request needs;
//   • the reply says what the system lacks, when the request holds something it lacks;
//   • the page is arranged like the product's other page, and follows the team's guidelines, where the task says so.
import { cpSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offSystemValues } from './build-score.mjs';
import { TIDEPOOL, TOKENS } from './build-tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, 'build-reference');
const check = (name, ok, detail = '') => ({ name, ok: !!ok, detail });
const withSystem = (dir) => { cpSync(join(REF, 'src/styles'), join(dir, 'src/styles'), { recursive: true }); cpSync(join(REF, 'src/components'), join(dir, 'src/components'), { recursive: true }); };
const FIX = join(HERE, 'proto-fixtures');
// The product's Settings page, already made from its designed screen (both sides get the same file).
const withSettingsPage = (dir) => { withSystem(dir); mkdirSync(join(dir, 'prototypes'), { recursive: true }); cpSync(join(FIX, 'settings.json'), join(dir, 'prototypes', 'settings.json')); };
// The team's guidelines, kept in the project and listed in its config, the way a team keeps them.
const withGuidelines = (dir) => {
  withSystem(dir);
  cpSync(join(FIX, 'guidelines.md'), join(dir, 'guidelines.md'));
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify({ ...cfg, guidelines: { sources: ['guidelines.md'] } }, null, 2) + '\n');
};

const DECLARED = new Set(Object.keys(TOKENS.light));
// The classes the system's own CSS defines: a rule on any other class with a look of its own is a look invented here.
const SYSTEM_CLASSES = new Set(readdirSync(join(REF, 'src/components')).filter((f) => f.endsWith('.css'))
  .flatMap((f) => [...readFileSync(join(REF, 'src/components', f), 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])));
const LOOK = /^(background(-color)?|border(-(top|right|bottom|left))?(-(color|width|style))?|border-radius|color|box-shadow|outline|font(-(size|weight|family))?|line-height|opacity|fill|stroke)$/;
const LAYOUT_SIZE = /^(width|max-width|min-width|height|max-height|min-height|flex|flex-basis|grid-template-columns|grid-template-rows)$/;
// The declarations the system's own CSS writes (its type is written as a font shorthand, with no token), with the
// shorthand's longhands: a rule repeating one of them uses the system's value.
const norm = (p, v) => `${p}:${v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim().toLowerCase()}`;
const SYSTEM_DECLS = new Set();
for (const f of readdirSync(join(REF, 'src/components')).filter((n) => n.endsWith('.css'))) {
  for (const m of readFileSync(join(REF, 'src/components', f), 'utf8').matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
    const [p, v] = [m[1], m[2].trim()];
    SYSTEM_DECLS.add(norm(p, v));
    const font = p === 'font' && v.match(/^(\d{3})\s+(\d+px)\/(\d+px)\s+(.+)$/);
    if (font) [['font-weight', font[1]], ['font-size', font[2]], ['line-height', font[3]], ['font-family', font[4]]].forEach(([lp, lv]) => SYSTEM_DECLS.add(norm(lp, lv)));
  }
}
// A look set with one of the system's own tokens and nothing else (a page surface, a text colour) is the system's look.
const tokenOnly = (v) => { const m = v.replace(/\s*!important$/i, '').match(/^var\(\s*(--[\w-]+)\s*\)$/); return !!m && DECLARED.has(m[1]); };

// The CSS a run wrote: stylesheets, <style> blocks, and style={{ … }} objects in JSX (camelCase keys made CSS names).
function cssOf(file) {
  const t = String(file.text ?? '');
  if (/\.s?css$/.test(file.path)) return t;
  const blocks = [...t.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const inline = [...t.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((m) => `.inline{${m[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/['"]/g, '').replace(/,(?=\s*[a-z-]+\s*:)/g, ';')}}`);
  const attr = [...t.matchAll(/\sstyle="([^"]*)"/g)].map((m) => `.inline{${m[1]}}`);
  return [...blocks, ...inline, ...attr].join('\n');
}
function rules(css) {
  const out = [];
  for (const m of String(css).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls = m[2].split(';').map((d) => d.split(':')).filter((d) => d.length >= 2).map(([p, ...v]) => [p.trim().toLowerCase(), v.join(':').trim()]);
    out.push({ selector: m[1].trim(), decls });
  }
  return out;
}

// The system's own files (its tokens and its four components). Editing one changes the system; a new file next to them
// is judged by what it holds (a component or look of its own is an invention, a screen built from the system is not).
const SYSTEM_FILES = new Set([...readdirSync(join(REF, 'src/styles')).map((f) => `src/styles/${f}`), ...readdirSync(join(REF, 'src/components')).map((f) => `src/components/${f}`)]);
// What a run made for the prototype: every file it wrote that is not one of the system's own.
const made = (ctx) => ctx.changed.filter((p) => !SYSTEM_FILES.has(p)).map((p) => ({ path: p, text: ctx.read(p) })).filter((f) => f.text != null);

export function systemUnchanged(ctx) {
  const touched = ctx.changed.filter((p) => SYSTEM_FILES.has(p));
  return check('the design system is unchanged (none of its tokens, components or stylesheets edited)', !touched.length, touched.join(', '));
}

export function inventsNothing(ctx) {
  const bad = [];
  for (const f of made(ctx)) {
    // A component defined for the prototype: a capitalised function or const that returns markup, other than the screen
    // itself (the file's default or only export).
    if (/\.(jsx|tsx|js)$/.test(f.path)) {
      const defs = [...f.text.matchAll(/(?:function\s+([A-Z]\w*)\s*\(|(?:const|let)\s+([A-Z]\w*)\s*=\s*(?:\([^)]*\)|\w+)\s*=>)/g)].map((m) => m[1] ?? m[2]);
      const exported = [...f.text.matchAll(/export\s+(?:default\s+)?(?:function\s+|const\s+)?([A-Z]\w*)/g)].map((m) => m[1]);
      const extra = defs.filter((d) => !exported.includes(d));
      if (extra.length && defs.length > 1) bad.push(`${f.path}: defines ${extra.join(', ')} for the prototype`);
    }
    for (const v of offSystemValues(cssOf(f), DECLARED)) bad.push(`${f.path}: ${v}`);
    for (const r of rules(cssOf(f))) {
      const classes = [...r.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
      const own = r.selector === '.inline' || classes.some((c) => !SYSTEM_CLASSES.has(c)) || !classes.length;
      for (const [p, v] of r.decls) {
        if (SYSTEM_DECLS.has(norm(p, v))) continue;
        if (own && LOOK.test(p) && !tokenOnly(v) && !/^(inherit|initial|unset|transparent|none|currentcolor)$/i.test(v)) { bad.push(`${f.path}: ${r.selector} sets ${p} (a look of its own)`); break; }
        if (/(?<![\w.-])(?!0px)\d*\.?\d+px\b/.test(v) && !LAYOUT_SIZE.test(p)) { bad.push(`${f.path}: ${p}: ${v} (a size the system does not have)`); break; }
      }
    }
  }
  return check('invents nothing: no component of its own, no look of its own, no colour or size the system does not have', !bad.length, [...new Set(bad)].slice(0, 6).join('; '));
}

// The system's components a request needs, found in whatever the run made: JSX, HTML classes or a composition.
export function usesSystem(ctx, names) {
  const text = made(ctx).map((f) => f.text).join('\n');
  const missing = names.filter((n) => {
    const cap = n.charAt(0).toUpperCase() + n.slice(1);
    return !(new RegExp(`<${cap}\\b`).test(text) || new RegExp(`class(Name)?=["'{][^"'}]*(?<![\\w-])${n}(?![\\w-])`).test(text) || new RegExp(`"component"\\s*:\\s*"${n}"`, 'i').test(text));
  });
  return check(`built from the system's ${names.join(', ')}`, !missing.length, missing.length ? `no ${missing.join(', ')}` : '');
}

// The reply names what the system lacks: the thing, near a word saying it is not there.
export function namesGap(text, thing) {
  const t = String(text ?? '');
  const NOT = "\\b(no|not|n['’]t|missing|lacks?|lacking|without|none|gaps?|closest|would need|doesn['’]t|does not|isn['’]t|is not|stand-?in|instead|placeholder|substitut\\w*)\\b";
  return new RegExp(`(${thing})[\\s\\S]{0,160}${NOT}|${NOT}[\\s\\S]{0,160}(${thing})`, 'i').test(t);
}

// The made page's frame and heading, from a composition or from CSS: { padding, gap, heading } as spacing token or
// text style names ('padding/m', 'm'), or the raw value when it is none of them.
const SPACE = { 'padding/m': ['var(--padding-m)', '12px'], 'padding/s': ['var(--padding-s)', '8px'], 'padding/xs': ['var(--padding-xs)', '4px'] };
const spaceName = (v) => { const t = String(v ?? '').trim().split(/\s+/); const n = Object.keys(SPACE).find((k) => SPACE[k].includes(t[0])); return n && t.every((x) => SPACE[n].includes(x)) ? n : (v ?? null); };
export function pageOf(ctx) {
  for (const f of made(ctx)) {
    if (!/\.json$/.test(f.path) || /conventions|package/.test(f.path) || /prototypes\/settings\.json$/.test(f.path)) continue;
    let j; try { j = JSON.parse(f.text); } catch { continue; }
    const ui = j?.prototype ?? j;
    const flat = Array.isArray(ui?.components) ? ui.components : null;
    const root = flat ? flat.find((c) => c.id === (ui.root ?? flat[0]?.id)) : ui;
    if (!root?.component) continue;
    const all = []; const walk = (n) => { if (!n || typeof n !== 'object') return; all.push(n); (n.children ?? []).forEach((k) => walk(typeof k === 'object' ? k : flat?.find((c) => c.id === k))); };
    walk(root);
    const p = (n) => ({ ...n, ...(n.props ?? {}) });
    const h = all.map(p).find((n) => n.component === 'Text' && n.as === 'h1') ?? all.map(p).find((n) => n.component === 'Text');
    return { padding: p(root).padding ?? null, gap: p(root).gap ?? null, heading: h?.style ?? null };
  }
  const css = made(ctx).map(cssOf).join('\n');
  const rs = rules(css);
  const block = rs.find((r) => /^\.[a-zA-Z][\w-]*$/.test(r.selector) && !r.selector.includes('__') && !SYSTEM_CLASSES.has(r.selector.slice(1)) && r.decls.some(([p]) => p === 'padding'))
    ?? rs.find((r) => r.selector === '.inline' && r.decls.some(([p]) => p === 'padding'));
  const head = rs.find((r) => /(^|[\s.,_-])(h1|title|heading)\b/i.test(r.selector) && r.decls.some(([p]) => /^font(-size)?$/.test(p)));
  const size = head?.decls.find(([p]) => p === 'font-size')?.[1] ?? head?.decls.find(([p]) => p === 'font')?.[1]?.match(/(\d+px)/)?.[1] ?? null;
  return { padding: block ? spaceName(block.decls.find(([p]) => p === 'padding')[1]) : null, gap: block ? spaceName(block.decls.find(([p]) => p === 'gap')?.[1] ?? null) : null, heading: size === '14px' ? 'm' : size === '12px' ? 's' : size };
}

// The page is arranged as the product's Settings page: padding/m from the edge and between parts, heading in m.
export function matchesProduct(ctx) {
  const pg = pageOf(ctx);
  const off = [['padding', 'padding/m'], ['gap', 'padding/m'], ['heading', 'm']].filter(([k, v]) => pg[k] !== v).map(([k, v]) => `${k} ${pg[k] ?? 'not set'} (Settings: ${v})`);
  return check('arranged like the product\'s Settings page (padding/m, padding/m between parts, heading in text style m)', !off.length, off.join(', '));
}

// The guidelines' one button per screen: the system's button used once at most.
export function oneButton(ctx) {
  const text = made(ctx).map((f) => f.text).join('\n');
  const n = (text.match(/<Button\b/g) ?? []).length + (text.match(/class(Name)?=["'{][^"'}]*(?<![\w-])button(?![\w-])/g) ?? []).length + (text.match(/"component"\s*:\s*"button"/gi) ?? []).length;
  return check('one button on the screen, as the guidelines say (any other action is a link)', n <= 1, `${n} buttons`);
}

// The team's guidelines as they arrive from its links: the design team keeps them in GitLab and Notion, and ds-config
// lists the links; the files they were fetched into are committed in guidelines/, as the engine writes them.
const withLinkedGuidelines = (dir) => {
  withSystem(dir);
  mkdirSync(join(dir, 'guidelines'), { recursive: true });
  cpSync(join(FIX, 'linked', 'gitlab-components.md'), join(dir, 'guidelines', 'gitlab-components.md'));
  cpSync(join(FIX, 'linked', 'notion-voice.md'), join(dir, 'guidelines', 'notion-voice.md'));
  const cfg = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify({ ...cfg, guidelines: { source: {
    gitlab: [{ url: 'https://gitlab.com/tidepool-ds/design/-/blob/main/docs/components.md', file: 'guidelines/gitlab-components.md' }],
    notion: [{ url: 'https://www.notion.so/tidepool/Voice-and-layout-0123456789abcdef0123456789abcdef', file: 'guidelines/notion-voice.md' }],
  } } }, null, 2) + '\n');
};

// A component the request tempts and the guidelines rule out, found in whatever the run made.
export function avoids(ctx, name, why) {
  const text = made(ctx).map((f) => f.text).join('\n');
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  const used = new RegExp(`<${cap}\\b`).test(text) || new RegExp(`class(Name)?=["'{][^"'}]*(?<![\\w-])${name}(?![\\w-])`).test(text) || new RegExp(`"component"\\s*:\\s*"${name}"`, 'i').test(text);
  return check(`no ${name}, as the guidelines say (${why})`, !used, used ? `${name} used` : '');
}

const base = { mayChangeAll: true, mayWriteHtml: true, setup: withSystem, source: TIDEPOOL };
export const PROTO = [
  {
    ...base, id: 'proto-settings',
    prompt: 'prototype a notification settings page with our design system: a title, a switch to turn email notifications on or off and one for push, and a Save button that shows a confirmation once saved.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['button']),
      check('says the system has no switch', namesGap(ctx.final, 'switch(es)?|toggle(s)?'))],
  },
  {
    ...base, id: 'proto-search',
    prompt: 'prototype a search results header with our design system: a search field, filter chips for Today, This week and This month with a New label next to the first one, and a Search button.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['field', 'chip', 'tag', 'button'])],
  },
  {
    ...base, id: 'proto-empty',
    prompt: 'prototype an empty state for the projects list with our design system: a heading, one sentence saying there are no projects yet, an illustration, and a button to create a project.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['button']),
      check('says the system has no illustration', namesGap(ctx.final, 'illustrations?|images?|pictures?|artwork|graphic'))],
  },
  {
    // Pages of the same product: the new page keeps the frame and heading of the one already made.
    ...base, id: 'proto-profile', setup: withSettingsPage,
    prompt: 'prototype a profile page with our design system, for the same app as our settings page: a heading, a field for the name, a field for the email, and a Save button.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['field', 'button']), matchesProduct(ctx)],
  },
  {
    // The team's documentation: a request that one of its rules changes.
    ...base, id: 'proto-dialog', setup: withGuidelines,
    prompt: 'prototype a delete project confirmation with our design system: a heading, one sentence warning that it cannot be undone, a Delete button and a Cancel button.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['button']), oneButton(ctx),
      check('says the system has no link for the other action', namesGap(ctx.final, 'links?'))],
  },
  {
    // The team's documentation as it arrives from its GitLab and Notion links: a confirmation is not a tag.
    ...base, id: 'proto-linked', setup: withLinkedGuidelines,
    prompt: 'prototype an account settings page with our design system: a heading, a field for the display name, a Save button, and a message confirming the changes were saved.',
    score: async (ctx) => [systemUnchanged(ctx), inventsNothing(ctx), usesSystem(ctx, ['field', 'button']), avoids(ctx, 'tag', 'a tag is never a message that comes and goes'),
      check('says the system has no toast or banner for the confirmation', namesGap(ctx.final, 'toasts?|banners?|snackbars?|notifications?|alerts?|confirmation (message|component)'))],
  },
];
