// role-markup.mjs - what a Figma role annotation asks of a component, read from its source without a browser (I85).
//
// A role is a composite of obligations (Nathan Curtis, "Component and Part Roles as Composites"): a toggle button is
// a real button, that carries aria-pressed even when off, that has a spoken name. Each obligation is checked where it
// can be: here in the component's source (Gate [15]), in the browser on a rendered page (a11y-check.mjs), and listed in
// the build sheet before the component exists. An obligation the source cannot meet by itself, such as the name of a
// control that shows only an icon, is reported as owed (the annotation or the person says what), never invented.
// Only what the source shows for certain is reported: a component whose root is the system's own component
// (<Button>) may get the role from it, so it is left to the browser check.
//
// Role words as Figma's annotations and Specs write them; only legal ARIA is expected in the page.

const BUTTON = /<button\b|role\s*=\s*["'{]?\s*["']?button\b/i;
const FIELD = /<input\b(?![^>]*type\s*=\s*["'](?:checkbox|radio|button|submit|range|hidden)["'])|<textarea\b|role\s*=\s*["']textbox/i;
const LABELLED = /<label\b|aria-label(?:ledby)?\s*=|htmlFor\s*=|\bfor\s*=\s*["']/i;
// A spoken name: an aria-label or aria-labelledby, a title, or text the element renders (a word, or {a prop}).
const NAMED = /aria-label(?:ledby)?\s*=|\btitle\s*=|>\s*[^<>{}\s][^<>{}]*</i;
// A prop rendered as a child: >{label}<, or after another child ({icon && <Icon />}{label}).
const NAMED_BY_PROP = /[>}]\s*\{\s*(?:children|label|Label|text|Text|title|Title|value|name)\b[^}]*\}/;
// The element spreads the rest of its props ({...rest}): whoever uses it can give it aria-label.
const SPREAD = /<[a-z][\w-]*\b[^>]*\{\s*\.\.\.\s*[\w$]+\s*\}/;
const named = (t) => NAMED.test(t) || NAMED_BY_PROP.test(t) || SPREAD.test(t);

// role → { element: the build sheet's sentence, obligations: [{ says, check(source) → true when met, or owed }] }
export const ROLES = {
  button: { element: 'a <button type="button">', obligations: [
    { says: 'a <button> (or role="button")', check: (t) => BUTTON.test(t) },
    { says: 'a spoken name (its text, or aria-label when it shows only an icon)', check: named, owed: true },
  ] },
  togglebutton: { element: 'a <button type="button"> with aria-pressed="true" or "false" (on or off)', obligations: [
    { says: 'a <button> (or role="button")', check: (t) => BUTTON.test(t) },
    { says: 'aria-pressed, written even when it is false', check: (t) => /aria-pressed/i.test(t) },
    { says: 'a spoken name (its text, or aria-label when it shows only an icon)', check: named, owed: true },
  ] },
  textbox: { element: 'an <input> or <textarea> with a label', obligations: [
    { says: 'an <input> or <textarea> (or role="textbox")', check: (t) => FIELD.test(t) },
    { says: 'a label (a <label>, aria-label or aria-labelledby)', check: (t) => LABELLED.test(t) || SPREAD.test(t), owed: true },
  ], also: ['an error message, while it shows, linked to the field with aria-describedby (and aria-invalid="true")'] },
  checkbox: { element: 'an <input type="checkbox"> with a label (or role="checkbox" with aria-checked)', obligations: [
    { says: 'an <input type="checkbox"> (or role="checkbox")', check: (t) => /type\s*=\s*["']checkbox|role\s*=\s*["']checkbox/i.test(t) },
    { says: 'a label (a <label>, aria-label or aria-labelledby)', check: (t) => LABELLED.test(t) || SPREAD.test(t), owed: true },
  ] },
  radio: { element: 'an <input type="radio"> with a label (or role="radio" with aria-checked)', obligations: [
    { says: 'an <input type="radio"> (or role="radio")', check: (t) => /type\s*=\s*["']radio|role\s*=\s*["']radio/i.test(t) },
    { says: 'a label (a <label>, aria-label or aria-labelledby)', check: (t) => LABELLED.test(t) || SPREAD.test(t), owed: true },
  ] },
  switch: { element: 'a <button type="button" role="switch"> with aria-checked="true" or "false"', obligations: [
    { says: 'role="switch"', check: (t) => /role\s*=\s*["']switch/i.test(t) },
    { says: 'aria-checked (or a checkbox input)', check: (t) => /aria-checked|type\s*=\s*["']checkbox/i.test(t) },
    { says: 'a spoken name', check: (t) => named(t) || LABELLED.test(t), owed: true },
  ] },
  link: { element: 'an <a href="…">', obligations: [
    { says: 'an <a href>', check: (t) => /<a\b[^>]*\bhref|role\s*=\s*["']link/i.test(t) },
    { says: 'a spoken name', check: named, owed: true },
  ] },
  disclosure: { element: 'a <button type="button"> with aria-expanded and aria-controls naming the panel it shows', obligations: [
    { says: 'a <button> (or role="button")', check: (t) => BUTTON.test(t) },
    { says: 'aria-expanded, written even when it is false', check: (t) => /aria-expanded/i.test(t) },
    { says: 'aria-controls naming the panel', check: (t) => /aria-controls/i.test(t) },
  ] },
  tab: { element: 'an element with role="tab" and aria-selected, inside a role="tablist"', obligations: [
    { says: 'role="tab"', check: (t) => /role\s*=\s*["']tab["']/i.test(t) },
    { says: 'aria-selected, written even when it is false', check: (t) => /aria-selected/i.test(t) },
  ] },
  heading: { element: 'a heading element, <h1> to <h6>', obligations: [
    { says: 'a heading element, <h1> to <h6> (or role="heading" with aria-level)', check: (t) => /<h[1-6]\b|role\s*=\s*["']heading/i.test(t) },
  ] },
  dialog: { element: 'an element with role="dialog", aria-modal="true" and a label', obligations: [
    { says: 'role="dialog" (or a <dialog>)', check: (t) => /role\s*=\s*["'](?:alert)?dialog|<dialog\b/i.test(t) },
    { says: 'a label (aria-labelledby on its title, or aria-label)', check: (t) => /aria-label(?:ledby)?\s*=/i.test(t) || SPREAD.test(t), owed: true },
  ] },
  img: { element: 'an <img> with alt text (or role="img" with aria-label)', obligations: [
    { says: 'alt text (or role="img" with aria-label; alt="" when it only decorates)', check: (t) => /\balt\s*=|role\s*=\s*["']img["'][^>]*aria-label|aria-hidden\s*=\s*["']?\{?\s*["']?true/i.test(t), owed: true },
  ] },
};
// Other words for the same role (Specs' and common names).
const ALIASES = { iconbutton: 'button', togglebuttons: 'togglebutton', toggle: 'togglebutton', textinput: 'textbox', input: 'textbox', textfield: 'textbox',
  textarea: 'textbox', expander: 'disclosure', accordion: 'disclosure', modal: 'dialog', image: 'img', icon: 'img' };

const norm = (role) => String(role ?? '').toLowerCase().replace(/[\s_-]+/g, '');
export const roleOf = (role) => ROLES[ALIASES[norm(role)] ?? norm(role)] ?? null;

// The role a component's Figma annotations declare, as written (lower case, no spaces): "togglebutton".
export function roleWord(annotations = []) {
  for (const a of annotations ?? []) {
    const m = /\brole\s*[:=]\s*["'“]?([a-z][\w -]*)/i.exec(String(a?.label ?? a?.labelMarkdown ?? ''));
    if (m) return m[1].trim().toLowerCase().replace(/[\s_-]+/g, '');
  }
  return null;
}

// What the source misses for the role → { missing: ['a <button> (or role="button")', …], owed: ['a spoken name …'] }.
// Empty when it holds all, or when it cannot tell (an unknown role, or a root that is another component).
export function roleObligations(source, role) {
  const r = roleOf(role);
  const out = { missing: [], owed: [] };
  if (!r) return out;
  const text = String(source ?? '');
  // Composition: the root is the system's own component (<Button …>) with no plain element the role could be on.
  const plain = /<(div|span|a|li|label|p|section|button|input|textarea|h[1-6]|img|dialog)\b/.test(text);   // lower case: <Button> is a component
  if (!plain && /<[A-Z][\w.]*\b/.test(text.replace(/<(?:React\.)?Fragment\b/g, ''))) return out;
  for (const o of r.obligations) if (!o.check(text)) (o.owed ? out.owed : out.missing).push(o.says);
  // A name or label is owed only once the element itself is right: a <div> toggle fails on its element first.
  if (out.missing.length) out.owed = [];
  return out;
}

// The markup a role misses, as Gate [15] reports it (owed obligations included, marked as owed).
export function roleMarkupFindings(source, role) {
  const { missing, owed } = roleObligations(source, role);
  return [...missing, ...owed.map((o) => `${o} (owed: Figma's annotation or the person says what)`)];
}

// The build sheet: the element a role asks for, then every other obligation.
export function roleMarkup(role) {
  const r = roleOf(role);
  return r ? r.element : `an element with role="${role}"`;
}
export function roleSheetLines(role) {
  const r = roleOf(role);
  if (!r) return [];
  const rest = r.obligations.filter((o) => o.owed).map((o) => o.says);
  return [...rest, ...(r.also ?? [])];
}
