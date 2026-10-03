// a11y-static.mjs - the accessibility checks that need no browser (idea I34).
//
// The browser check needs a page to open; with no dev server, styleguide or gallery it cannot run and gives no
// signal at all. These checks read the code and the CSS the project already has, so they always run, the same
// on every machine and in CI, and the browser check deepens them when it can run. Framework-heuristic like the
// engine's other source readers, advisory, never a failed build:
//   • a control with no accessible name: a button with only an icon inside and no aria-label, aria-labelledby or
//     title; an image with no alt; a text field with no label, aria-label or aria-labelledby;
//   • CSS that removes the focus outline and never puts a focus style back;
//   • a positive tabindex (it breaks the reading order);
//   • a click handler on a div or span with no role and no tabindex (a mouse-only control);
//   • an aria-* attribute that does not exist;
//   • a link with no accessible name, an image whose alt is a file name;
//   • aria-hidden="true" on an element that takes focus (a keyboard reaches what a screen reader cannot see);
//   • a page with no lang, a viewport that blocks zoom (user-scalable=no, maximum-scale=1);
//   • a page with no main heading, or several (I79): a document with text in its body has one h1 (an app shell
//     its scripts fill has no text, and a template whose content comes from elsewhere is not read);
//   • animations with no prefers-reduced-motion alternative anywhere in the project.
// An element whose attributes are spread ({...props}, v-bind="$attrs") can receive them from outside: it is
// never reported. A finding that does not say its fix in `desc` carries it in `fix`, for the check of each edit
// (edit-check.mjs, idea I74), which hands the fix back to the agent that wrote the line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { ENGINE_DIRS } from './names.mjs';

const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '.nuxt', 'coverage', ...ENGINE_DIRS, 'contracts', 'storybook-static', 'vendor']);
const MARKUP = new Set(['.html', '.htm', '.vue', '.jsx', '.tsx', '.svelte']);
const STYLE = new Set(['.css', '.scss', '.less', '.vue', '.svelte']);

// Every ARIA 1.2 state and property.
const ARIA = new Set(('activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext ' +
  'colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden ' +
  'invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed ' +
  'readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow ' +
  'valuetext').split(' '));

const lineAt = (text, i) => text.slice(0, i).split('\n').length;
// The ARIA attribute a misspelt one meant: one letter added, missing, changed or two swapped.
export function closestAria(name) {
  const n = String(name ?? '').toLowerCase();
  const near = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  };
  return [...ARIA].find((a) => near(n, a)) ?? null;
}
// A name given inside the element: an image's alt, an svg <title>, an aria-label on a child.
const innerName = (inner) => /<img\b[^>]*\balt\s*=\s*["'][^"']*\w[^"']*["']/i.test(inner) || /<title>\s*[^<\s][^<]*<\/title>/i.test(inner) || /\baria-label\s*=\s*["'][^"']*\w/i.test(inner);
const visibleText = (inner) => inner.replace(/<[^>]*aria-hidden\s*=\s*["']?true["']?[^>]*>[\s\S]*?<\/[^>]+>/gi, '').replace(/<[^>]+>/g, '').trim();
const spread = (attrs) => /\{\s*\.\.\.|v-bind\s*=\s*["']\$attrs|v-bind\s*=\s*["']\$props|\{\.\.\./.test(attrs);
const has = (attrs, name) => new RegExp(`(?:^|\\s|:|v-bind:)${name}\\s*=`, 'i').test(attrs) || new RegExp(`(?:^|\\s):${name}\\b`, 'i').test(attrs);

// Markup: HTML, JSX, Vue and Svelte templates. → [{ line, kind, desc }]
export function markupFindings(text) {
  const out = [];
  const src = String(text ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const [, attrs, inner] = m;
    if (spread(attrs) || has(attrs, 'aria-label') || has(attrs, 'aria-labelledby') || has(attrs, 'title')) continue;
    if (/<slot\b|\{\{|\{[^}]*\}|<Slot\b|\$slots|children/.test(inner)) continue;   // text from the caller
    if (/<\w+\b[^>]*\bid\s*=\s*["'][^"']+["'][^>]*>\s*<\//.test(inner)) continue;   // an empty element with an id: a script fills it
    if (!visibleText(inner) && !innerName(inner)) out.push({ line: lineAt(src, m.index), kind: 'name', desc: 'a button with only an icon inside and no aria-label, aria-labelledby or title', fix: 'add aria-label="<what it does>"' });
  }
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const [, attrs, inner] = m;
    if (!has(attrs, 'href') || spread(attrs) || has(attrs, 'aria-label') || has(attrs, 'aria-labelledby') || has(attrs, 'title')) continue;
    if (/<slot\b|\{\{|\{[^}]*\}|<Slot\b|\$slots|children/.test(inner)) continue;   // text from the caller
    if (!visibleText(inner) && !innerName(inner)) out.push({ line: lineAt(src, m.index), kind: 'name', desc: 'a link with only an icon inside and no aria-label, aria-labelledby or title', fix: 'add aria-label="<where it goes>"' });
  }
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) {
    if (!spread(m[1]) && !has(m[1], 'alt') && !has(m[1], 'aria-label') && !has(m[1], 'aria-labelledby') && !/role\s*=\s*["']presentation|role\s*=\s*["']none/i.test(m[1]))
      out.push({ line: lineAt(src, m.index), kind: 'name', desc: 'an image with no alt (use alt="" when it is decorative)', fix: 'add alt="<what it shows>"' });
    const alt = /\balt\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (alt && /^[\w./-]+\.(png|jpe?g|gif|svg|webp|avif)$/i.test(alt.trim()))
      out.push({ line: lineAt(src, m.index), kind: 'name', desc: `an image whose alt is a file name ("${alt.trim()}"): describe the image, or use alt="" when it is decorative` });
  }
  for (const m of src.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (/type\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(attrs) || spread(attrs)) continue;
    if (has(attrs, 'aria-label') || has(attrs, 'aria-labelledby') || has(attrs, 'id') || has(attrs, 'title')) continue;   // an id can be a label's for
    const before = src.slice(0, m.index), open = before.lastIndexOf('<label'), close = before.lastIndexOf('</label>');
    if (open > close) continue;   // inside a <label>
    out.push({ line: lineAt(src, m.index), kind: 'name', desc: 'a text field with no label, aria-label or aria-labelledby', fix: 'give it a <label>, or aria-label="<what to type>"' });
  }
  for (const m of src.matchAll(/\btab[iI]ndex\s*=\s*\{?\s*["']?([1-9]\d*)/g))
    out.push({ line: lineAt(src, m.index), kind: 'keyboard', desc: `tabindex="${m[1]}": a positive tabindex breaks the order a keyboard moves in (use 0 or -1)` });
  for (const m of src.matchAll(/<(div|span)\b([^>]*)>/gi)) {
    const attrs = m[2];
    if (!/(?:^|\s)(onClick|@click|v-on:click|on:click)\b/.test(attrs) || spread(attrs)) continue;
    if (has(attrs, 'role') && /tab[iI]ndex/.test(attrs)) continue;
    out.push({ line: lineAt(src, m.index), kind: 'keyboard', desc: `a clickable <${m[1]}> with no ${has(attrs, 'role') ? 'tabindex' : 'role and no tabindex'}: a keyboard cannot reach it (use a <button>)` });
  }
  for (const m of src.matchAll(/<(button|a|input|select|textarea|summary|[a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, tag, attrs] = m;
    if (!/(?:^|\s)aria-hidden\s*=\s*(\{\s*true\s*\}|["']true["'])/.test(attrs)) continue;
    const focusable = /^(button|input|select|textarea|summary)$/i.test(tag) || (/^a$/i.test(tag) && has(attrs, 'href')) || /\btab[iI]ndex\s*=\s*\{?\s*["']?(0|[1-9]\d*)\b/.test(attrs);
    if (focusable && !/\btab[iI]ndex\s*=\s*\{?\s*["']?-1\b/.test(attrs) && !/\bdisabled\b/.test(attrs))
      out.push({ line: lineAt(src, m.index), kind: 'aria', desc: `aria-hidden="true" on a <${tag}> that takes focus: a keyboard reaches what a screen reader cannot see`, fix: 'take aria-hidden off, or take it out of the tab order with tabindex="-1"' });
  }
  // Only a page's own root: the document starts with <!doctype html> or <html> (an <html> in prose or a comment is not one).
  const root = /^\s*(?:<!doctype html[^>]*>\s*)?(<html\b([^>]*)>)/i.exec(src);
  if (root && !has(root[2], 'lang') && !spread(root[2]))
    out.push({ line: lineAt(src, root.index + root[0].indexOf(root[1])), kind: 'language', desc: 'a page with no lang: a screen reader cannot pick the voice (add lang="en", or the page\'s language)' });
  if (root) {
    const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(src)?.[1] ?? '';
    const text = body.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').trim();
    const h1 = [...src.matchAll(/<h1\b|<[a-z][\w-]*\b(?=[^>]*\brole\s*=\s*["']heading["'])(?=[^>]*\baria-level\s*=\s*["']1["'])[^>]*>/gi)];
    const template = /\{%|\{\{|<%|@yield|@section|<slot\b|<router-view\b|<ng-content\b|<ui-view\b|<Outlet\b/.test(body);   // its content comes from elsewhere
    if (text && !h1.length && !template) out.push({ line: lineAt(src, root.index + root[0].indexOf(root[1])), kind: 'heading', desc: 'a page with no main heading (h1): a screen reader cannot jump to what the page is about', fix: 'add one <h1> that names the page (it can be visually hidden)' });
    if (h1.length > 1) out.push({ line: lineAt(src, h1[1].index), kind: 'heading', desc: `a page with ${h1.length} main headings (h1): one names the page`, fix: 'keep one <h1> and make the others <h2> or below' });
  }
  for (const m of src.matchAll(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/gi)) {
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '';
    if (/user-scalable\s*=\s*(no|0)\b|maximum-scale\s*=\s*1(\.0+)?\b(?!\.\d*[1-9])/i.test(content))
      out.push({ line: lineAt(src, m.index), kind: 'zoom', desc: `the viewport blocks zoom (${content.trim()}): people who need larger text cannot zoom in`, fix: 'take out user-scalable=no and maximum-scale=1' });
  }
  // A name written after a spread replaces the one the caller passes: <input {...props} aria-label={label} /> gives
  // <Field aria-label="Name" /> no name at all when label is not set.
  for (const tag of jsxOpenTags(src)) {
    const spreadAt = [...tag.attrs.matchAll(/\{\s*\.\.\.\s*([\w$.]+)\s*\}/g)];
    if (!spreadAt.length) continue;
    const last = spreadAt.at(-1);
    for (const a of tag.attrs.slice(last.index + last[0].length).matchAll(/(?:^|\s)(aria-label|aria-labelledby)\s*=\s*\{([^}]*)\}/g)) {
      if (a[2].includes(last[1].split('.')[0]) || /\?\?|\|\|/.test(a[2])) continue;   // it falls back to what the caller passed
      out.push({ line: lineAt(src, tag.index), kind: 'name', desc: `${a[1]}={${a[2].trim()}} after {...${last[1]}} replaces the ${a[1]} the caller passes (with nothing when ${a[2].trim()} is not set)`, fix: `put ${a[1]} before the spread, or write ${a[1]}={${a[2].trim()} ?? ${last[1]}['${a[1]}']}` });
    }
  }
  for (const m of src.matchAll(/\baria-([a-z]+)\s*=/g))
    if (!ARIA.has(m[1])) { const near = closestAria(m[1]); out.push({ line: lineAt(src, m.index), kind: 'aria', desc: `aria-${m[1]} is not an ARIA attribute`, ...(near ? { fix: `write aria-${near}` } : {}) }); }
  return out;
}

// The opening tags of JSX elements, with their attributes read past braces (an arrow's => is not the tag's end).
function jsxOpenTags(src) {
  const out = [];
  for (const m of src.matchAll(/<([A-Za-z][\w.-]*)\b/g)) {
    let i = m.index + m[0].length, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') { if (depth || /=\s*$/.test(src.slice(Math.max(0, i - 3), i))) quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    if (i - m.index < 4000) out.push({ tag: m[1], attrs: src.slice(m.index + m[0].length, i), index: m.index });
  }
  return out;
}

// CSS rules as { selectors:[...], decls, index }, from plain CSS or a <style> block, nested @-rules flattened.
function cssRules(text) {
  const css = String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rules = [];
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith('@')) continue;
    rules.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), decls: m[2], index: m.index + (m[1].length - m[1].trimStart().length) });
  }
  return { css, rules };
}
const removesOutline = (decls) => /(^|[;\s])outline\s*:\s*(none|0)\b/i.test(decls) || /(^|[;\s])outline-style\s*:\s*none\b/i.test(decls);
const showsFocus = (decls) => (/(^|[;\s])outline\s*:/i.test(decls) && !removesOutline(decls)) || /(^|[;\s])(box-shadow|border(-color|-bottom|-width)?|background(-color)?|text-decoration)\s*:/i.test(decls);
// A wrapper that shows focus for the field inside it: .field__input in .field:focus-within, .searchInput in
// .searchBox:focus-within (their first class names share a stem of four letters or more).
const firstClass = (sel) => (sel.match(/\.([A-Za-z][\w-]*)/) ?? [])[1] ?? '';
const sameFamily = (a, b) => {
  const x = firstClass(a).toLowerCase(), y = firstClass(b).toLowerCase();
  let n = 0; while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n >= 4 || (x && y && x.startsWith(y));
};
const base = (sel) => sel.replace(/:(focus-visible|focus-within|focus|hover|active)\b/g, '').replace(/::?[\w-]+(\([^)]*\))?$/, '').trim();

// Styles: every rule that removes the focus outline must have a focus style for the same element somewhere.
// `all` holds the text of every style file, so a restore in another file counts. → [{ line, kind, desc }]
export function cssFindings(text, all = text) {
  const out = [];
  const { css, rules } = cssRules(text);
  const every = cssRules(all).rules;
  for (const r of rules) {
    if (!removesOutline(r.decls)) continue;
    for (const sel of r.selectors) {
      const onFocus = /:focus/.test(sel);
      if (!onFocus && /:(hover|active|disabled|checked|visited)\b|\[disabled\]|\[aria-disabled/.test(sel)) continue;   // another state, not focus
      const b = base(sel);
      if (onFocus && showsFocus(r.decls.replace(/outline[^;]*;?/gi, ''))) continue;   // replaced in the same rule
      const restored = every.some((x) => x.selectors.some((s) => /:focus/.test(s) && base(s) === b && (s !== sel)) && showsFocus(x.decls))
        || every.some((x) => x.selectors.some((s) => /:focus-within/.test(s) && sameFamily(b, base(s)) && base(s) !== b) && showsFocus(x.decls));
      if (!restored) out.push({ line: lineAt(css, r.index), kind: 'focus', desc: `${sel} removes the focus outline and no focus style puts one back`, fix: `add a ${b || sel}:focus-visible style that shows where focus is` });
    }
  }
  return out;
}

// A component file with only its <style> blocks left, everything else blanked, so line numbers stay the file's.
export function styleOnly(text) {
  const t = String(text ?? '');
  let out = '', last = 0;
  for (const m of t.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi)) {
    const start = m.index + m[1].length;
    out += t.slice(last, start).replace(/[^\n]/g, ' ') + m[2];
    last = start + m[2].length;
  }
  return out + t.slice(last).replace(/[^\n]/g, ' ');
}

function walk(ROOT, exts, limit = 4000) {
  const files = [];
  const go = (dir, depth) => {
    if (files.length >= limit || depth > 8) return;
    let names; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (SKIP_DIR.has(n) || n.startsWith('.')) continue;
      const abs = join(dir, n);
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) go(abs, depth + 1);
      else if (exts.has(extname(n).toLowerCase()) && st.size < 512 * 1024) files.push(abs);
    }
  };
  go(ROOT, 0);
  return files;
}

// Every style file of the project as one text (a component file's <style> blocks only): a focus style put back in
// another file counts.
export function projectStyleText(ROOT) {
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  return walk(ROOT, STYLE).map((f) => (['.vue', '.svelte'].includes(extname(f)) ? styleOnly(read(f)) : read(f))).join('\n');
}

// The whole project: [{ file, line, kind, desc }], and how many files each side read.
export function staticA11y(ROOT) {
  const findings = [];
  const markup = walk(ROOT, MARKUP), styles = walk(ROOT, STYLE);
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  for (const f of markup) for (const x of markupFindings(read(f))) findings.push({ file: relative(ROOT, f), ...x });
  const styleText = new Map(styles.map((f) => [f, ['.vue', '.svelte'].includes(extname(f)) ? styleOnly(read(f)) : read(f)]));
  const all = [...styleText.values()].join('\n');
  for (const [f, text] of styleText) for (const x of cssFindings(text, all)) findings.push({ file: relative(ROOT, f), ...x });
  // Animations with no reduced-motion alternative anywhere: reported once, at the first animation.
  const scripts = walk(ROOT, new Set(['.js', '.mjs', '.ts']));
  const reduced = /prefers-reduced-motion/.test(all) || markup.some((f) => /prefers-reduced-motion/.test(read(f))) || scripts.some((f) => /prefers-reduced-motion/.test(read(f)));
  if (!reduced) {
    for (const [f, text] of styleText) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
      const a = /(?:^|[;{\s])animation(?:-name)?\s*:(?!\s*(?:none|initial|inherit|unset)\s*[;}])\s*[^;}\s][^;}]*/.exec(css);
      if (a) { findings.push({ file: relative(ROOT, f), line: lineAt(css, a.index + (a[0].match(/^\s*[;{]?\s*/)?.[0].length ?? 0)), kind: 'motion', desc: 'an animation, and no prefers-reduced-motion alternative anywhere in the project: people who get sick from motion cannot turn it off' }); break; }
    }
  }
  return { findings, files: { markup: markup.length, styles: styles.length } };
}
