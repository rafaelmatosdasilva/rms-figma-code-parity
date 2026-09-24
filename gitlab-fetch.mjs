// gitlab-fetch.mjs - optional live capture of GitLab pages into Markdown, for the guidelines layer.
//
// The same contract as notion-fetch.mjs: a pasted link (committed, not secret) is fetched into a
// committed Markdown file that intent-gen folds into the design intent. Two kinds of link, told
// apart from the URL, on gitlab.com or any company-hosted GitLab (the host comes from the link):
//   • a wiki page       https://<host>/<group>/<project>/-/wikis/<slug>   (or /groups/<group>/-/wikis/…)
//   • a Markdown file   https://<host>/<group>/<project>/-/blob/<ref>/<path>.md   (or /-/raw/…)
//
// Token: GITLAB_TOKEN in the project's .env (gitignored, per person), sent as PRIVATE-TOKEN. One
// token with read_api covers wikis and files; public projects need none. The token is only ever
// sent to gitlab.com or to the host named in GITLAB_HOST, so a mistyped or hostile link cannot
// receive it. It is never logged.
//
// DEGRADE-SAFE: any failure (no access, not found, network, rate limit) returns null and the caller
// keeps the committed file. Never throws to the audit. The pure parts are exported for tests.

const DEFAULT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.GITLAB_FETCH_TIMEOUT_MS, 10) || 15000);

// Parse a GitLab link. Returns null when it is not a wiki page or a file link.
//   { host, origin, scope: 'project'|'group', path, kind: 'wiki', slug }
//   { host, origin, scope: 'project', path, kind: 'file', refAndPath: [segments…] }
export function parseGitlabUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const dash = parts.indexOf('-');
  if (dash < 1 || dash + 2 > parts.length) return null;
  const before = parts.slice(0, dash), action = parts[dash + 1], rest = parts.slice(dash + 2);
  const base = { host: u.host, origin: u.origin };
  if (action === 'wikis' && rest.length) {
    const group = before[0] === 'groups';
    const path = (group ? before.slice(1) : before).join('/');
    if (!path) return null;
    return { ...base, scope: group ? 'group' : 'project', path, kind: 'wiki', slug: rest.join('/') };
  }
  if ((action === 'blob' || action === 'raw') && rest.length >= 2) {
    return { ...base, scope: 'project', path: before.join('/'), kind: 'file', refAndPath: rest };
  }
  return null;
}

// The ways a blob URL's "<ref>/<path>" can split: a branch name may itself contain "/", so every
// split is a candidate, shortest ref first (the common case: "main/docs/usage.md").
export function refCandidates(refAndPath) {
  const out = [];
  for (let i = 1; i < refAndPath.length; i++) out.push({ ref: refAndPath.slice(0, i).join('/'), file: refAndPath.slice(i).join('/') });
  return out;
}

// The REST URLs to try for a parsed link, in order.
export function gitlabApiUrls(p) {
  const api = `${p.origin}/api/v4/${p.scope === 'group' ? 'groups' : 'projects'}/${encodeURIComponent(p.path)}`;
  if (p.kind === 'wiki') return [`${api}/wikis/${encodeURIComponent(p.slug)}`];
  return refCandidates(p.refAndPath).map(({ ref, file }) => `${api}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`);
}

// May the token be sent to this host? gitlab.com, or the host the person named in GITLAB_HOST.
export function tokenAllowedFor(host, env = process.env) {
  const allowed = new Set(['gitlab.com', ...String(env.GITLAB_HOST ?? '').split(',').map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)]);
  return allowed.has(String(host).toLowerCase());
}

// A short, file-name-safe slug for a link (used to name its committed file).
export function slugForUrl(input) {
  const p = parseGitlabUrl(input);
  const raw = p ? (p.kind === 'wiki' ? p.slug : p.refAndPath[p.refAndPath.length - 1].replace(/\.md$/i, '')) : String(input);
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
}

// Fetch one link as Markdown: "# Title\n\n<content>" for a wiki page, the file as-is for a file.
// Returns null on any failure. opts: { token, env, fetchImpl, signal }.
export async function fetchGitlabMarkdown(input, opts = {}) {
  const p = parseGitlabUrl(input);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!p || typeof fetchImpl !== 'function') return null;
  const env = opts.env ?? process.env;
  const token = opts.token ?? env.GITLAB_TOKEN;
  const headers = token && tokenAllowedFor(p.host, env) ? { 'PRIVATE-TOKEN': token } : {};
  const get = async (url) => {
    const signal = opts.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) : undefined);
    try { return await fetchImpl(url, { headers, signal }); } catch { return null; }
  };
  try {
    for (const url of gitlabApiUrls(p)) {
      const res = await get(url);
      if (!res || !res.ok) { if (res && res.status !== 404 && res.status !== 400) return null; continue; }
      if (p.kind === 'wiki') {
        const page = await res.json();
        const body = String(page?.content ?? '').trim();
        if (!body) return null;
        const title = String(page?.title ?? '').trim();
        return (title && !/^#\s/.test(body) ? `# ${title}\n\n` : '') + body + '\n';
      }
      const text = String(await res.text()).trim();
      return text ? text + '\n' : null;
    }
    return null;
  } catch {
    return null;
  }
}
