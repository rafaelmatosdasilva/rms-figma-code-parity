// notion-fetch.mjs - optional live capture of a Notion page into Markdown, for the guidelines layer.
//
// The reliable way to read a Notion page's CONTENT is the Notion API (a published "to web" page is a
// JS app shell, so a plain GET returns nothing). So this uses the API with a per-person token:
//   • token   → NOTION_TOKEN in the project's .env (gitignored). Never in the repo, never assumed.
//   • sharing → the page must be shared with that integration.
// It renders a minimal, DETERMINISTIC Markdown from the common block types and is DEGRADE-SAFE: any
// failure (no token, not shared, network, rate limit) returns null, so the caller keeps the last
// committed guidelines file. It never throws to the audit. The pure parts (id parsing, block ->
// markdown) are exported for unit testing without a network.

const NOTION_VERSION = '2022-06-28';
const DEFAULT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.NOTION_FETCH_TIMEOUT_MS, 10) || 15000);

// A Notion URL (or a bare id) carries a 32-hex id, either as a dashed UUID or as a 32-char run.
// Return it dashed, or null. We do NOT strip dashes globally (that would glue a title's trailing hex
// letter onto the id, e.g. "...Title-3bbe..."); instead we match the id at a non-hex boundary.
export function pageIdFromUrl(input) {
  if (!input) return null;
  const s = String(input).trim();
  const dashed = s.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  let hex;
  if (dashed) {
    hex = dashed[0].replace(/-/g, '').toLowerCase();
  } else {
    const runs = [...s.matchAll(/(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])/g)];
    if (!runs.length) return null;
    hex = runs[runs.length - 1][1].toLowerCase();   // the id is the last bounded 32-hex run
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Notion rich_text[] -> plain string (annotations dropped: we want clean text for agents).
function richText(rt) {
  return (rt || []).map((t) => (t && (t.plain_text ?? t.text?.content)) || '').join('');
}

// One block -> a Markdown line (its own children are rendered by blocksToMarkdown). '' = unsupported.
function renderBlock(b) {
  const t = b?.type;
  const d = (t && b[t]) || {};
  const txt = richText(d.rich_text);
  switch (t) {
    case 'heading_1': return `# ${txt}`;
    case 'heading_2': return `## ${txt}`;
    case 'heading_3': return `### ${txt}`;
    case 'paragraph': return txt;
    case 'bulleted_list_item': return `- ${txt}`;
    case 'numbered_list_item': return `1. ${txt}`;
    case 'to_do': return `- [${d.checked ? 'x' : ' '}] ${txt}`;
    case 'quote':
    case 'callout': return `> ${txt}`;
    case 'toggle': return txt;
    case 'code': return '```' + (d.language && d.language !== 'plain text' ? d.language : '') + '\n' + txt + '\n```';
    case 'divider': return '---';
    default: return '';
  }
}

// A block tree (each block may carry a `_children` array) -> Markdown. Pure and testable.
export function blocksToMarkdown(blocks, depth = 0) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const b of blocks || []) {
    const line = renderBlock(b);
    if (line) out.push(pad + line.replace(/\n/g, '\n' + pad));
    if (Array.isArray(b?._children) && b._children.length) {
      const child = blocksToMarkdown(b._children, depth + 1);
      if (child) out.push(child);
    }
  }
  return out.filter(Boolean).join('\n');
}

// Fetch a Notion page and return `# Title\n\n<markdown>`, or null on ANY failure (degrade-safe).
// `opts.fetchImpl` is injectable for tests; `opts.token` overrides NOTION_TOKEN.
export async function fetchNotionMarkdown(input, opts = {}) {
  const token = opts.token ?? process.env.NOTION_TOKEN;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const pageId = pageIdFromUrl(input);
  if (!token || !pageId || typeof fetchImpl !== 'function') return null;

  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION };
  const api = async (url) => {
    const signal = opts.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) : undefined);
    const res = await fetchImpl(url, { headers, signal });
    if (!res || !res.ok) throw new Error(`Notion API ${res?.status ?? '?'}`);
    return res.json();
  };
  const childrenOf = async (id, depth) => {
    if (depth > 6) return [];                       // guard against pathological nesting
    const blocks = [];
    let cursor;
    do {
      const u = `https://api.notion.com/v1/blocks/${id}/children?page_size=100` + (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');
      const page = await api(u);
      for (const b of page.results || []) {
        if (b.has_children) b._children = await childrenOf(b.id, depth + 1);
        blocks.push(b);
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return blocks;
  };

  try {
    let title = '';
    try {
      const meta = await api(`https://api.notion.com/v1/pages/${pageId}`);
      const titleProp = Object.values(meta.properties || {}).find((p) => p && p.type === 'title');
      title = richText(titleProp?.title);
    } catch { /* title is optional */ }
    const md = blocksToMarkdown(await childrenOf(pageId, 0));
    if (!md.trim()) return null;
    return (title ? `# ${title}\n\n` : '') + md + '\n';
  } catch {
    return null;                                    // no token access / network / rate limit -> keep the committed file
  }
}
