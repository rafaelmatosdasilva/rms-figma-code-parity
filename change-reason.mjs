// change-reason.mjs - who changed a value and why, so the reason travels with a finding (idea I49).
//
//   • Code side: the commit behind a `file:line` (git blame on that one line): short hash, author,
//     date and the commit's subject. A line not committed yet says so.
//   • Figma side: the file's latest named version (REST /files/:key/versions): label, description,
//     author and date. Figma keeps versions per file, not per node, so this is one line per run.
//
// Never fails the caller: outside a git repository, or without a token, it returns null.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const BLAME = new Map();   // file → Map(line → reason), one blame per file per process

export function codeReason(root, at) {
  const m = String(at ?? '').match(/^(.+):(\d+)$/);
  if (!m) return null;
  const [, file, line] = m;
  const abs = resolve(root, file);
  if (!BLAME.has(abs)) {
    let lines = null;
    try {
      const out = execFileSync('git', ['blame', '--line-porcelain', '--', abs], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
      lines = parseBlame(out);
    } catch { /* not in git, or not tracked */ }
    BLAME.set(abs, lines);
  }
  return BLAME.get(abs)?.get(Number(line)) ?? null;
}

// git blame --line-porcelain: a header per line ("<hash> <orig> <final> [<count>]"), then key/value
// lines, then the content line starting with a tab.
export function parseBlame(out) {
  const by = new Map();
  let cur = null;
  for (const l of String(out).split('\n')) {
    const h = l.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (h) { cur = { hash: h[1], line: Number(h[2]) }; continue; }
    if (!cur) continue;
    if (l.startsWith('author ')) cur.author = l.slice(7);
    else if (l.startsWith('author-time ')) cur.date = new Date(Number(l.slice(12)) * 1000).toISOString().slice(0, 10);
    else if (l.startsWith('summary ')) cur.subject = l.slice(8);
    else if (l.startsWith('\t')) {
      by.set(cur.line, /^0{40}$/.test(cur.hash) ? { uncommitted: true } : { hash: cur.hash.slice(0, 7), author: cur.author, date: cur.date, subject: cur.subject });
      cur = null;
    }
  }
  return by;
}

export function reasonLine(r) {
  if (!r) return null;
  if (r.uncommitted) return 'changed in the working copy, not committed yet';
  return `last changed ${r.date} by ${r.author}: "${r.subject}" (${r.hash})`;
}

// The Figma file's latest version, for a one-line "Figma side" note.
export async function figmaReason(fileKey, token, { fetchImpl = fetch } = {}) {
  if (!fileKey || !token) return null;
  try {
    const res = await fetchImpl(`https://api.figma.com/v1/files/${fileKey}/versions?page_size=5`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const v = (await res.json())?.versions ?? [];
    const named = v.find((x) => x.label) ?? v[0];
    if (!named) return null;
    return { date: String(named.created_at ?? '').slice(0, 10), author: named.user?.handle ?? null, label: named.label || null, description: named.description || null, latest: String(v[0]?.created_at ?? '').slice(0, 10) };
  } catch { return null; }
}

export function figmaReasonLine(r) {
  if (!r) return null;
  const what = [r.label && `"${r.label}"`, r.description && `(${r.description})`].filter(Boolean).join(' ') || 'an unnamed version';
  return `Figma: last named version ${what} on ${r.date}${r.author ? ` by ${r.author}` : ''}${r.latest && r.latest !== r.date ? `; last edit ${r.latest}` : ''}`;
}
