// test/skill-evals/lib.mjs - the skill evaluation's plumbing (idea I55): isolated projects, one headless
// Claude Code run per task, and the context a scorer reads. Not part of `node --test` (it spends model
// tokens); run it with test/skill-evals/run.mjs.
//
// Every run is isolated: a fresh copy of the project (its snapshots dated today, one git commit, the
// project's hooks installed), a fresh HOME holding only the variant's guide, the same engine for every
// variant, a fixed tool list, a turn limit and a dollar budget. Only the guide differs between variants.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../../cdp.mjs';

export const ENGINE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const DEMO = join(ENGINE, 'test', 'fixtures', 'demo-ds');
export const TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,Skill';
const GIT_ENV = { GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

const NOT_PROJECT = /expected-report|\/\.design-system-engine-out(\/|$)|\/\.git(\/|$)|node_modules/;

// The project every run works on, as a hash of what a run copies. Each version is measured on its own checkout,
// so two versions compare only when this is the same: a change to the demo design system changes every task,
// and the version before is measured again on it (test/skill-evals.test.mjs holds RESULTS.md to this hash).
export function projectHash(source = DEMO) {
  const h = createHash('sha256');
  for (const f of walk(source).filter((p) => !NOT_PROJECT.test(p)).map((p) => relative(source, p)).sort()) h.update(`${f}\n`).update(readFileSync(join(source, f)));
  return h.digest('hex').slice(0, 12);
}

// A fresh project from `source`, prepared by the task's setup, committed once, hooks installed.
// engine: false (the build evaluation's MCP-only side) leaves out everything the skill gives a project: its config,
// the Figma snapshots it captured, and its hooks.
// skillFiles: what else the skill made in a real project (its contracts, records, snapshots), left out with it.
export function makeProject(source, setup, { engine = true, skillFiles = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-eval-'));
  cpSync(source, dir, { recursive: true, filter: (p) => !NOT_PROJECT.test(p) });
  const today = new Date().toISOString();
  for (const f of walk(dir).filter((p) => /\.snapshot\.json$/.test(p))) {
    writeFileSync(f, readFileSync(f, 'utf8').replace(/"_updated": "[^"]*"/, `"_updated": "${today}"`));
  }
  setup?.(dir);
  if (!engine) for (const p of ['ds-config.json', 'src/figma', ...skillFiles]) rmSync(join(dir, p), { recursive: true, force: true });
  const env = { ...process.env, ...GIT_ENV };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  if (engine && existsSync(join(dir, 'ds-config.json'))) execFileSync(process.execPath, [join(ENGINE, 'audit.mjs'), '--install-hooks'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env });
  // The files the project ignores, as they were before the run: one the run leaves as it was is not its change.
  const ignored = ignoredFiles(dir, execFileSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }));
  writeFileSync(join(dir, '.git', 'eval-ignored.json'), JSON.stringify(Object.fromEntries(ignored.map((p) => { try { return [p, createHash('sha1').update(readFileSync(join(dir, p))).digest('hex')]; } catch { return [p, null]; } }))));
  return dir;
}

// The ignored files git status lists (an ignored folder is one line: its files, without installed packages).
function ignoredFiles(dir, status) {
  return status.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .flatMap((p) => (p.endsWith('/') ? (existsSync(join(dir, p)) ? walk(join(dir, p)).map((f) => relative(dir, f)) : []) : [p]))
    .filter((p) => !/(^|\/)node_modules(\/|$)/.test(p));
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// A HOME with only the variant installed, and a bin folder with the terminal command (unless the task
// takes it away). Returns { home, path }.
export function makeHome(variant, { cliOnPath = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'skill-eval-home-'));
  // Where install.sh puts the engine, so the guide's "node <install-dir>/audit.mjs" finds this engine and
  // never another checkout on the machine. A variant that installs its own skill folder there keeps it.
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  variant.install(home);
  if (variant.engine === false) cliOnPath = false;   // no skill, no engine: nothing of it on the machine
  else if (!existsSync(join(home, '.claude', 'skills', 'rms-design-system-engine'))) symlinkSync(ENGINE, join(home, '.claude', 'skills', 'rms-design-system-engine'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  if (cliOnPath) {
    for (const name of ['rms-design-system-engine']) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\nexec node "${join(ENGINE, 'audit.mjs')}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  const path = [bin, ...String(process.env.PATH).split(':').filter((p) => !/\.local\/bin/.test(p))].join(':');
  return { home, path };
}

// The environment of a run: a fresh user's, not a child of the session that started the evaluation. Every
// CLAUDE* variable goes (the parent's session id, effort, extra directories, messaging), and so do tokens a
// user would not hand the agent (GitHub, cloud, Figma, GitLab) and the evaluation's own settings. The
// model's credentials stay.
const DROP = [/^CLAUDE/, /^MAX_THINKING_TOKENS$/, /^(GH|GITHUB)_TOKEN$/, /^CLOUDSDK_/, /^SESSION_INGRESS/, /^FIGMA_/, /^GITLAB_/, /^DESIGN_SYSTEM_ENGINE_EVAL/];
export function childEnv(env, extra = {}) {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !DROP.some((re) => re.test(k)))), ...extra };
}

// A run that did not run: the API refused it (a usage limit, a 429, an overload) or it spent nothing and
// called nothing. It says nothing about the guide, so it is never scored; the evaluation stops and resumes.
export function infraFailure(events) {
  const result = events.filter((e) => e.type === 'result').at(-1);
  if (!result) return null;
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.api_error_status || result.terminal_reason === 'api_error') return `API error ${result.api_error_status ?? ''}: ${text.slice(0, 200)}`.replace(/\s+:/, ':');
  if (/hit your (session|usage|weekly) limit|rate.?limit|overloaded/i.test(text) && result.is_error) return text.slice(0, 200);
  const toolCalls = events.some((e) => e.type === 'assistant' && (e.message?.content ?? []).some((c) => c.type === 'tool_use'));
  if (!result.total_cost_usd && !toolCalls) return `nothing spent and nothing called: ${text.slice(0, 200)}`;
  return null;
}

// One headless turn. Resolves { events, sessionId, cost, error, infra }.
export function runClaude({ cwd, home, path, prompt, model, resume = null, maxTurns = 40, budget = 3, timeoutMs = 15 * 60 * 1000 }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budget), '--tools', TOOLS, '--allowedTools', TOOLS.split(',').join(' '),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(resume ? ['--resume', resume] : [])];
  return new Promise((resolve) => {
    // Real users have Chrome: the audit's browser reading and accessibility check run in every variant.
    // A run that installs its own Playwright must not clean up the machine's shared browsers (its garbage collection
    // removes every browser no installed copy links to, which leaves the scorer with no Chrome).
    const chrome = process.env.CHROME_PATH || findChrome({ playwright: true }) || '';
    const child = spawn('claude', args, { cwd, env: childEnv(process.env, { HOME: home, PATH: path, CHROME_PATH: chrome, PLAYWRIGHT_SKIP_BROWSER_GC: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const events = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = events.filter((e) => e.type === 'result').at(-1);
      const error = timedOut ? `timed out after ${timeoutMs / 60000} min` : !result ? `no result (${err.slice(-300)})` : null;
      resolve({ events, sessionId: result?.session_id ?? events.find((e) => e.session_id)?.session_id ?? null, cost: result?.total_cost_usd ?? 0, error, infra: timedOut ? null : infraFailure(events), stderr: err.slice(-2000) });
    });
  });
}

// What a scorer reads: the tool calls with their results, the text, the engine runs, the files after.
// `saved` (from a result row) replaces the live project: its changed files, commit count and file contents,
// so a run can be scored again later without running it again (rescore.mjs).
export function context(events, dir, saved = null) {
  const calls = [], texts = [];
  const byId = new Map();
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (e.type === 'assistant' && c.type === 'text') texts.push(c.text);
      if (e.type === 'assistant' && c.type === 'tool_use') { const call = { id: c.id, name: c.name, input: c.input ?? {}, result: '', isError: false }; calls.push(call); byId.set(c.id, call); }
      if (e.type === 'user' && c.type === 'tool_result') {
        const call = byId.get(c.tool_use_id);
        if (call) { call.result = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : String(c.content ?? ''); call.isError = !!c.is_error; }
      }
    }
  }
  const results = events.filter((e) => e.type === 'result');
  const final = results.map((r) => String(r.result ?? '')).join('\n\n');
  const bash = calls.filter((c) => c.name === 'Bash').map((c) => ({ command: String(c.input.command ?? ''), result: c.result, isError: c.isError }));
  const engine = bash.filter((b) => ENGINE_CALL.test(b.command));
  const git = (...a) => { if (saved) return ''; try { return execFileSync('git', a, { cwd: dir, encoding: 'utf8' }); } catch { return ''; } };
  // Files the engine writes on every run: never the agent's change. Applied to
  // a saved row too, so a run scored with an older list is scored with this one.
  // What the run changed since the project was set up: the working tree, and anything it committed (a commit must not
  // hide its files from the scorer; the rules still count the commit itself).
  const root = saved ? '' : git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0];
  const committed = !saved && root ? git('diff', '--name-only', root, 'HEAD').split('\n').filter(Boolean) : [];
  // A file the project ignores (a drafts folder in its .gitignore) is still the run's work; installed packages and the
  // engine's own output folder are not.
  let before = {};
  if (!saved) { try { before = JSON.parse(readFileSync(join(dir, '.git', 'eval-ignored.json'), 'utf8')); } catch { /* an older project */ } }
  const same = (p) => { if (!(p in before)) return false; try { return createHash('sha1').update(readFileSync(join(dir, p))).digest('hex') === before[p]; } catch { return false; } };
  const status = saved ? '' : git('status', '--porcelain', '--ignored', '--untracked-files=all');
  const changed = (saved ? saved.changed ?? [] : [...new Set([...status.split('\n').filter((l) => l && !l.startsWith('!! ')).map((l) => l.slice(3).replace(/^"|"$/g, '')), ...ignoredFiles(dir, status).filter((p) => !same(p)), ...committed])])
    .filter((p) => !ENGINE_WRITES.test(p) && !/(^|\/)(node_modules|\.design-system-engine-out)(\/|$)/.test(p));
  const nextLines = calls.flatMap((c) => String(c.result).split('\n')).map((l) => l.match(/^NEXT:\s*(.+)$/)?.[1]).filter(Boolean);
  const savedFiles = saved?.files ?? {};
  const read = (p) => { if (saved) return savedFiles[p] ?? null; try { return readFileSync(join(dir, p), 'utf8'); } catch { return null; } };
  return {
    calls, bash, engine, texts, final, all: [...texts, final].join('\n'), changed, commits: saved ? saved.commits ?? 1 : Number(git('rev-list', '--count', 'HEAD').trim() || 0),
    diff: git('diff', 'HEAD'), read, nextLines, dir,
    usage: results.reduce((u, r) => ({ input: u.input + (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0), output: u.output + (r.usage?.output_tokens ?? 0), turns: u.turns + (r.num_turns ?? 0), cost: u.cost + (r.total_cost_usd ?? 0) }), { input: 0, output: 0, turns: 0, cost: 0 }),
  };
}

// A call to the engine: its command, or node …/audit.mjs.
export const ENGINE_CALL = /(^|[\s;&|(])(rms-design-system-engine|node\s+\S*audit\.mjs)\b/;

export const ENGINE_WRITES = /^\.design-system-engine-out\/|^contracts\/|^design-system-engine-(agreed|history)\.json$|^(component-prop-result|design-system-engine-check-result)\.json$|html-structure\.snapshot\.json$|^design-intent\.json$|^llms\.txt$/;

// Tool calls the agent chose that no NEXT line gave (a lower number means less left to the agent).
// A call counts as guided only when a NEXT line printed before it named its command.
export function decisionPoints(ctx) {
  const seen = [];
  let decided = 0;
  for (const c of ctx.calls) {
    const cmd = String(c.input?.command ?? '');
    const guided = c.name === 'Bash' && seen.some((g) => g && cmd.includes(g));
    if (!guided) decided++;
    for (const l of String(c.result ?? '').split('\n')) {
      const m = l.match(/^NEXT:\s*(.+)$/);
      if (m) seen.push(m[1].replace(/\s+\(.*$/, '').replace(/^.*?(rms-design-system-engine|git apply)/, '$1').replace(/[.;,]\s.*$/, '').trim());
    }
  }
  return decided;
}

export const flagsOf = (command) => command.split(/\s+/).filter((t) => t.startsWith('--'));
export function hasEngineRun(ctx, pred = () => true) { return ctx.engine.some((b) => pred(b.command, flagsOf(b.command))); }

export function cleanup(...dirs) { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } }

// The files a scorer may read, kept with the result so the run can be scored again (at most 256 KB each).
export const KEEP = ['ds-config.json', 'design-system-engine-baseline.json', 'src/theme.css', '.design-system-engine-out/summary.md'];
export function keepFiles(ctx, extra = []) {
  const out = {};
  for (const p of new Set([...KEEP, ...extra, ...ctx.changed])) { const t = ctx.read(p); if (t != null && t.length <= 256 * 1024) out[p] = t; }
  return out;
}
