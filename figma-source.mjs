// figma-source.mjs - which way to read Figma, chosen automatically (idea I84).
//
// In order: a design.json in the project newer than the snapshots (the person ran `figma-cli snapshot`), then
// figma-cli itself when Figma Desktop is connected to it (its debugging port answers: no API key, no rate limit,
// every mode and alias chain), then the Figma MCP of the agent's session (the refresh-figma recipe), then the REST API
// with FIGMA_TOKEN. The engine reads design.json and runs figma-cli itself; the MCP is the agent's tool, so for it the
// engine says what to run. Never writes to Figma: `figma-cli snapshot` only reads the open file.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

export const designJsonPath = (cfg = {}) => cfg.figmaCli?.designJson ?? 'design.json';
export const figmaCliPort = (env = process.env) => { const p = parseInt(env.FIGMA_PORT, 10); return p > 0 && p < 65536 ? p : 9222; };

// A command on PATH.
export function onPath(cmd, env = process.env, exists = existsSync) {
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) if (exists(join(dir, cmd + ext))) return join(dir, cmd + ext);
  }
  return null;
}

// Figma Desktop (or the browser figma-cli drives) answering on its debugging port.
export async function portAnswers(port, fetchImpl = globalThis.fetch, timeoutMs = 800) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };

// { route: 'design-json' | 'figma-cli' | 'mcp' | 'rest', why, file? }. deps make it testable.
export async function chooseFigmaSource(ROOT, cfg = {}, { env = process.env, which = (c) => onPath(c, env), answers = (p) => portAnswers(p), mtime = mtimeOf } = {}) {
  const design = join(ROOT, designJsonPath(cfg));
  const snap = join(ROOT, cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json');
  const dj = mtime(design), sv = mtime(snap);
  if (dj != null && (sv == null || dj > sv)) return { route: 'design-json', file: designJsonPath(cfg), why: `${designJsonPath(cfg)} is newer than the snapshots` };
  if (which('figma-cli') && await answers(figmaCliPort(env))) return { route: 'figma-cli', why: `figma-cli is installed and Figma answers on port ${figmaCliPort(env)}` };
  if (env.FIGMA_TOKEN && cfg.figmaFileKey) return { route: 'rest', why: 'FIGMA_TOKEN is set: the audit refreshes from the Figma API on every run' };
  return { route: 'mcp', why: 'no figma-cli connection and no design.json: the Figma tool of this session reads it' };
}

// Runs `figma-cli snapshot` in the project (it writes design.json), then imports it. Returns the import result.
export async function refreshFromFigmaCli(ROOT, cfg = {}, { run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 600000 }) } = {}) {
  const r = run('figma-cli', ['snapshot']);
  if (r.error || r.status !== 0) throw new Error(`figma-cli snapshot did not finish: ${(r.error?.message ?? r.stderr ?? '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`}`);
  return importDesign(ROOT, cfg);
}

// Imports design.json into the snapshots ds-config names, and says which Figma file it came from.
export async function importDesign(ROOT, cfg = {}, file = designJsonPath(cfg)) {
  const { importFigmaCli } = await import('./figma-cli-import.mjs');
  const out = importFigmaCli(ROOT, cfg, file);
  let source = null;
  try { source = JSON.parse(readFileSync(join(ROOT, file), 'utf8')).meta?.file ?? null; } catch { /* named in the error already */ }
  return { ...out, file, source };
}

export const importLine = (r) => `Figma read from ${r.file}${r.source ? ` (${r.source})` : ''}: ${r.counts.colours} colours in ${r.counts.modes} mode${r.counts.modes === 1 ? '' : 's'}, ${r.counts.sizing} sizes, ${r.counts.components} components → ${Object.values(r.paths).join(', ')}`;
