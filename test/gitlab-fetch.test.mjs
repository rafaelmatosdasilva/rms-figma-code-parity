// gitlab-fetch.mjs - optional live capture of GitLab wiki pages and Markdown files for the guidelines
// (intent) layer. Pure parts are tested directly; the fetch with an injected fetch (no network).
// Degrade-safe: any failure returns null so the committed file is kept. The token only ever goes to
// gitlab.com or GITLAB_HOST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitlabUrl, refCandidates, gitlabApiUrls, tokenAllowedFor, slugForUrl, fetchGitlabMarkdown } from '../gitlab-fetch.mjs';
import { gitlabTargets, guidelineFiles, generateIntent } from '../intent-gen.mjs';
import { makeFixture } from './helpers.mjs';

test('parseGitlabUrl: project wiki, group wiki, blob and raw files, subgroups, any host', () => {
  assert.deepEqual(parseGitlabUrl('https://gitlab.com/acme/design/-/wikis/Buttons'),
    { host: 'gitlab.com', origin: 'https://gitlab.com', scope: 'project', path: 'acme/design', kind: 'wiki', slug: 'Buttons' });
  assert.equal(parseGitlabUrl('https://git.acme.io/groups/ds/-/wikis/Guides/Colour').scope, 'group');
  assert.equal(parseGitlabUrl('https://git.acme.io/groups/ds/-/wikis/Guides/Colour').slug, 'Guides/Colour');
  const f = parseGitlabUrl('https://git.acme.io/ds/sub/docs/-/blob/main/usage/buttons.md');
  assert.deepEqual([f.host, f.path, f.kind, f.refAndPath], ['git.acme.io', 'ds/sub/docs', 'file', ['main', 'usage', 'buttons.md']]);
  assert.equal(parseGitlabUrl('https://gitlab.com/a/b/-/raw/main/x.md').kind, 'file');
  assert.equal(parseGitlabUrl('https://gitlab.com/a/b/-/issues/3'), null);
  assert.equal(parseGitlabUrl('not a url'), null);
});

test('a branch name may contain "/": every split is tried, shortest ref first', () => {
  assert.deepEqual(refCandidates(['feature', 'docs', 'a.md']), [{ ref: 'feature', file: 'docs/a.md' }, { ref: 'feature/docs', file: 'a.md' }]);
  const urls = gitlabApiUrls(parseGitlabUrl('https://gitlab.com/acme/design/-/blob/main/docs/a.md'));
  assert.equal(urls[0], 'https://gitlab.com/api/v4/projects/acme%2Fdesign/repository/files/docs%2Fa.md/raw?ref=main');
  assert.equal(gitlabApiUrls(parseGitlabUrl('https://gitlab.com/groups/ds/-/wikis/Home'))[0], 'https://gitlab.com/api/v4/groups/ds/wikis/Home');
});

test('the token only goes to gitlab.com or GITLAB_HOST', () => {
  assert.equal(tokenAllowedFor('gitlab.com', {}), true);
  assert.equal(tokenAllowedFor('git.acme.io', {}), false);
  assert.equal(tokenAllowedFor('git.acme.io', { GITLAB_HOST: 'https://git.acme.io/' }), true);
});

test('fetch a wiki page: "# Title" + its Markdown, with the token when the host is allowed', async () => {
  let seen;
  const fetchImpl = async (url, o) => { seen = o.headers; return { ok: true, status: 200, json: async () => ({ title: 'Buttons', content: '## Primary\nUse for the main action.' }) }; };
  const md = await fetchGitlabMarkdown('https://gitlab.com/acme/design/-/wikis/Buttons', { fetchImpl, env: { GITLAB_TOKEN: 't0k' } });
  assert.equal(md, '# Buttons\n\n## Primary\nUse for the main action.\n');
  assert.deepEqual(seen, { 'PRIVATE-TOKEN': 't0k' });
});

test('fetch a file on a company host: no token sent unless GITLAB_HOST names it; branch-with-slash retried', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push([url, o.headers]); return url.includes('ref=feature%2Fdocs') ? { ok: true, status: 200, text: async () => '# Usage\nText' } : { ok: false, status: 404 }; };
  const md = await fetchGitlabMarkdown('https://git.acme.io/ds/docs/-/blob/feature/docs/usage.md', { fetchImpl, env: { GITLAB_TOKEN: 't0k' } });
  assert.equal(md, '# Usage\nText\n');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, h]) => !h['PRIVATE-TOKEN']));
});

test('degrade-safe: forbidden, network error or empty content return null', async () => {
  const u = 'https://gitlab.com/acme/design/-/wikis/Buttons';
  assert.equal(await fetchGitlabMarkdown(u, { fetchImpl: async () => ({ ok: false, status: 401 }), env: {} }), null);
  assert.equal(await fetchGitlabMarkdown(u, { fetchImpl: async () => { throw new Error('offline'); }, env: {} }), null);
  assert.equal(await fetchGitlabMarkdown(u, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: '  ' }) }), env: {} }), null);
});

test('config: links or { url, file }, each to its own committed file, read without repeating it in sources', () => {
  const cfg = { guidelines: { sources: ['guidelines.md'], source: { gitlab: ['https://gitlab.com/a/b/-/wikis/Buttons', { url: 'https://gitlab.com/a/b/-/blob/main/usage.md', file: 'docs/usage.md' }] } } };
  assert.deepEqual(gitlabTargets(cfg).map((t) => t.file), ['guidelines/gitlab-buttons.md', 'docs/usage.md']);
  assert.deepEqual(guidelineFiles(cfg), ['guidelines.md', 'guidelines/gitlab-buttons.md', 'docs/usage.md']);
  assert.equal(slugForUrl('https://gitlab.com/a/b/-/blob/main/Docs/Button Usage.md'), 'button-usage');
});

test('a GitLab page reaches the intent layer: its component section lands on that component', async () => {
  const dir = makeFixture({
    'theme.css': ':root{}',
    'struct.json': { components: { buttonPrimary: { h: 24 } } },
    'guidelines/gitlab-buttons.md': '# Buttons\n\n## buttonPrimary\nOne per view, for the main action.\n',
  });
  const cfg = { paths: { themeCSS: 'theme.css', snapshotStructure: 'struct.json' }, guidelines: { source: { gitlab: ['https://gitlab.com/a/b/-/wikis/Buttons'] } }, docs: { out: 'design-intent.json' } };
  await generateIntent(dir, cfg, {});
  const intent = JSON.parse(readFileSync(join(dir, 'design-intent.json'), 'utf8'));
  assert.match(JSON.stringify(intent.components.buttonPrimary), /One per view, for the main action/);
});

// ── Pasting a link into the chat: rms-figma-code-parity --guidelines <link> ───────────────────
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notionTargets } from '../intent-gen.mjs';
const AUDIT = fileURLToPath(new URL('../audit.mjs', import.meta.url));
const run = (dir, args) => { try { return { code: 0, out: execFileSync('node', [AUDIT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITLAB_TOKEN: '', NOTION_TOKEN: '', GITLAB_FETCH_TIMEOUT_MS: '1000', NOTION_FETCH_TIMEOUT_MS: '1000' } }) }; } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };

test('notionTargets: a single link keeps writing to sources[0]; a list writes each page to its own file', () => {
  assert.deepEqual(notionTargets({ guidelines: { sources: ['g.md'], source: { notion: 'https://www.notion.so/x/Buttons-3bbebcef3937804f970dd600d624e9e9' } } }).map((t) => t.file), ['g.md']);
  assert.deepEqual(notionTargets({ guidelines: { source: { notion: ['https://www.notion.so/x/Buttons-3bbebcef3937804f970dd600d624e9e9'] } } }).map((t) => t.file), ['guidelines/notion-buttons.md']);
});

test('--guidelines adds pasted GitLab and Notion links to ds-config (even when the page cannot be read yet), and lists them', () => {
  const dir = makeFixture({ 'ds-config.json': { paths: { themeCSS: 't.css' } } });
  const g = run(dir, ['--guidelines', 'https://git.acme.invalid/ds/docs/-/wikis/Buttons']);
  assert.match(g.out, /Added the GitLab link, but the page could not be read yet/);
  assert.match(g.out, /GITLAB_HOST=git\.acme\.invalid/);
  assert.match(g.out, /never paste it into the chat/);
  run(dir, ['--guidelines', 'https://www.notion.so/team/Buttons-3bbebcef3937804f970dd600d624e9e9']);
  run(dir, ['--guidelines', 'https://www.notion.so/team/Colours-aaaabcef3937804f970dd600d624e9e9']);
  const conf = JSON.parse(readFileSync(join(dir, 'ds-config.json'), 'utf8'));
  assert.deepEqual(conf.guidelines.source.gitlab, ['https://git.acme.invalid/ds/docs/-/wikis/Buttons']);
  assert.equal(conf.guidelines.source.notion.length, 2);
  const list = run(dir, ['--guidelines']);
  assert.match(list.out, /GitLab {2}https:\/\/git\.acme\.invalid/);
  assert.match(list.out, /Notion .* guidelines\/notion-colours\.md/);
  assert.match(run(dir, ['--guidelines', 'https://example.com/x']).out, /not a GitLab wiki page, a GitLab Markdown file, or a Notion page/);
});
