// product-conventions.mjs - pages of the same product arranged the same way.
//
// A product's pages share decisions no component holds: how far the content sits from the edge, the room between
// sections, the screen width, the style of the page heading, where the actions go, and the answer given to a need the
// system lacks (one page must not use a chip for a switch while another shows a Missing box). These are read from the
// pages already made (the prototypes, the starting points read from designed screens) and from
// prototypes/conventions.json, which the team may edit: what it writes wins over what the pages show.
//
// Pure: no I/O. prototype.mjs reads the files.

const PIECE = new Set(['Page', 'Stack', 'Row', 'Columns', 'Text', 'Missing']);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'each', 'some', 'like', 'one', 'turn', 'on', 'off', 'to', 'of', 'a', 'an', 'or', 'its', 'component']);
const words = (s) => [...new Set((String(s).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map((w) => w.replace(/(es|s)$/, '')).filter((w) => !STOP.has(w)))];

// The facts of one page: its frame, its heading, its actions, and how it answers each need the system lacks.
// actionNames: the system components that are actions (a role of button, or described as an action).
export function pageFacts(tree, { actionNames = [] } = {}) {
  const actions = new Set(actionNames);
  const facts = { page: null, heading: null, actions: null, needs: [], frame: [] };
  if (!tree) return facts;
  if (tree.component === 'Page') facts.page = { padding: tree.props?.padding ?? null, gap: tree.props?.gap ?? null, width: tree.props?.width != null ? String(tree.props.width) : null, align: tree.props?.align ?? null };
  const texts = [];
  const visit = (node) => {
    if (!node) return;
    const p = node.props ?? {};
    if (node.component === 'Text') texts.push(p);
    if (node.component === 'Missing' && p.need) facts.needs.push({ need: String(p.need), answer: 'a Missing box' });
    if (p.standInFor) facts.needs.push({ need: String(p.standInFor), answer: `${node.component} as a stand-in` });
    (node.children ?? []).forEach(visit);
  };
  visit(tree);
  // The frame: the system's components at the top of the layout (the page's own children, and theirs when a child is
  // only arrangement), like a product's action bar and side panel.
  // Only containers count: a component holding other parts here, or one named as a bar, panel, header, window or nav.
  const CONTAINER = /(bar|panel|header|footer|nav|window|sidebar|toolbar|shell|frame|drawer)$/i;
  const top = (n, d) => (n.children ?? []).flatMap((k) => (PIECE.has(k.component) ? (d < 1 && k.component !== 'Missing' && k.component !== 'Text' ? top(k, d + 1) : []) : ((k.children ?? []).length || CONTAINER.test(k.component) ? [k.component] : [])));
  facts.frame = [...new Set(top(tree, 0))];
  const h = texts.find((t) => t.as === 'h1') ?? texts.find((t) => /^h[1-3]$/.test(t.as ?? '')) ?? null;
  if (h) facts.heading = { style: h.style ?? null, as: h.as ?? null };
  // The actions: the last group of the page made only of actions (or a lone action at the end), and how it is placed.
  const kids = tree.children ?? [];
  const isAction = (n) => n && !PIECE.has(n.component) && actions.has(n.component);
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i];
    const group = k.component === 'Row' && (k.children ?? []).length && k.children.every(isAction);
    if (group || isAction(k)) {
      facts.actions = { at: i === kids.length - 1 ? 'end' : i === 0 ? 'start' : 'middle', justify: group ? (k.props?.justify ?? 'start') : 'start' };
      break;
    }
  }
  return facts;
}

// What the product's pages agree on. pages: { name: facts }. A screen a designer made in Figma (facts.designed) weighs
// two, any other page one; a value counts at a weight of two and above, and only when no other value weighs as much.
// Authored (prototypes/conventions.json) wins. Each convention says where it comes from.
export function deriveConventions(pages = {}, authored = {}) {
  const out = { page: {}, heading: {}, actions: {}, needs: [] };
  const vote = (get) => {
    const count = new Map();
    for (const [name, f] of Object.entries(pages)) { const v = get(f); if (v != null) { if (!count.has(v)) count.set(v, { pages: [], weight: 0 }); const c = count.get(v); c.pages.push(name); c.weight += f.designed ? 2 : 1; } }
    const ranked = [...count].sort((a, b) => b[1].weight - a[1].weight);
    if (!ranked.length || ranked[0][1].weight < 2 || (ranked[1] && ranked[1][1].weight === ranked[0][1].weight)) return null;
    return { value: ranked[0][0], pages: ranked[0][1].pages };
  };
  for (const k of ['padding', 'gap', 'width', 'align']) { const v = vote((f) => f.page?.[k]); if (v) out.page[k] = v; }
  const hs = vote((f) => f.heading?.style); if (hs) out.heading.style = hs;
  const at = vote((f) => f.actions?.at); if (at) out.actions.at = at;
  const j = vote((f) => f.actions?.justify); if (j) out.actions.justify = j;
  // Frame components most of the weight shares (two pages, or a designed screen, at least).
  const total = Object.values(pages).reduce((a, f) => a + (f.designed ? 2 : 1), 0);
  const inFrame = new Map();
  for (const [name, f] of Object.entries(pages)) for (const c of f.frame ?? []) { if (!inFrame.has(c)) inFrame.set(c, { weight: 0, pages: [] }); const x = inFrame.get(c); x.weight += f.designed ? 2 : 1; x.pages.push(name); }
  out.frame = [...inFrame].filter(([, x]) => x.weight >= 2 && x.weight * 2 > total).map(([component, x]) => ({ component, pages: x.pages }));
  // One answer per need across pages: the first page to answer a need sets it, unless more pages answer otherwise.
  const groups = [];
  for (const [name, f] of Object.entries(pages)) {
    for (const n of f.needs ?? []) {
      const w = words(n.need);
      const g = groups.find((x) => overlap(x.words, w));
      if (g) { g.answers.push({ answer: n.answer, page: name }); g.words = [...new Set([...g.words, ...w])]; } else groups.push({ need: n.need, words: w, answers: [{ answer: n.answer, page: name }] });
    }
  }
  for (const g of groups) {
    const count = new Map();
    for (const a of g.answers) { if (!count.has(a.answer)) count.set(a.answer, []); if (!count.get(a.answer).includes(a.page)) count.get(a.answer).push(a.page); }
    const [answer, from] = [...count].sort((a, b) => b[1].length - a[1].length)[0];
    out.needs.push({ need: g.need, words: g.words, answer, pages: from });
  }
  // The team's own word wins.
  for (const k of ['padding', 'gap', 'width', 'align']) if (authored.page?.[k] != null) out.page[k] = { value: String(authored.page[k]), pages: [], authored: true };
  if (authored.heading?.style) out.heading.style = { value: authored.heading.style, pages: [], authored: true };
  for (const k of ['at', 'justify']) if (authored.actions?.[k]) out.actions[k] = { value: authored.actions[k], pages: [], authored: true };
  if (Array.isArray(authored.frame)) out.frame = authored.frame.map((component) => ({ component, pages: [], authored: true }));
  for (const [need, answer] of Object.entries(authored.needs ?? {})) {
    const w = words(need);
    out.needs = out.needs.filter((n) => !overlap(n.words, w));
    out.needs.push({ need, words: w, answer: String(answer), pages: [], authored: true });
  }
  return out;
}

// Two needs are the same when most of the shorter one's words are in the other.
function overlap(a, b) {
  if (!a.length || !b.length) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.filter((w) => l.includes(w)).length >= Math.ceil(s.length / 2);
}

const LABEL = { padding: 'page padding', gap: 'space between sections', width: 'screen width', align: 'page alignment' };
const from = (c) => (c.authored ? 'prototypes/conventions.json' : `${c.pages.join(', ')}`);

// Where one page departs from the product's conventions: { what, here, product, from } per difference.
export function consistencyFindings(facts, conv) {
  const out = [];
  if (!conv) return out;
  for (const k of ['padding', 'gap', 'width', 'align']) {
    const c = conv.page?.[k];
    if (c && facts.page && (facts.page[k] ?? null) !== c.value) out.push({ what: LABEL[k], here: facts.page[k] ?? 'none', product: c.value, from: from(c) });
  }
  if (conv.heading?.style && facts.heading && facts.heading.style !== conv.heading.style.value) out.push({ what: 'page heading style', here: facts.heading.style ?? 'none', product: conv.heading.style.value, from: from(conv.heading.style) });
  if (conv.actions?.at && facts.actions && facts.actions.at !== conv.actions.at.value) out.push({ what: 'where the actions sit', here: facts.actions.at, product: conv.actions.at.value, from: from(conv.actions.at) });
  if (conv.actions?.justify && facts.actions && facts.actions.justify !== conv.actions.justify.value) out.push({ what: 'how the actions line up', here: facts.actions.justify, product: conv.actions.justify.value, from: from(conv.actions.justify) });
  for (const c of conv.frame ?? []) if (facts.frame && !facts.frame.includes(c.component)) out.push({ what: 'the page\'s frame', here: `no ${c.component}`, product: c.component, from: from(c) });
  for (const n of facts.needs ?? []) {
    const c = (conv.needs ?? []).find((x) => overlap(x.words, words(n.need)));
    if (c && c.answer !== n.answer) out.push({ what: `the answer to "${c.need}"`, here: n.answer, product: c.answer, from: from(c) });
  }
  return out;
}

export function consistencyLine(d) {
  return `${d.what}: ${d.here} here, ${d.product} on the product's other pages (${d.from})`;
}
