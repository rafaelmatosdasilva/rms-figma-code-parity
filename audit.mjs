// audit.mjs — Single-command parity audit runner.
// Run from project root: node scripts/audit.mjs [--trend]
//
// --trend: print the last 20 audit runs and exit (no new run)
// --init:  run first-time setup (scaffold config files) and exit without auditing
//
// First run: if ds-config.json is missing, asks 3 questions (Figma URL, CSS path,
// token) then auto-detects collection structure via Figma API, scaffolds
// parity-map.mjs + structure-contract.mjs, and writes ds-config.json.
// Commit all three — they contain no secrets and are required for CI.
// Subsequent runs: config exists, audit starts immediately.
//
// Gates:
//   [1]  Freshness             — snapshot files updated today; compiled outputs match source
//   [2]  Parity check          — token values: color + sizing + typography
//   [3]  Structure check       — heights + CSS base-rule var bindings
//   [4]  Bound-token coverage  — every bound Figma token has a CSS var
//   [5]  CSS hygiene           — no orphaned CSS vars; no raw literals in rules
//   [6]  Sub-component isolation — no broad element selector overrides sub-component styles
//   [7]  Visual regression     — Figma frame screenshots match stored references
//   [8]  State coverage        — state completeness + selector binding + var placement
//   [9]  Exemption validity    — EXPLICIT/SKIP_TOKENS/COVERED entries not stale in snapshot
//   [10] Mode completeness     — all mode-variant tokens adapt across every configured mode
//   [11] CSS naming round-trip — every theme.css var traces back to a Figma token
//   [12] Contract coverage     — ::before/::after + <symbol> elements declared in contract
//
// Performance: gates 2–4, 6–12 (subprocess-based) run in parallel via Promise.all.
//              Gates 1 and 5 are computed inline (file stats + CSS scan).

import readline                                                  from 'readline';
import { spawn, spawnSync }                                      from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync,
         writeFileSync, copyFileSync, mkdirSync,
         symlinkSync, unlinkSync }                               from 'fs';
import { join, dirname, resolve, relative }                     from 'path';
import { fileURLToPath }                                        from 'url';
import { buildReport }                                          from './report-html.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT       = process.cwd();

// Load .env from project root if present (no dotenv dependency)
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const today      = new Date().toISOString().slice(0, 10);
const WIDTH      = 60;
const SHOW_TREND = process.argv.includes('--trend');
const INIT_ONLY  = process.argv.includes('--init');

// ── Scoped runs: audit one or more chosen components, not the whole DS ─────────
// `--component ButtonPrimary` or `--component ButtonPrimary,Toast` or repeated
// `--component A --component B`. When set, the global gates report ONLY findings
// belonging to the chosen components and collapse everything else to a single
// "outside scope — not audited" line; a gate that failed only on out-of-scope
// items is treated as pass for the scoped run. Off by default (whole-DS audit).
function _argValues(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
    else if (process.argv[i].startsWith(flag + '=')) out.push(process.argv[i].slice(flag.length + 1));
  }
  return out;
}
const SCOPE_COMPONENTS = [..._argValues('--component'), ..._argValues('--components')]
  .flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean);

// ── Easy updates: link the command to this folder, and pull latest ────────────
// So people never have to re-download. `--link-command` points the global
// /rms-figma-code-parity command at THIS local skill folder via a symlink, so a
// plain `git pull` here updates the command too. `--update` does the pull for them
// and refreshes the link. Works whether the folder is a sibling clone or a submodule.
const HOME = process.env.HOME || process.env.USERPROFILE || '';
function linkCommand() {
  const src = join(SCRIPT_DIR, 'rms-figma-code-parity.md');
  const cmdDir = join(HOME, '.claude', 'commands');
  const link = join(cmdDir, 'rms-figma-code-parity.md');
  try {
    mkdirSync(cmdDir, { recursive: true });
    try { unlinkSync(link); } catch { /* nothing to replace */ }
    symlinkSync(src, link);
    console.log(`✅ Command linked: ${link}`);
    console.log(`   → ${src}`);
    console.log('   From now on a `git pull` in this folder updates /rms-figma-code-parity — no re-download.');
    return true;
  } catch (e) {
    console.log(`⚠️  Could not link the command (${e.message}).`);
    console.log(`   Manual alternative: ln -sf "${src}" "${link}"`);
    return false;
  }
}
function updateSkill() {
  console.log(`Updating the skill in ${SCRIPT_DIR} …`);
  const r = spawnSync('git', ['-C', SCRIPT_DIR, 'pull', '--ff-only'], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('⚠️  `git pull` did not succeed here. If this folder is a git checkout, run:');
    console.log(`      git -C "${SCRIPT_DIR}" pull`);
  }
  linkCommand();
  console.log('\n✅ Done. Just run /rms-figma-code-parity — you are on the latest.');
}
if (process.argv.includes('--update'))       { updateSkill(); process.exit(0); }
if (process.argv.includes('--link-command')) { process.exit(linkCommand() ? 0 : 1); }

// Set to true when variables/local returns 403 (Figma Enterprise plan required).
// Gates that depend on live variable refresh use planLimited state instead of
// pass/fail — they don't block the audit but clearly explain what couldn't run.
let _figmaApiLimited = false;
// Set when Figma rejects the credential itself (expired/revoked token), as opposed to
// the plan or scope gating an endpoint. Kept separate so the audit prescribes the right
// fix: a stale snapshot blamed on the plan hides a token that just needs reissuing.
let _figmaAuthFailed = false;
// The DS file's `version` id at the moment this run started, from
// GET /v1/files/:key?depth=1 — the ONE Figma endpoint that reports "has this file
// changed" on every plan, including the ones where variables/local 403s. Compared
// against the `_figmaVersion` recorded in the vars snapshot, it answers the question
// snapshot AGE cannot: a snapshot captured an hour ago is stale the moment the
// designer touches the file, and until now nothing noticed until someone re-ran
// Phase 1 by hand. null when unfetched (no token / network error).
let _figmaFileVersion = null;
let _figmaFileModified = null;

async function fetchFigmaFileVersion(fileKey, token) {
  if (!token || !fileKey) return;
  try {
    // depth=1 keeps the payload to the document node — no page or child traversal.
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        const body = await res.text();
        if (/invalid token|token.*expired|expired.*token/i.test(body)) _figmaAuthFailed = true;
      }
      return;
    }
    const j = await res.json();
    _figmaFileVersion  = j.version ?? null;
    _figmaFileModified = j.lastModified ?? null;
  } catch { /* offline — leave null, gate reports "could not check" */ }
}

// Live DS component inventory — the set of COMPONENT_SET names plus standalone COMPONENT
// names (variants of a set are excluded; the set name represents them). Both /component_sets
// and /components work on every plan, unlike variables/local. Gate [1] diffs this against the
// structure snapshot's component keys so a component ADDED to the DS (a new `loader`) or
// REMOVED can never stay invisible just because the snapshot was captured with a partial
// component list — the failure mode where a whole new component slips through unaudited.
// null when unfetched (no token / network error): the check then reports "could not verify".
let _liveComponentNames = null;

async function fetchComponentInventory(fileKey, token, pageId) {
  if (!token || !fileKey) return;
  try {
    const h = { 'X-Figma-Token': token };
    // Preferred: enumerate the DS components PAGE node's top-level children via /nodes —
    // works on every plan and, unlike /component_sets, sees UNPUBLISHED components (a DS
    // file usually isn't published to a library, so /component_sets returns empty there).
    if (pageId) {
      const nRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(pageId)}&depth=1`, { headers: h });
      if (nRes.ok) {
        const { nodes } = await nRes.json();
        const doc = nodes?.[pageId]?.document ?? Object.values(nodes ?? {})[0]?.document;
        const kids = doc?.children ?? [];
        const names = new Set(kids.filter(c => c.type === 'COMPONENT_SET' || c.type === 'COMPONENT').map(c => c.name));
        if (names.size) { _liveComponentNames = names; return; }
      }
    }
    // Fallback: published library endpoints (only populated for published DS files).
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, { headers: h });
    if (!csRes.ok) return;
    const { meta: csMeta } = await csRes.json();
    const names = new Set(Object.values(csMeta?.component_sets ?? {}).map(s => s.name));
    const compRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/components`, { headers: h });
    if (compRes.ok) {
      const { meta: compMeta } = await compRes.json();
      for (const c of Object.values(compMeta?.components ?? {})) {
        if (!c.containing_frame?.containingStateGroup) names.add(c.name);
      }
    }
    if (names.size) _liveComponentNames = names;
  } catch { /* offline — leave null */ }
}

// ── ANSI helpers (available before config loads) ──────────────────────────────
const isTTY = process.stdout.isTTY;
const C = {
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ── --trend: no config needed — just show history and exit ────────────────────
if (SHOW_TREND) {
  const histPath = join(ROOT, 'parity-history.json');
  try {
    const hist = JSON.parse(readFileSync(histPath, 'utf8'));
    console.log('\n' + C.bold('─── Parity Trend ───────────────────────────────────────────'));
    const recent = hist.slice(-20);
    for (const entry of recent) {
      const icon   = entry.fail === 0 ? C.green('✅') : C.red('❌');
      const filled = entry.pass ?? 0;
      const total  = entry.total ?? 8;
      const bar    = C.green('█'.repeat(filled)) + C.dim('░'.repeat(total - filled));
      console.log(`  ${icon}  ${entry.date}  ${String(filled).padStart(2)}/${total} [${bar}]`);
    }
    if (!hist.length) console.log('  No history yet — run: node scripts/audit.mjs');

    // Regression delta: show gate changes since last run
    if (recent.length >= 2) {
      const prev = recent[recent.length - 2];
      const curr = recent[recent.length - 1];
      const prevMap = Object.fromEntries((prev.gates ?? []).map(g => [g.label, g.pass]));
      const changes = (curr.gates ?? []).filter(g => prevMap[g.label] !== undefined && prevMap[g.label] !== g.pass);
      if (changes.length) {
        console.log('\n  ⚠️  Changes since last run:');
        for (const g of changes)
          console.log(`       ${g.pass ? C.green('✅') : C.red('❌')} ${g.label}  ${prevMap[g.label] ? 'PASS→FAIL' : 'FAIL→PASS'}`);
      } else {
        console.log('\n  ✅ No gate changes since last run');
      }
    }

    // Oscillation detector: gate that flipped ≥3× in last 6 runs
    const last6 = hist.slice(-6);
    for (const gate of (last6[0]?.gates ?? [])) {
      const states = last6.map(r => (r.gates ?? []).find(g => g.label === gate.label)?.pass);
      const flips = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
      if (flips >= 3) console.log(`  ⚠️  UNSTABLE: "${gate.label}" flipped ${flips}× in last ${last6.length} runs`);
    }

    console.log(C.bold('─'.repeat(WIDTH)) + '\n');
  } catch {
    console.log('\n⏭  No history yet — run: node scripts/audit.mjs\n');
  }
  process.exit(0);
}

// ── Figma collection analyser ─────────────────────────────────────────────────
// Queries /variables/local, inspects every collection's variable types and naming
// patterns, and returns the best mapping for ds-config.json without user input.
async function analyseCollections(fileKey, token) {
  try {
    const res  = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
      console.log(C.yellow(`  ⚠️  Figma API ${res.status} — collection auto-detect skipped`));
      return null;
    }
    const { meta } = await res.json();
    const vars  = Object.values(meta?.variables         ?? {});
    const cols  = Object.values(meta?.variableCollections ?? {});
    if (!cols.length) return null;

    // Per-collection stats
    const stats = cols.map(col => {
      const colVars = vars.filter(v => v.variableCollectionId === col.id);
      const byType  = {};
      for (const v of colVars) byType[v.resolvedType] = (byType[v.resolvedType] ?? 0) + 1;

      // Detect common top-level path prefix (e.g. "primitives/", "Base/", "Color/")
      const names   = colVars.map(v => v.name);
      const prefix  = (() => {
        const segments = names.map(n => n.split('/')[0] + '/');
        const counts   = {};
        for (const s of segments) counts[s] = (counts[s] ?? 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return top && top[1] / names.length > 0.7 ? top[0] : null;
      })();

      return { name: col.name, total: colVars.length, byType, prefix, modeCount: col.modes.length };
    });

    console.log(C.dim(`\n  Figma collections detected (${stats.length}):`));
    for (const s of stats) {
      const types = Object.entries(s.byType).map(([t, n]) => `${n} ${t}`).join(', ');
      console.log(C.dim(`    • ${s.name}  [${types}]  ${s.modeCount} mode(s)${s.prefix ? `  prefix: ${s.prefix}` : ''}`));
    }

    // Classify collections by what they contain
    const sorted      = [...stats].sort((a, b) => (b.byType.COLOR ?? 0) - (a.byType.COLOR ?? 0));
    const colorCol    = sorted[0]; // collection with most COLOR vars — kept for backward compat

    // Sizing collection: most FLOAT vars, single mode, not a breakpoint/animation collection
    const sizingCol   = stats
      .filter(s => s.name !== colorCol.name && (s.byType.FLOAT ?? 0) > 0 && s.modeCount === 1
                && !((s.byType.EASING ?? 0) + (s.byType.TIMING ?? 0) > 0))
      .sort((a, b) => (b.byType.FLOAT ?? 0) - (a.byType.FLOAT ?? 0))[0] ?? null;

    // Breakpoint collection: FLOAT/BOOLEAN only, 3+ modes — responsive sizing
    const breakpointCol = stats.find(s =>
      s.name !== colorCol.name &&
      s.modeCount >= 3 &&
      (s.byType.FLOAT ?? 0) + (s.byType.BOOLEAN ?? 0) === s.total
    ) ?? null;

    // Animation collection: contains EASING or TIMING vars
    const animationCol = stats.find(s =>
      (s.byType.EASING ?? 0) + (s.byType.TIMING ?? 0) > 0
    ) ?? null;

    // i18n / Language collections: STRING-only with locale-looking mode names (e.g. pt-PT, en-US)
    const localeRe = /^[a-z]{2}(-[A-Z]{2})?$/;
    const i18nCols = stats.filter(s => {
      const total = s.total;
      if (!total) return false;
      const stringOnly = (s.byType.STRING ?? 0) === total;
      const col = cols.find(c => c.name === s.name);
      const modeNames = col?.modes.map(m => m.name) ?? [];
      const localeNames = modeNames.filter(n => localeRe.test(n));
      return stringOnly && localeNames.length > 0;
    }).map(s => s.name);

    // Primitive prefix: single-mode collection with dominant path prefix + COLOR vars
    const primitiveCol = stats.find(s =>
      s.name !== colorCol.name &&
      s.modeCount === 1 &&
      s.prefix &&
      (s.byType.COLOR ?? 0) > 0
    ) ?? null;

    const primitivePrefix = primitiveCol
      ? primitiveCol.prefix
      : (colorCol.prefix ?? 'primitives/');

    console.log(C.dim(`\n  → Semantic color collection: "${colorCol.name}" (kept for scope; type-routing is default)`));
    if (sizingCol)      console.log(C.dim(`  → Sizing collection:         "${sizingCol.name}"`));
    if (breakpointCol)  console.log(C.dim(`  → Breakpoint collection:     "${breakpointCol.name}" (${breakpointCol.modeCount} modes)`));
    if (animationCol)   console.log(C.dim(`  → Animation collection:      "${animationCol.name}"`));
    if (i18nCols.length) console.log(C.dim(`  → i18n collections (skip):  ${i18nCols.map(n => `"${n}"`).join(', ')}`));
    if (primitiveCol)   console.log(C.dim(`  → Primitive prefix:          "${primitivePrefix}" (from "${primitiveCol.name}")`));
    console.log('');

    return {
      colorCollection:      colorCol.name,
      sizingCollection:     sizingCol?.name ?? null,
      breakpointCollection: breakpointCol?.name ?? null,
      animationCollection:  animationCol?.name ?? null,
      excludeCollections:   i18nCols,
      primitivePrefix,
    };
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Collection auto-detect failed (${e.message}) — using defaults`));
    return null;
  }
}

// ── Refresh component-property definitions from Figma REST API ───────────────
// Writes figma-component-props.snapshot.json. Called on every audit run when
// FIGMA_TOKEN is set. Queries /component_sets (names + nodeIds) then
// /nodes?ids=... (componentPropertyDefinitions). Safe to skip: gate [3g]
// falls back to reading an existing snapshot and warns if it's missing.
async function refreshComponentProps(fileKey, token, outPath) {
  try {
    const h = { 'X-Figma-Token': token };

    // ① Component SETS (variant groups) — the primary source
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, { headers: h });
    if (!csRes.ok) {
      console.log(C.yellow(`  ⚠️  Figma ${csRes.status} — component props refresh skipped`));
      return false;
    }
    const { meta: csMeta } = await csRes.json();
    const sets  = Object.entries(csMeta?.component_sets ?? {});
    const ids   = sets.map(([id]) => id);
    const names = Object.fromEntries(sets.map(([id, s]) => [id, s.name]));

    // ② Standalone COMPONENTS (single components not in a variant set)
    const compRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/components`, { headers: h });
    const { meta: compMeta } = compRes.ok ? await compRes.json() : { meta: {} };
    const standaloneEntries = Object.entries(compMeta?.components ?? {})
      .filter(([, c]) => !c.containing_frame?.containingStateGroup);
    for (const [nodeId, c] of standaloneEntries) {
      if (!names[nodeId]) { ids.push(nodeId); names[nodeId] = c.name; }
    }

    // ③ Fallback: for unpublished files (API returns nothing), refresh known nodeIds
    //    from the existing snapshot so annotations always stay current.
    let existingSnap = {};
    try { existingSnap = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
    for (const [name, entry] of Object.entries(existingSnap)) {
      if (name === '_updated' || !entry?.nodeId) continue;
      if (!names[entry.nodeId]) { ids.push(entry.nodeId); names[entry.nodeId] = name; }
    }

    if (!ids.length) return false;
    const result = {};

    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const nRes  = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: h }
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const [nodeId, data] of Object.entries(nodes ?? {})) {
        const doc   = data?.document;
        const props = doc?.componentPropertyDefinitions ?? {};
        const anns  = doc?.annotations ?? [];
        if (Object.keys(props).length || anns.length) {
          result[names[nodeId] ?? doc?.name ?? nodeId] = { nodeId, properties: props, annotations: anns };
        }
      }
    }

    result._updated = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ Component props: ${Object.keys(result).length - 1} component(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Component props refresh failed: ${e.message}`));
    return false;
  }
}

// ── Auto-refresh bound-tokens.json + component-state-tokens.json via REST API ─
// Replaces the manual Phase 2 Plugin API walk. Called on every audit run when
// FIGMA_TOKEN + frames are configured. Writes the same format consumed by
// bound-check.mjs and state-check.mjs: { "Token/Path": true, ... }.

function collectBound(node, idToName, tokenSet) {
  for (const ref of Object.values(node?.boundVariables ?? {})) {
    const refs = Array.isArray(ref) ? ref : [ref];
    for (const r of refs) if (r?.id && idToName[r.id]) tokenSet.add(idToName[r.id]);
  }
  for (const child of node?.children ?? []) collectBound(child, idToName, tokenSet);
}

// Visibility-aware variant of collectBound (Hard Rule 7). Tracks, per token, whether
// it is ever bound on a VISIBLE node. A token whose every binding sits on a hidden
// node (visible=false, itself or via a hidden ancestor) is not a hard requirement in
// THIS project — the element is switched off here and may be toggled on elsewhere.
// `toggleSet` additionally marks hidden bindings that sit under a visibility boolean
// (`boundVariables.visible`), so the report can say "off in this project" vs "static".
function collectBoundVis(node, idToName, allSet, visibleSet, toggleSet, hidden = false, gated = false) {
  if (!node || typeof node !== 'object') return;
  const isHidden = hidden || node.visible === false;
  const isGated  = gated  || node.boundVariables?.visible != null;
  for (const ref of Object.values(node.boundVariables ?? {})) {
    const refs = Array.isArray(ref) ? ref : [ref];
    for (const r of refs) {
      const name = r?.id && idToName[r.id];
      if (!name) continue;
      allSet.add(name);
      if (!isHidden) visibleSet.add(name);
      else if (isGated) toggleSet.add(name);
    }
  }
  for (const child of node.children ?? []) collectBoundVis(child, idToName, allSet, visibleSet, toggleSet, isHidden, isGated);
}

// variables/local is hit by three refreshers (bound tokens, state tokens, state bindings).
// Memoize the in-flight promise so the fetch happens once even when they run concurrently
// (and a 403 on a non-Enterprise plan is only paid once, not three times).
let _varIdMapPromise = null;
function buildVarIdMap(fileKey, token) {
  return (_varIdMapPromise ??= (async () => {
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
      // A 403 means either "this plan/scope can't reach the endpoint" or "your token is
      // no longer valid". They need opposite fixes — run the Plugin API capture vs.
      // reissue FIGMA_TOKEN — so never collapse them into one message.
      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        if (/invalid token|token.*expired|expired.*token/i.test(body)) _figmaAuthFailed = true;
        else                                                          _figmaApiLimited = true;
      }
      throw new Error(`variables/local returned ${res.status}`);
    }
    const { meta } = await res.json();
    const idToName = {};
    for (const [id, v] of Object.entries(meta?.variables ?? {})) idToName[id] = v.name;
    return idToName;
  })());
}

async function refreshBoundTokens(fileKey, frames, token, outPath) {
  if (!frames?.length) return false;
  try {
    const idToName = await buildVarIdMap(fileKey, token);
    const tokenSet = new Set();
    for (const frame of frames) {
      const nRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${frame.nodeId}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) { console.log(C.yellow(`  ⚠️  /nodes ${frame.nodeId} → ${nRes.status}`)); continue; }
      const { nodes } = await nRes.json();
      for (const data of Object.values(nodes ?? {})) collectBound(data?.document, idToName, tokenSet);
    }
    const result = { _updated: new Date().toISOString(), ...Object.fromEntries([...tokenSet].map(t => [t, true])) };
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ Bound tokens: ${tokenSet.size} token(s) across ${frames.length} frame(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Bound tokens refresh failed: ${e.message}`));
    return false;
  }
}

// ── Auto-refresh figma-frame-geometry.snapshot.json via REST /nodes ──────────
// Captures every FRAME/INSTANCE/COMPONENT's box (h, pad[t,r,b,l], gap) from the DS
// layout frame(s), keyed by node name (array + _path when a name repeats). Consumed
// by RENDERED_ASSERTIONS `frameGeom` sourcing (Gate [16]). Uses the /nodes endpoint —
// available on any plan, unlike variables/local — so it is NOT plan-limited.
async function refreshFrameGeometry(fileKey, frames, token, outPath) {
  if (!frames?.length) return false;
  try {
    const byName = {};
    for (const frame of frames) {
      const nRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${frame.nodeId}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) { console.log(C.yellow(`  ⚠️  /nodes ${frame.nodeId} → ${nRes.status}`)); continue; }
      const { nodes } = await nRes.json();
      for (const data of Object.values(nodes ?? {})) {
        (function rec(n, path) {
          if (!n) return;
          if (n.type === 'FRAME' || n.type === 'INSTANCE' || n.type === 'COMPONENT') {
            const pad = [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0];
            const h = Math.round(n.absoluteBoundingBox?.height ?? n.size?.y ?? 0);
            const gap = typeof n.itemSpacing === 'number' ? n.itemSpacing : null;
            (byName[n.name] ??= []).push({ _path: path, h, pad, gap });
          }
          for (const c of n.children ?? []) rec(c, path + '/' + n.name);
        })(data?.document, '');
      }
    }
    // Per name: drop _path when all entries are identical (collapse to a single object).
    const outNodes = {};
    for (const [name, arr] of Object.entries(byName)) {
      const seen = new Map();
      for (const e of arr) { const k = JSON.stringify([e.h, e.pad, e.gap]); if (!seen.has(k)) seen.set(k, e); }
      const uniq = [...seen.values()];
      outNodes[name] = uniq.length === 1
        ? { h: uniq[0].h, pad: uniq[0].pad, gap: uniq[0].gap }
        : uniq;
    }
    const out = {
      _updated: new Date().toISOString(),
      _note: 'Per-container geometry (h, pad [t,r,b,l], gap) captured from the DS layout frame(s). Consumed by RENDERED_ASSERTIONS frameGeom sourcing. Auto-generated — do not edit by hand.',
      nodes: outNodes,
    };
    writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
    console.log(C.dim(`  ✅ Frame geometry: ${Object.keys(outNodes).length} node name(s) across ${frames.length} frame(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Frame geometry refresh failed: ${e.message}`));
    return false;
  }
}

// ── Collect structured state bindings: component → variant → { props, bindings } ─
// Used by structure-check.mjs Gate [3c] to auto-derive CSS assertions without
// manual CSS_BASE_RULE_VARS entries. Only fills + strokes at root and direct TEXT
// children are collected — these map cleanly to background/border-color/color.
function collectBindingsFromNode(node, idToName, result, maxDepth = 1, depth = 0) {
  if (depth > maxDepth) return;
  const isText = node.type === 'TEXT';
  for (const [field, ref] of Object.entries(node.boundVariables ?? {})) {
    if (field !== 'fills' && field !== 'strokes') continue;
    const refs = Array.isArray(ref) ? ref : [ref];
    for (const r of refs) {
      const name = idToName[r?.id];
      if (name) result.push({ token: name, bindingField: field, isText, depth });
    }
  }
  for (const child of node.children ?? []) {
    collectBindingsFromNode(child, idToName, result, maxDepth, depth + 1);
  }
}

async function refreshStateBindings(fileKey, token, outPath) {
  try {
    const idToName = await buildVarIdMap(fileKey, token);
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!csRes.ok) return false;
    const { meta: csMeta } = await csRes.json();
    const sets   = csMeta?.component_sets ?? {};
    const setIds = Object.keys(sets);
    if (!setIds.length) return false;

    const result = {};
    const BATCH  = 50;
    for (let i = 0; i < setIds.length; i += BATCH) {
      const batch = setIds.slice(i, i + BATCH);
      const nRes  = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const [setId, data] of Object.entries(nodes ?? {})) {
        const setName = sets[setId]?.name ?? data?.document?.name ?? setId;
        const setNode = data?.document;
        if (!setNode) continue;
        const variants = {};
        for (const variant of setNode.children ?? []) {
          if (variant.type !== 'COMPONENT') continue;
          const props = {};
          for (const part of (variant.name ?? '').split(',')) {
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            props[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase();
          }
          const bindings = [];
          collectBindingsFromNode(variant, idToName, bindings, 1, 0);
          if (bindings.length) variants[variant.name] = { props, bindings };
        }
        if (Object.keys(variants).length) result[setName] = variants;
      }
    }

    writeFileSync(outPath, JSON.stringify({ _updated: new Date().toISOString(), ...result }, null, 2) + '\n');
    console.log(C.dim(`  ✅ State bindings: ${Object.keys(result).length} component set(s) indexed`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  State bindings refresh failed: ${e.message}`));
    return false;
  }
}

async function refreshStateTokens(fileKey, token, outPath) {
  try {
    const idToName = await buildVarIdMap(fileKey, token);
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!csRes.ok) { console.log(C.yellow(`  ⚠️  /component_sets → ${csRes.status}`)); return false; }
    const { meta: csMeta } = await csRes.json();
    const setIds = Object.keys(csMeta?.component_sets ?? {});
    if (!setIds.length) return false;
    const allSet = new Set(), visibleSet = new Set(), toggleSet = new Set();
    const BATCH = 50;
    for (let i = 0; i < setIds.length; i += BATCH) {
      const batch = setIds.slice(i, i + BATCH);
      const nRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const data of Object.values(nodes ?? {})) collectBoundVis(data?.document, idToName, allSet, visibleSet, toggleSet);
    }
    // Hard Rule 7: a token bound only on hidden nodes is not a hard requirement here.
    const hiddenOnly       = [...allSet].filter(t => !visibleSet.has(t));
    const hiddenToggleable = hiddenOnly.filter(t => toggleSet.has(t));
    const result = {
      _updated: new Date().toISOString(),
      _hiddenOnly: hiddenOnly.sort(),
      _hiddenToggleable: hiddenToggleable.sort(),
      ...Object.fromEntries([...allSet].map(t => [t, true])),
    };
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ State tokens: ${allSet.size} token(s) across ${setIds.length} set(s)` +
      (hiddenOnly.length ? ` (${hiddenOnly.length} hidden-only, not required)` : '')));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  State tokens refresh failed: ${e.message}`));
    return false;
  }
}

// ── Per-component raw-value sweep (Gate [8] parity scoping) ──────────────────
// Walks EVERY node of a component (all variants, all descendants, hidden included)
// and collects the raw geometry numbers and colours those nodes actually use — NOT
// tokens, the literal values. This is what lets the hardcoded-value gate answer
// "is this 24px the same 24px Figma uses on THIS component?" per component instead
// of globally. Written as component-values.snapshot.json: { "Comp": { nums, colors } }.
const _rgbToHex = (c) => {
  if (!c) return null;
  const to = (x) => Math.round((x ?? 0) * 255).toString(16).padStart(2, '0');
  return (to(c.r) + to(c.g) + to(c.b)).toLowerCase();
};
function collectRawValues(node, nums, colors) {
  if (!node || typeof node !== 'object') return;
  const pushN = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) { nums.add(Math.round(n * 100) / 100); nums.add(Math.round(n)); }
  };
  const bb = node.absoluteBoundingBox || node.size;
  if (bb) { pushN(bb.width ?? bb.x); pushN(bb.height ?? bb.y); }
  pushN(node.cornerRadius);
  if (Array.isArray(node.rectangleCornerRadii)) node.rectangleCornerRadii.forEach(pushN);
  pushN(node.strokeWeight);
  pushN(node.itemSpacing);
  pushN(node.paddingLeft); pushN(node.paddingRight); pushN(node.paddingTop); pushN(node.paddingBottom);
  if (node.style?.fontSize) pushN(node.style.fontSize);
  for (const f of node.fills   ?? []) if (f?.type === 'SOLID' && f.color) { const h = _rgbToHex(f.color); if (h) colors.add(h); }
  for (const s of node.strokes ?? []) if (s?.color) { const h = _rgbToHex(s.color); if (h) colors.add(h); }
  for (const e of node.effects ?? []) if (e?.color) { const h = _rgbToHex(e.color); if (h) colors.add(h); }
  for (const child of node.children ?? []) collectRawValues(child, nums, colors);
}

async function refreshComponentValues(fileKey, token, outPath) {
  try {
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!csRes.ok) return false;
    const { meta: csMeta } = await csRes.json();
    const sets   = csMeta?.component_sets ?? {};
    const setIds = Object.keys(sets);
    if (!setIds.length) return false;
    const result = {};
    const BATCH  = 50;
    for (let i = 0; i < setIds.length; i += BATCH) {
      const batch = setIds.slice(i, i + BATCH);
      const nRes  = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const [setId, data] of Object.entries(nodes ?? {})) {
        const name = sets[setId]?.name ?? data?.document?.name ?? setId;
        const nums = new Set(), colors = new Set();
        collectRawValues(data?.document, nums, colors);
        result[name] = { nums: [...nums].sort((a, b) => a - b), colors: [...colors].sort() };
      }
    }
    writeFileSync(outPath, JSON.stringify({ _updated: new Date().toISOString(), ...result }, null, 2) + '\n');
    console.log(C.dim(`  ✅ Component values: ${Object.keys(result).length} component set(s) swept`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Component values refresh failed: ${e.message}`));
    return false;
  }
}

// ── Bootstrap: generate ds-config.json from 3 questions ──────────────────────
// Called when ds-config.json is missing (or --init flag). Auto-detects CSS paths,
// plugin files, snapshot locations, and Figma collection structure via API.
async function bootstrapConfig() {
  console.log('\n' + C.bold('rms-parity — first-time setup'));
  console.log(C.dim('─'.repeat(WIDTH)));

  // Auto-detect token CSS
  const candidates = [];
  const CSS_EXTS = ['.css', '.scss', '.sass', '.less'];
  function looksLikeTokenFile(absPath) {
    try { const t = readFileSync(absPath, 'utf8'); return t.includes(':root') && t.includes('--'); }
    catch { return false; }
  }
  const scanRoots = ['packages', 'src', 'app', 'styles', 'assets', 'tokens'];
  for (const base of scanRoots) {
    const baseDir = join(ROOT, base);
    if (!existsSync(baseDir)) continue;
    try {
      for (const f of readdirSync(baseDir)) {
        const dot = f.lastIndexOf('.');
        if (dot !== -1 && CSS_EXTS.includes(f.slice(dot))) {
          const rel = join(base, f);
          if (looksLikeTokenFile(join(ROOT, rel))) candidates.push(rel);
        }
      }
      for (const sub of readdirSync(baseDir)) {
        const subDir = join(baseDir, sub);
        if (!statSync(subDir).isDirectory()) continue;
        for (const entry of ['styles', 'src', '']) {
          const dir = entry ? join(subDir, entry) : subDir;
          if (!existsSync(dir)) continue;
          try {
            for (const f of readdirSync(dir)) {
              const dot = f.lastIndexOf('.');
              if (dot !== -1 && CSS_EXTS.includes(f.slice(dot))) {
                const rel = join(base, sub, entry, f).replace(/[\\/]+/g, '/').replace(/\/$/, '');
                if (looksLikeTokenFile(join(ROOT, rel))) candidates.push(rel);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  for (const f of readdirSync(ROOT)) {
    const dot = f.lastIndexOf('.');
    if (dot !== -1 && CSS_EXTS.includes(f.slice(dot)) && looksLikeTokenFile(join(ROOT, f)))
      candidates.push(f);
  }
  const unique = [...new Set(candidates)];
  const detectedCSS = unique.length === 1 ? unique[0] : null;
  if (unique.length) console.log(C.dim(`  Found token CSS file(s): ${unique.join(', ')}`));

  // Auto-detect plugin CSS
  const pluginCSS = [], plugins = [];
  const appsDir = join(ROOT, 'apps');
  if (existsSync(appsDir)) {
    try {
      for (const p of readdirSync(appsDir).sort()) {
        const uiSrc = join('apps', p, 'ui.src.html');
        if (existsSync(join(ROOT, uiSrc))) { pluginCSS.push(uiSrc); plugins.push(p); }
      }
    } catch {}
  }
  if (!pluginCSS.length && existsSync(join(ROOT, 'src', 'ui.src.html')))
    pluginCSS.push('src/ui.src.html');
  if (pluginCSS.length) {
    const names = plugins.length ? plugins.slice(0, 3).join(', ') + (plugins.length > 3 ? '…' : '') : pluginCSS.join(', ');
    console.log(C.dim(`  Found ${pluginCSS.length} plugin CSS file(s): ${names}`));
  }
  console.log('');

  // ── 3 questions ───────────────────────────────────────────────────────────────
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  // Q1 — Figma file URL
  const figmaRaw     = (await ask('Figma file URL: ')).trim();
  const figmaFileKey = (() => {
    const m = figmaRaw.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
    return m ? m[1] : figmaRaw;
  })();

  // Q2 — Token CSS path(s)
  let themeCSS;
  const defaultHint = detectedCSS ?? (unique.length > 1 ? unique.join(', ') : null);
  if (defaultHint) {
    const ans  = (await ask(`Token CSS file(s) [${defaultHint}]: `)).trim();
    const parts = (ans || defaultHint).split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? parts[0] : parts;
  } else {
    const ans  = (await ask('Token CSS file(s) (e.g. src/styles/theme.css): ')).trim();
    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? (parts[0] || 'src/theme.css') : parts;
  }

  // Q3 — FIGMA_TOKEN (needed for collection auto-detect + Gate 9)
  const existingToken = process.env.FIGMA_TOKEN ?? '';
  let figmaToken = existingToken;
  if (!existingToken) {
    const tok = (await ask('Figma personal access token (leave blank to skip): ')).trim();
    figmaToken = tok;
  } else {
    console.log(C.dim('  FIGMA_TOKEN already set in .env — using it for collection detection'));
  }

  // Q3b — Consumer file?
  let figmaSourceKey = '';
  const isConsumer = (await ask('Is this a Figma consumer file that uses an external DS library? (y/N): ')).trim().toLowerCase();
  if (isConsumer === 'y' || isConsumer === 'yes') {
    const srcUrl = (await ask('DS source Figma URL: ')).trim();
    if (srcUrl) {
      const m = srcUrl.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
      figmaSourceKey = m ? m[1] : srcUrl;
    }
  }

  rl.close();
  console.log('');

  // ── Auto-detect Figma collections ─────────────────────────────────────────────
  let figmaCfg = { colorCollection: 'Color', sizingCollection: null, breakpointCollection: null, animationCollection: null, excludeCollections: [], primitivePrefix: 'primitives/' };
  if (figmaFileKey && figmaToken) {
    console.log(C.dim('  Querying Figma for collection structure…'));
    const detected = await analyseCollections(figmaFileKey, figmaToken);
    if (detected) figmaCfg = { ...figmaCfg, ...detected };
  } else if (figmaFileKey && !figmaToken) {
    console.log(C.yellow('  ⚠️  No FIGMA_TOKEN — collection names defaulted to "Color" / null. Edit ds-config.json if needed.'));
  }

  // ── Write config ──────────────────────────────────────────────────────────────
  const firstTheme        = [themeCSS].flat()[0];
  const cssDir            = dirname(firstTheme);
  const snapshotVars      = join(cssDir, 'figma-vars.snapshot.json').replace(/\\/g, '/');
  const snapshotStructure = join(cssDir, 'figma-structure.snapshot.json').replace(/\\/g, '/');

  const generated = {
    figmaFileKey:  figmaFileKey || '',
    ...(figmaSourceKey ? { figmaSourceKey } : {}),
    frames: [],
    figma: {
      ...figmaCfg,
      modes: [
        { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
        { name: 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
      ],
    },
    paths: { themeCSS, snapshotVars, snapshotStructure, pluginCSS, plugins },
    visualRefs: '.parity-refs',
    webhook: { port: 3456, secret: 'YOUR_WEBHOOK_SECRET' },
    knownUnusedVars: [],
    knownHardcodedExceptions: [],
  };

  writeFileSync(join(ROOT, 'ds-config.json'), JSON.stringify(generated, null, 2) + '\n');
  console.log(C.green('✅ ds-config.json written'));

  // ── Save FIGMA_TOKEN to .env ──────────────────────────────────────────────────
  if (figmaToken && !existingToken) {
    const envContent = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
    if (!envContent.includes('FIGMA_TOKEN')) {
      writeFileSync(join(ROOT, '.env'), envContent + (envContent.endsWith('\n') ? '' : '\n') + `FIGMA_TOKEN=${figmaToken}\n`);
      console.log(C.green('✅ FIGMA_TOKEN saved to .env'));
    }
  }

  // ── Scaffold parity-map.mjs and structure-contract.mjs ───────────────────────
  for (const [example, target] of [
    ['parity-map.example.mjs',          'parity-map.mjs'],
    ['structure-contract.example.mjs',  'structure-contract.mjs'],
  ]) {
    const src  = join(SCRIPT_DIR, example);
    const dest = join(ROOT, target);
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest);
      console.log(C.green(`✅ ${target} scaffolded from example — fill in your DS values`));
    }
  }

  // ── Update .gitignore ─────────────────────────────────────────────────────────
  const giPath    = join(ROOT, '.gitignore');
  const giContent = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  // Only gitignore secrets and auto-generated transients.
  // ds-config.json, parity-map.mjs, structure-contract.mjs contain no secrets —
  // commit them so CI can run parity without interactive setup.
  const toAdd     = ['.env', 'bound-tokens.json', 'component-state-tokens.json', 'component-state-bindings.json', 'parity-check-result.json']
    .filter(e => !giContent.split('\n').some(l => l.trim() === e));
  if (toAdd.length) {
    const block = '\n# rms-parity: secrets + auto-generated transients — do not commit\n' + toAdd.join('\n') + '\n';
    writeFileSync(giPath, giContent + (giContent.endsWith('\n') ? '' : '\n') + block);
    console.log(C.green('✅ .gitignore updated'));
  }

  // ── Next-steps checklist ──────────────────────────────────────────────────────
  console.log('\n' + C.bold('─── Next steps ─────────────────────────────────────────────'));
  console.log(`  1. ${C.bold('ds-config.json')} — add frame node IDs (from the Figma frame URL)`);
  console.log(`       "frames": [{ "name": "My Screen", "nodeId": "123-456" }]`);
  if (!figmaToken) {
    console.log(`  2. ${C.bold('.env')} — add your Figma token for Gate [9] visual regression:`);
    console.log(`       FIGMA_TOKEN=your_token_here`);
  }
  console.log(`  3. ${C.bold('parity-map.mjs')} — fill in primitive scale (NEUTRAL_LIGHT/DARK)`);
  console.log(`       and any token→var exceptions (EXPLICIT, SKIP_TOKENS)`);
  console.log(`  4. ${C.bold('structure-contract.mjs')} — add component height/padding contracts`);
  console.log(`       (only needed for Gates [3] and [8])`);
  console.log(`  5. Run ${C.bold('/rms-parity')} Phase 1 to capture the live Figma snapshot`);
  console.log('─'.repeat(WIDTH) + '\n');

  return generated;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // ── Load or generate config ─────────────────────────────────────────────────
  let cfg = {};
  if (INIT_ONLY) {
    await bootstrapConfig();
    process.exit(0);
  }
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8'));
  } catch {
    if (process.env.CI) {
      console.error('❌ ds-config.json not found. In CI, commit ds-config.json to the repository (it contains no secrets — only paths and the public Figma file key).');
      process.exit(1);
    }
    cfg = await bootstrapConfig();
  }

  // THEMES: always an array — supports single string or array of paths
  const THEMES      = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const THEME       = THEMES[0]; // primary path (for snapshot derivation, Gate 7)
  const THEME_LABEL = THEMES.length === 1 ? THEMES[0] : `[${THEMES.map(p => p.split('/').pop()).join(', ')}]`;
  function readThemeCSS() {
    return THEMES.filter(p => existsSync(join(ROOT, p)))
      .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n');
  }
  const SNAP_VARS        = cfg.paths?.snapshotVars       ?? 'src/figma-vars.snapshot.json';
  const SNAP_STRUCT      = cfg.paths?.snapshotStructure  ?? 'src/figma-structure.snapshot.json';
  const SNAP_COMP_PROPS  = cfg.paths?.compPropsSnapshot  ??
    SNAP_VARS.replace(/[^/\\]+$/, 'figma-component-props.snapshot.json');
  const SNAP_FRAME_GEOM  = cfg.paths?.snapshotFrameGeometry ?? null;
  const PLUGIN_CSS  = cfg.paths?.pluginCSS          ?? [];
  const PLUGINS     = cfg.paths?.plugins            ?? [];
  const KNOWN_UNUSED     = new Set(cfg.knownUnusedVars         ?? []);

// ── Full findings on disk ─────────────────────────────────────────────────────
// Every list here is capped so the terminal stays readable, but a capped list is a
// half-truth: "80 hit(s)" that prints 20 sends you off to write your own scanner to
// see the rest — which is exactly what happened. Write the complete list next to the
// summary and name the file, so nothing is ever only-partly reported.
const _overflowDir = join(ROOT, '.parity-out');
const _overflowFiles = [];
function reportFull(label, items, shown) {
  if (items.length <= shown) return [];
  try {
    if (!existsSync(_overflowDir)) mkdirSync(_overflowDir, { recursive: true });
    const file = join(_overflowDir, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`);
    writeFileSync(file, items.join('\n') + '\n');
    _overflowFiles.push(file);
    return [C.dim(`     … ${items.length - shown} more — full list: ${relative(ROOT, file)}`)];
  } catch {
    return [C.dim(`     … ${items.length - shown} more (could not write the full list)`)];
  }
}

  const KNOWN_FS_EXCEPTS = cfg.knownHardcodedExceptions        ?? cfg.knownFontSizeExceptions ?? [];
  // Indices of exceptions that suppressed at least one real line this run. Everything
  // else is either stale (the code it excused is gone) or was never needed.
  const _exceptHits = new Set();
  // findIndex → record + report truthiness in one step, so every call site that
  // consults the exception list also contributes to the staleness audit.
  const markExceptHit = (i) => { if (i !== -1) { _exceptHits.add(i); return true; } return false; };

  // Directories and files to never scan for var() references or hardcoded values.
  const SCAN_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.nuxt', '.next', '.output',
    'coverage', '.cache', 'public', 'static',
    ...(cfg.scanExcludeDirs ?? []),
  ]);
  // Only scan files that can realistically contain CSS var() references.
  const SCAN_EXTENSIONS = new Set([
    '.css', '.scss', '.sass', '.less', '.styl',
    '.vue', '.svelte',
    '.html', '.htm',
    '.jsx', '.tsx', '.js', '.ts',
  ]);
  // Files whose content is auto-generated and should not be treated as source.
  const SCAN_EXCLUDE_FILENAMES = new Set([
    'figma-vars.snapshot.json', 'figma-structure.snapshot.json',
    'figma-component-props.snapshot.json',
    'bound-tokens.json', 'component-state-tokens.json', 'component-state-bindings.json', 'parity-history.json', 'master-token-table.md',
    ...(cfg.scanExcludeFilenames ?? []),
  ]);

  // scanExcludeFilenames entries may use `*` wildcards (e.g. "preview-*.html"), so a
  // project can exclude a family of generated files without listing each one. Exact
  // names still match as before.
  const SCAN_EXCLUDE_GLOBS = [...SCAN_EXCLUDE_FILENAMES]
    .filter(n => n.includes('*'))
    .map(n => new RegExp('^' + n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));

  function collectSourceFiles(dir = ROOT, results = []) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const e of entries) {
      if (SCAN_EXCLUDE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        collectSourceFiles(join(dir, e.name), results);
      } else if (e.isFile()) {
        if (SCAN_EXCLUDE_FILENAMES.has(e.name) || SCAN_EXCLUDE_GLOBS.some(r => r.test(e.name))) continue;
        const dot = e.name.lastIndexOf('.');
        if (dot !== -1 && SCAN_EXTENSIONS.has(e.name.slice(dot))) {
          results.push(join(dir, e.name));
        }
      }
    }
    return results;
  }

  // Lazily collected once and reused across gates.
  let _allSourceFiles = null;
  function allSourceFiles() {
    if (!_allSourceFiles) _allSourceFiles = collectSourceFiles();
    return _allSourceFiles;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function sh(cmd, args = [], opts = {}) {
    return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  }

  function runScriptAsync(scriptPath, args = []) {
    return new Promise(res => {
      const abs = resolve(SCRIPT_DIR, scriptPath);
      if (!existsSync(abs)) return res({ status: null, stdout: '', stderr: '' });
      const child = spawn('node', [abs, ...args], { cwd: ROOT, env: process.env });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => res({ status, stdout, stderr }));
    });
  }

  // A snapshot can be fresh and still be useless: if a capture returns nothing, the
  // file is written with only its _updated stamp, every consuming gate silently
  // checks zero items, and the audit reports green. Age alone cannot see that —
  // count the real entries too. Metadata keys are _-prefixed by convention.
  function snapshotEntryCount(file, key = null) {
    try {
      const snap = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      const scope = key ? (snap[key] ?? {}) : snap;
      return Object.keys(scope).filter((k) => !k.startsWith('_')).length;
    } catch { return null; }
  }

  function snapshotAge(file) {
    try {
      const snap = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      if (!snap._updated) return null;
      return Math.floor((Date.now() - new Date(snap._updated).getTime()) / 3_600_000);
    } catch { return null; }
  }

  // ── Gate parsers (subprocess-based gates) ────────────────────────────────────
  function parseGate2(r) {
    if (r.status === null) return { pass: false, lines: [C.red('parity-check.mjs not found')] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n').filter(l => /✅|❌|⚠️/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') || l.trim().startsWith('Fix:'))
      .map(l => '  ' + l.trim()).slice(0, 30);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate3(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ structure-check.mjs not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n').filter(l => /✅|❌/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') && !l.includes('FAIL  0'))
      .map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate4(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ bound-check.mjs not found — skipped'] };
    const out = r.stdout + r.stderr;
    if (r.status === 2) {
      // bound-tokens.json is missing. Frames are optional — when the audited URL is a
      // COMPONENT_SET definition (not a screen with instances), ds-config.json frames[]
      // is legitimately empty and there is nothing to walk. Degrade to SKIP rather than
      // hard-fail: the user opted out of frame-usage coverage, not misconfigured it.
      if (!cfg.frames?.length) {
        return {
          pass: true,
          lines: [
            C.yellow('⏭ SKIPPED — no frames[] configured in ds-config.json.'),
            C.dim('   Bound-token coverage checks tokens bound in usage frames (screens with instances).'),
            C.dim('   Add ds-config.json frames[] to enable it; auditing a COMPONENT_SET definition needs none.'),
          ],
        };
      }
      // Frames ARE configured but the file was never generated — that is a real error.
      return {
        pass: false,
        lines: [
          C.red('❌ HARD FAIL — bound-tokens.json missing (frames[] are configured).'),
          _figmaApiLimited
            ? C.red('   Variables REST API requires Enterprise plan — generate via Plugin API and commit.')
            : C.red('   Set FIGMA_TOKEN so the configured frames[] auto-generate it.'),
        ],
      };
    }
    // Coverage always runs fully against bound-tokens.json regardless of plan —
    // the file is refreshed via REST when available, or via the Phase 1 Plugin API
    // walk otherwise. Staleness of the file itself is Gate [1]'s job, not this gate's.
    const pass       = r.status === 0;
    const summary    = out.split('\n').filter(l => /COVERED|UNCOVERED/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n').filter(l => l.trim().startsWith('❌')).map(l => '  ' + l.trim()).slice(0, 20);
    const boundAge   = snapshotAge('bound-tokens.json');
    const provenance = boundAge === null
      ? C.dim('coverage source: bound-tokens.json (no _updated stamp — age tracked by Gate [1] once refreshed)')
      : C.dim(`coverage source: bound-tokens.json (updated ${boundAge}h ago via ${_figmaApiLimited ? 'Plugin API' : 'REST'})`);
    return { pass, lines: [provenance, ...summary, ...failDetails] };
  }

  function parseGate8(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ subcomponent-isolation-check.mjs not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n')
      .filter(l => /✅ DOCUMENTED|✅ No new|❌ UNDOCUMENTED/.test(l) && l.trim())
      .map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') && !l.includes('UNDOCUMENTED'))
      .map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate9(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ visual-regression-check.mjs not found — skipped'] };
    const out = r.stdout + r.stderr;
    if (r.status === 0 && out.includes('No frames')) {
      const msg = out.split('\n').find(l => l.trim()) ?? 'Skipped';
      return { pass: true, lines: [`⏭ ${msg.trim()}`] };
    }
    const pass     = r.status === 0;
    const summary  = out.split('\n').filter(l => /✅|❌|📸|ℹ️/.test(l) && l.trim()).map(l => l.trim()).slice(0, 8);
    const fixLines = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('mv ') || l.includes('.new.png'))
      .map(l => '  ' + l.trim()).slice(0, 6);
    return { pass, lines: [...summary, ...fixLines] };
  }

  function combineGates(...results) {
    const allPass = results.every(r => r.pass || r.planLimited);
    const anyPlanLimited = results.some(r => r.planLimited);
    return {
      pass: results.every(r => r.pass),
      planLimited: allPass && anyPlanLimited,
      lines: results.flatMap(r => r.lines),
    };
  }

  // Generic parser for subprocess gates: pass/fail from exit code, summary from keyword lines
  function parseGeneric(r, summaryRe) {
    if (r.status === null) return { pass: true, lines: ['⏭ script not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary = out.split('\n')
      .filter(l => summaryRe.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => /🚨|❌/.test(l) && l.trim()).map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  // ── Inline gate computations (no subprocess) ─────────────────────────────────
  function computeGate1() {
    const vars      = snapshotAge(SNAP_VARS);
    const struct    = snapshotAge(SNAP_STRUCT);
    const compProps = snapshotAge(SNAP_COMP_PROPS);
    const lines  = [];
    let warn     = false;

    // An invalid credential must never be excused as a plan limitation — that reads as
    // "nothing to do here" while every REST-backed refresh silently stops running.
    if (_figmaAuthFailed) {
      lines.push(C.red('❌ FIGMA_TOKEN rejected by Figma (invalid or expired)'));
      lines.push(C.red('   Every REST-backed snapshot refresh and Gate [14] icon freshness is'));
      lines.push(C.red('   skipped until it is reissued — stale data below is a consequence, not'));
      lines.push(C.red('   a plan limitation. Reissue at figma.com → Settings → Personal access'));
      lines.push(C.red('   tokens (needs file_content:read) and update .env / CI secrets.'));
      warn = true;
    }

    // ── Has the DS file changed since the snapshot was captured? (ADVISORY) ──────
    // Figma versions the WHOLE file: any edit anywhere — an unrelated component, a
    // comment, a moved frame — bumps the `version` id. So a file-version mismatch does
    // NOT mean the audited component changed, and it must not hard-fail the audit (that
    // was a false positive on any shared DS file). It is surfaced as an advisory: re-run
    // Phase 1 if the change touched what you are auditing. REAL drift is still a hard
    // fail below — the component inventory (added/removed components) and the value,
    // structure and icon gates, which compare the snapshot against the code directly.
    if (_figmaFileVersion) {
      let snapVersion = null;
      try { snapVersion = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'))._figmaVersion ?? null; } catch { /* handled below */ }
      if (!snapVersion) {
        lines.push(C.yellow('⚠️  vars snapshot has no _figmaVersion stamp — cannot tell whether the DS'));
        lines.push(C.yellow('    changed since it was captured. Re-run Phase 1 to record one.'));
      } else if (String(snapVersion) !== String(_figmaFileVersion)) {
        lines.push(C.yellow('⚠️  The Figma file changed since this snapshot was captured (advisory)'));
        lines.push(C.yellow(`   snapshot version ${snapVersion} → file is now ${_figmaFileVersion}`));
        if (_figmaFileModified) lines.push(C.yellow(`   last modified ${_figmaFileModified}`));
        lines.push(C.yellow('   Figma versions the whole file, so this is often an unrelated edit elsewhere.'));
        lines.push(C.yellow('   Re-run /rms-figma-code-parity (Phase 1) if the change touched audited components.'));
        lines.push(C.yellow('   Real drift is still caught below by the component inventory and the value gates.'));
        // Advisory only — does NOT fail the gate.
      } else {
        lines.push('DS file unchanged since capture ✓ (version matches)');
      }

      // Structure snapshot captured at a different file version — same reasoning: advisory,
      // not a hard fail. A genuine padding/gap/height rebind still surfaces in the structure
      // gate itself (which compares captured geometry to the CSS), not here.
      let structVersion = null;
      try { structVersion = JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8'))._figmaVersion ?? null; } catch { /* struct snapshot missing — flagged below */ }
      if (structVersion == null) {
        lines.push(C.yellow('⚠️  structure snapshot has no _figmaVersion stamp — a padding/gap/height'));
        lines.push(C.yellow('    rebind cannot be detected. Re-run Phase 1 Step 1c to record one.'));
      } else if (String(structVersion) !== String(_figmaFileVersion)) {
        lines.push(C.yellow('⚠️  Structure snapshot captured at an older file version (advisory)'));
        lines.push(C.yellow(`   structure version ${structVersion} → file is now ${_figmaFileVersion}`));
        lines.push(C.yellow('   Re-run Phase 1 Step 1c if a padding/gap/height rebind was part of the change.'));
        // Advisory only — does NOT fail the gate.
      }
    }

    // ── Component inventory: has the DS gained or lost a whole component? ─────────
    // A version bump says "something changed" but not what — and a new component whose
    // tokens the code hasn't seen is the change most likely to slip through, because a
    // token-value diff can't see a component the snapshot never listed. Diff the LIVE set
    // of DS component names against the structure snapshot's keys so an added/removed
    // component always surfaces by name. Genuinely-unused DS components go in
    // knownUnimplementedComponents (the same exemption Gate [18] uses).
    if (_liveComponentNames) {
      let snapComps = [];
      try { snapComps = Object.keys(JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8')).components ?? {}); } catch { /* struct snapshot missing — flagged elsewhere */ }
      const known = new Set(cfg.knownUnimplementedComponents ?? []);
      const snapSet = new Set(snapComps);
      let added   = [...(_liveComponentNames)].filter(n => !snapSet.has(n) && !known.has(n)).sort();
      let removed = snapComps.filter(n => !_liveComponentNames.has(n) && !known.has(n)).sort();
      // Scoped run: only inventory changes for the in-scope components matter here — the
      // rest is another component's concern. Collapse the out-of-scope ones to one line.
      if (_scopeForms?.length) {
        const inScope = (n) => { const nn = _norm(n); return _scopeForms.some(f => nn === f.nameNorm || nn.includes(f.nameNorm) || f.nameNorm.includes(nn)); };
        const out = added.filter(n => !inScope(n)).length + removed.filter(n => !inScope(n)).length;
        added = added.filter(inScope); removed = removed.filter(inScope);
        if (out) lines.push(C.dim(`component inventory: ${out} change(s) outside ${_scopeNames.join(', ')} — not audited in this scoped run`));
      }
      if (added.length) {
        lines.push(C.red(`❌ ${added.length} DS component(s) not in the structure snapshot: ${added.join(', ')}`));
        lines.push(C.red('   A new/unmodelled component is unaudited. Run Phase 1 Step 1c to capture it,'));
        lines.push(C.red('   or list a genuinely-unused one in ds-config.json → knownUnimplementedComponents.'));
        warn = true;
      }
      if (removed.length) {
        lines.push(C.red(`❌ ${removed.length} snapshot component(s) no longer in the DS: ${removed.join(', ')}`));
        lines.push(C.red('   Remove them from the snapshot/contract (or restore in Figma).'));
        warn = true;
      }
      if (!added.length && !removed.length) lines.push(`DS component inventory matches the snapshot ✓ (${_liveComponentNames.size} components)`);
    } else if (_figmaFileVersion) {
      lines.push(C.dim('component inventory not checked (component list not fetched)'));
    }

    let varsPlanLimited = false;
    if (vars === null) {
      lines.push(C.red(`${SNAP_VARS} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (vars > 24) {
      lines.push(C.yellow(`⚠️  ${SNAP_VARS} is ${vars}h old${_figmaApiLimited ? ' (Variables REST API not available on this plan)' : ''}`));
      if (_figmaApiLimited) { varsPlanLimited = true; } else { warn = true; }
    } else {
      lines.push(`${SNAP_VARS} ✓ (updated today)`);
    }

    let structPlanLimited = false;
    if (struct === null) {
      lines.push(C.red(`${SNAP_STRUCT} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (struct > 24) {
      if (_figmaApiLimited) {
        lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old — REST refresh not available on this plan; run the Phase 1 Step 1c Plugin API capture`));
        structPlanLimited = true;
      } else {
        lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old`));
        warn = true;
      }
    } else {
      lines.push(`${SNAP_STRUCT} ✓ (updated today)`);
    }

    // Empty-but-fresh guard: a snapshot with no entries makes its consuming gate a
    // silent no-op, which is worse than a stale one — stale data still gets checked.
    for (const [file, key, consumer] of [
      [SNAP_VARS, 'color', 'Gate [3] token parity'],
      [SNAP_STRUCT, 'components', 'Gate [10] component structure'],
      [SNAP_COMP_PROPS, null, 'Gate [10g] annotations + component properties'],
      ['bound-tokens.json', null, 'Gate [4] bound-token coverage'],
      ['component-state-tokens.json', null, 'Gate [11] state coverage'],
    ]) {
      if (!existsSync(join(ROOT, file))) continue;
      const n = snapshotEntryCount(file, key);
      if (n === 0) {
        lines.push(C.red(`${file} has 0 entries — ${consumer} is checking nothing. Re-run the Phase 1 capture that writes it.`));
        warn = true;
      }
    }

    // Walk snapshots consumed by Gates [4] (bound-check) and [11]/[6] (state-check,
    // exemption-check). Refreshed via REST when available, or via the Phase 1 Plugin API
    // walks otherwise — either path stamps _updated. Staleness is flagged HERE so the
    // consuming gates can always run at full strength against the committed data.
    let walksPlanLimited = false;
    for (const [file, phase] of [['bound-tokens.json', 'bound walk'], ['component-state-tokens.json', 'COMPONENT_SET state walk']]) {
      if (!existsSync(join(ROOT, file))) continue; // absence hard-fails in the consuming gate (exit 2)
      const age = snapshotAge(file);
      if (age === null) {
        lines.push(C.yellow(`⚠️  ${file} has no _updated stamp — re-run the Phase 1 ${phase} to start tracking freshness`));
        if (_figmaApiLimited) walksPlanLimited = true; else warn = true;
      } else if (age > 24) {
        if (_figmaApiLimited) {
          lines.push(C.yellow(`⚠️  ${file} is ${age}h old — REST refresh not available on this plan; run the Phase 1 ${phase} (Plugin API)`));
          walksPlanLimited = true;
        } else {
          lines.push(C.yellow(`⚠️  ${file} is ${age}h old`));
          warn = true;
        }
      } else {
        lines.push(`${file} ✓ (updated today)`);
      }
    }

    // Component-props snapshot drives Gate [3g] (component property parity).
    // Refreshed via REST on every run when FIGMA_TOKEN is set. Warn if stale.
    if (compProps === null) {
      lines.push(C.yellow(`⚠️  ${SNAP_COMP_PROPS} missing — Gate [3g] (component property parity) will be skipped`));
      warn = true;
    } else if (compProps > 24) {
      lines.push(C.yellow(`⚠️  ${SNAP_COMP_PROPS} is ${compProps}h old — Gate [3g] may miss new/renamed component properties`));
      warn = true;
    } else {
      lines.push(`${SNAP_COMP_PROPS} ✓ (updated today)`);
    }

    // Frame-geometry snapshot drives Gate [16] frameGeom sourcing. Refreshed via REST
    // /nodes (any plan). Warn if stale so container-spacing checks never run against
    // outdated frame boxes.
    if (SNAP_FRAME_GEOM) {
      const fg = snapshotAge(SNAP_FRAME_GEOM);
      if (fg === null) {
        lines.push(C.yellow(`⚠️  ${SNAP_FRAME_GEOM} missing or unstamped — Gate [16] frameGeom checks will skip`));
        warn = true;
      } else if (fg > 24) {
        lines.push(C.yellow(`⚠️  ${SNAP_FRAME_GEOM} is ${fg}h old — frameGeom checks may run against a stale frame`));
        warn = true;
      } else {
        lines.push(`${SNAP_FRAME_GEOM} ✓ (updated today)`);
      }
    }

    const anyPlanLimited = varsPlanLimited || structPlanLimited || walksPlanLimited;
    return { pass: !warn && !anyPlanLimited, planLimited: !warn && anyPlanLimited, lines };
  }

  function computeGate5() {
    const existing = THEMES.filter(p => existsSync(join(ROOT, p)));
    if (!existing.length) {
      return { pass: false, lines: [C.red(`token CSS not found at ${THEME_LABEL}`)] };
    }
    const themeText = readThemeCSS();
    const declared  = [...new Set(
      [...themeText.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)].map(m => '--' + m[1])
    )];
    const allSrc = allSourceFiles().map(f => {
      try { return readFileSync(f, 'utf8'); } catch { return ''; }
    }).join('\n');
    const unused = declared.filter(v => !KNOWN_UNUSED.has(v) && !allSrc.includes(`var(${v})`));

    // Undeclared vars: every fallback-less var(--x) used anywhere must be declared somewhere —
    // theme.css, a plugin <style> block, or JS setProperty. A var() referencing a renamed or
    // deleted variable silently resolves to nothing (e.g. a rename in theme.css orphans plugin
    // usages with no visual error). Usages WITH a fallback are self-documenting and skipped.
    const declaredAll = new Set([
      ...[...allSrc.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)].map(m => '--' + m[1]),
      ...[...allSrc.matchAll(/setProperty\(\s*['"](--[a-zA-Z][a-zA-Z0-9-]*)['"]/g)].map(m => m[1]),
    ]);
    const usedNoFallback = [...new Set(
      [...allSrc.matchAll(/var\(\s*(--[a-zA-Z][a-zA-Z0-9-]*)\s*\)/g)].map(m => m[1])
    )];
    const undeclared = usedNoFallback.filter(v => !declaredAll.has(v));

    // ── Dead CSS classes ──────────────────────────────────────────────────────
    // Unused VARIABLES were checked; unused RULES were not. A whole class can be a
    // stale copy of a DS component — styled, maintained, resized during refactors —
    // while nothing on screen has ever carried it. Found exactly that in a real
    // project only because someone asked "where does this render?".
    //
    // Method: a class is "used" if its name appears anywhere OUTSIDE a stylesheet.
    // Stripping the CSS from every file leaves markup, JS strings and template
    // literals — which is where a class legitimately gets applied. A definition that
    // never shows up there is styling nothing.
    //
    // Advisory by default: class names are routinely composed at runtime
    // ('tier-' + level), and a heuristic that blocks a build on a guess gets muted.
    // Set ds-config.json → deadCssStrict:true to enforce.
    const deadCssExempt = new Set(cfg.knownDeadCssExceptions ?? []);
    const defined = new Map();  // class -> first file it is defined in
    const usageParts = [];

    // USAGE is searched far more widely than the hardcoded-value scan. scanExcludeDirs
    // legitimately skips demo pages and drafts — full of literals nobody wants flagged —
    // but a class those pages apply is emphatically not dead. The contract file counts
    // too: a rendered assertion targeting a selector means deleting the rule breaks the
    // audit. Narrowing usage to the scan set produces confident false positives; on the
    // project this was built for it wrongly condemned classes used by a style guide.
    const usageOnlyFiles = [];
    (function walkAll(dir) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (/^(node_modules|\.git|dist|build|coverage)$/.test(e.name) || e.name.startsWith('.parity-')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walkAll(full);
        else if (/\.(html|js|mjs|cjs|jsx|ts|tsx|vue|svelte|json|md)$/.test(e.name)) usageOnlyFiles.push(full);
      }
    })(ROOT);

    for (const f of allSourceFiles()) {
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      const rel = relative(ROOT, f);
      // The stylesheet portion: a .css file entirely, or each <style> block in HTML.
      const cssChunks = /\.(css|scss)$/.test(f)
        ? [text]
        : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
      for (const chunk of cssChunks) {
        // Strip comments first: a class named in prose ("replaces the former .infoBadge")
        // is documentation, not a rule, and counting it as a definition reports it dead
        // forever. Only real selectors should register as defined.
        const noComments = chunk.replace(/\/\*[\s\S]*?\*\//g, ' ');
        // Selector position only: a class token that precedes a combinator, comma or
        // the opening brace of a rule. Avoids matching '.foo' inside a value or URL.
        for (const m of noComments.matchAll(/(^|[\s,>+~(])\.(-?[_a-zA-Z][\w-]*)(?=[\s,>+~){:.\[]|$)/gm)) {
          if (!defined.has(m[2])) defined.set(m[2], rel);
        }
      }
      // Everything that is not a stylesheet is potential usage.
      let rest = text;
      for (const chunk of cssChunks) rest = rest.replace(chunk, ' ');
      usageParts.push(rest);
    }
    // Second pass over the wider set, for files the scan set excludes.
    const alreadyScanned = new Set(allSourceFiles());
    for (const f of usageOnlyFiles) {
      if (alreadyScanned.has(f)) continue;
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      const cssChunks = /\.(css|scss)$/.test(f)
        ? [text]
        : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
      let rest = text;
      for (const chunk of cssChunks) rest = rest.replace(chunk, ' ');
      usageParts.push(rest);
    }
    const usageCorpus = usageParts.join('\n');
    // Class names composed at runtime legitimise the whole family. The prefix is
    // rarely a standalone literal — it is the tail of a longer string, as in
    //   '<div class="buttonList issue-item t-' + iss.type + '">'
    // so take the trailing name-ish fragment of any string spliced with + or ${…}.
    const dynamicPrefixes = [
      // '…prefix-' +   and   "…prefix-" +
      ...[...usageCorpus.matchAll(/['"]([^'"]*?)['"]\s*\+/g)].map(m => m[1]),
      // `…prefix-${expr}`
      ...[...usageCorpus.matchAll(/([^`$}]*)\$\{/g)].map(m => m[1]),
    ]
      .map(frag => frag.match(/([a-zA-Z][\w-]*-)$/)?.[1])
      .filter(Boolean);
    const deadClasses = [...defined.entries()]
      .filter(([c]) => !deadCssExempt.has(c))
      .filter(([c]) => !new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(usageCorpus))
      .filter(([c]) => !dynamicPrefixes.some(p => c.startsWith(p)))
      .map(([c, f]) => `.${c}  (${f})`);

    const deadStrict = cfg.deadCssStrict === true;
    const pass   = unused.length === 0 && undeclared.length === 0 && (!deadStrict || deadClasses.length === 0);
    const scanned = allSourceFiles().length;
    const lines = [];
    lines.push(unused.length === 0
      ? `✅ 0 unused vars  (scanned ${scanned} files; ${KNOWN_UNUSED.size} known-unused exempted)`
      : `❌ ${unused.length} unused (scanned ${scanned} files): ${unused.join(', ')}`);
    lines.push(undeclared.length === 0
      ? `✅ 0 undeclared vars  (every fallback-less var() resolves to a declaration)`
      : `❌ ${undeclared.length} undeclared var() usage(s) — renamed/deleted vars still referenced: ${undeclared.join(', ')}`);
    if (deadClasses.length === 0) {
      lines.push('✅ 0 dead CSS classes  (every rule matches something in the markup)');
    } else {
      lines.push((deadStrict ? C.red : C.yellow)(
        `${deadStrict ? '❌' : '⚠️ '} ${deadClasses.length} CSS class(es) defined but never applied:`));
      for (const d of deadClasses.slice(0, 15)) lines.push(C.dim(`     ${d}`));
      lines.push(...reportFull('dead-css-classes', deadClasses, 15));
      lines.push(C.dim('     Delete them, or add to ds-config.json → knownDeadCssExceptions.'));
    }
    return { pass, lines };
  }

  function computeGate6() {
    // Scan all source files for hardcoded literal values in CSS rules — property-agnostic.
    // Any numeric (px/rem/em/vh/vw/%) or hex value outside a :root/var declaration is a violation.
    // Use var() for every DS-token-backed value. Document intentional layout math
    // (100%, 50%, positioning zeros) in ds-config.json → knownHardcodedExceptions
    // as { file, pattern } objects or plain substring strings.
    // gate6ExcludeDirs allows scoping Gate [6] to DS package files only, excluding app consumers.
    const g6ExcludeDirs = new Set(cfg.gate6ExcludeDirs ?? []);
    // Test files legitimately contain literal values that are NOT CSS — hex-like strings in
    // assertions, colour codes in fixtures, regex patterns (e.g. /PANTONE#20485#20C/). They are
    // never UI source, so the hardcoded-value scan skips them; otherwise a test string reads as
    // a stray hardcoded colour. (This filter is scoped to the hardcoded scan, not var-usage.)
    const isTestFile = (rel) =>
      /(?:^|\/)(?:test|tests|__tests__|__mocks__|spec|e2e)\//.test(rel) ||
      /\.(?:test|spec)\.[jt]sx?$/.test(rel);
    const scanTargets = allSourceFiles().filter(f => {
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      if (isTestFile(rel)) return false;
      if (g6ExcludeDirs.size > 0 && rel.split('/').some(seg => g6ExcludeDirs.has(seg))) return false;
      return true;
    });
    const scanArgs    = ['-n', '-E'];

    // ── Block-comment resolution ───────────────────────────────────────────────
    // grep hands back `file:line:text`, which carries no comment state. Re-scan the
    // file once, tracking /* … */ across lines, and record which line numbers sit
    // inside a comment. Language-agnostic: /* … */ means the same in CSS, JS and
    // the <style>/<script> blocks of an HTML file, which is everything we scan.
    // String literals containing "/*" are not special-cased — a false "inside
    // comment" only ever suppresses a finding, and a hardcoded colour hidden in
    // such a string is caught by the quoted-hex rule below.
    const _commentLines = new Map();
    function insideBlockComment(hitLine) {
      const m = /^(.+?):(\d+):/.exec(hitLine);
      if (!m) return false;
      const file = m[1], lineNo = Number(m[2]);
      let marks = _commentLines.get(file);
      if (!marks) {
        marks = new Set();
        let src;
        try { src = readFileSync(file, 'utf8'); } catch { _commentLines.set(file, marks); return false; }
        // Track BOTH comment syntaxes: /* … */ (CSS/JS/<style>/<script>) and <!-- … -->
        // (HTML source files — ui.src.html etc.). A px/hex literal written inside an HTML
        // comment ("bare actionBar: 48px, padding/m") is prose, not a declaration, exactly
        // like the /* … */ case. A stray "<!--" inside a string can only ever SUPPRESS a
        // finding (never invent one), same safety argument as the /* rule.
        let openC = false, openH = false;
        src.split('\n').forEach((text, idx) => {
          let i = 0, sawCode = false; const startedOpen = openC || openH;
          while (i < text.length) {
            if (!openC && !openH && text.startsWith('/*', i))   { openC = true; i += 2; continue; }
            if (openC && text.startsWith('*/', i))              { openC = false; i += 2; continue; }
            if (!openC && !openH && text.startsWith('<!--', i)) { openH = true; i += 4; continue; }
            if (openH && text.startsWith('-->', i))             { openH = false; i += 3; continue; }
            if (!openC && !openH && text[i].trim()) sawCode = true;
            i += 1;
          }
          // Inside for the whole line, or a continuation that closes with no code after.
          if ((startedOpen || openC || openH) && !sawCode) marks.add(idx + 1);
        });
        _commentLines.set(file, marks);
      }
      return marks.has(lineNo);
    }

    // Shared legitimacy filter
    function isLegitimate(line) {
      // A literal written INSIDE a /* … */ block is prose, not a declaration. The
      // per-line strips below only see a comment that opens and closes on the same
      // line, so an interior line of a multi-line comment ("#ffffff light, #171717
      // dark") used to register as a hardcoded colour. Resolve the real comment
      // state from the file itself.
      if (insideBlockComment(line)) return true;
      const codePart = line.replace(/^[^:]+:\d+:\s*/, '');
      // CSS variable declarations (--name: value) — catches inline `:root { --var: #hex; }` too
      if (/--[a-zA-Z][\w-]*\s*:/.test(codePart)) return true;
      // Single-line JS/CSS comments
      if (/^\s*\/\//.test(codePart)) return true;
      // JSDoc / block-comment continuation lines (` * blah`)
      if (/^\s*\*/.test(codePart)) return true;
      const stripped = codePart.replace(/\/\*[^*]*\*\//g, '');
      // Value wrapped in quotes/backticks → JS/Vue string, not a real CSS rule
      if (/[`"'][^`"']*:\s*[^`"']*[`"']/.test(codePart)) return true;
      // Standalone quoted hex string (fallback `|| '#hex'` or canvas `fillStyle = "#hex"`)
      if (/[`"']#[0-9a-fA-F]{3,8}[`"']/.test(codePart)) return true;
      // HTML inline style attribute — value is in HTML, not a CSS rule
      if (/\bstyle\s*=\s*["'`{]/.test(codePart)) return true;
      // JS innerHTML / insertAdjacentHTML / template literal building HTML
      if (/innerHTML\s*[+=]|insertAdjacentHTML/.test(codePart)) return true;
      // Known exceptions from ds-config.json. Record which ones actually fire so the
      // list itself can be audited — an exemption nobody can see is how drift hides.
      const hitIdx = KNOWN_FS_EXCEPTS.findIndex(e => {
        if (typeof e === 'string') return line.includes(e);
        return (!e.file || line.includes(e.file)) &&
               (!e.pattern || new RegExp(e.pattern).test(stripped));
      });
      if (hitIdx !== -1) { _exceptHits.add(hitIdx); return true; }
      return false;
    }

    // Pass 1 — hex colors (any property, any file)
    const hexR    = sh('grep', [...scanArgs, '#[0-9a-fA-F]{3,8}\\b', ...scanTargets]);
    const hexHits = (hexR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || isLegitimate(l)) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '');
      return /#[0-9a-fA-F]{3,8}\b/.test(code);
    });

    // Pass 2 — numeric literals with units (all properties: padding, radius, height, gap, etc.)
    const numR    = sh('grep', [...scanArgs,
      ':\\s*-?[0-9]+(\\.[0-9]+)?(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\\b',
      ...scanTargets,
    ]);
    const numHits = (numR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || isLegitimate(l)) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '');
      return /:\s*-?[0-9]+(\.[0-9]+)?(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\b/.test(code);
    });

    // Pass 2b — a length literal that appears AFTER a var() in the same value. Pass 2
    // only anchors to the colon, so a magic literal buried mid-shorthand slips through
    // (e.g. `padding: var(--x) var(--x) 7px var(--x)` — the over-tall-divider bug). A
    // shorthand that mixes DS tokens with a raw literal is almost always a bug: the
    // literal should be a token too. Length units only (px/rem/em) — a `var(--x, 9px)`
    // fallback stays inside the parens and is not matched.
    const mixR    = sh('grep', [...scanArgs,
      ':[[:space:]]*[^;]*var\\([^;]*\\)[^;]*[0-9]+(\\.[0-9]+)?(px|rem|em)\\b',
      ...scanTargets,
    ]);
    const mixHits = (mixR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || isLegitimate(l)) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '');
      return /:\s*[^;]*var\([^;]*\)[^;]*\b[0-9]+(\.[0-9]+)?(px|rem|em)\b/.test(code);
    });

    // Pass 3 — layout anti-patterns across ALL files (gate6ExcludeDirs does NOT apply here).
    // These viewport-unit rules cause scrollbar clipping and must never appear in any file.
    const allFiles = allSourceFiles();
    const vwR = sh('grep', ['-n', '-E', ':\\s*100vw\\b|calc\\([^)]*100vw', ...allFiles]);
    const vwHits = (vwR.stdout || '').split('\n').filter(l => {
      if (!l.trim()) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '');
      // Allow inside comments or var declarations
      if (/--[a-zA-Z][\w-]*\s*:/.test(code)) return false;
      if (/^\s*(\/\/|\*)/.test(code)) return false;
      if (/[`"'][^`"']*:\s*[^`"']*[`"']/.test(code)) return false;
      if (/innerHTML\s*[+=]|insertAdjacentHTML/.test(code)) return false;
      if (markExceptHit(KNOWN_FS_EXCEPTS.findIndex(e => {
        if (typeof e === 'string') return l.includes(e);
        const stripped = code.replace(/\/\*[^*]*\*\//g, '');
        return (!e.file || l.includes(e.file)) && (!e.pattern || new RegExp(e.pattern).test(stripped));
      }))) return false;
      return true;
    });

    // Pass 4 — hand-drawn SVG icons via CSS background-image (gate6ExcludeDirs does NOT apply here).
    // A `data:image/svg+xml` background-image with a literal or %-encoded color is a hand-drawn
    // icon bypassing the DS icon sprite (`<use href="#icon-X">`) and its `currentColor`/var() token
    // binding entirely — invisible to gates [13]/[15] since it's not markup, just a CSS string.
    // Legitimate uses (e.g. native <select> arrows, which cannot host inline <svg><use> markup)
    // must be documented in ds-config.json → knownHardcodedExceptions.
    const svgUriR = sh('grep', ['-n', '-E', 'data:image/svg\\+xml', ...allFiles]);
    const svgUriHits = (svgUriR.stdout || '').split('\n').filter(l => {
      if (!l.trim()) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '');
      const hasHardcodedColor = /%23[0-9a-fA-F]{3,8}|#[0-9a-fA-F]{3,8}\b|stroke=(%27|')(?!currentColor)[^%27'#]+|fill=(%27|')(?!currentColor|none)[^%27'#]+/.test(code);
      if (!hasHardcodedColor) return false;
      if (markExceptHit(KNOWN_FS_EXCEPTS.findIndex(e => {
        if (typeof e === 'string') return l.includes(e);
        return (!e.file || l.includes(e.file)) && (!e.pattern || new RegExp(e.pattern).test(code));
      }))) return false;
      return true;
    });

    // Pass 5 — hardcoded box-shadow colors via rgba() (gate6ExcludeDirs does NOT apply).
    // A box-shadow with a literal rgba() bypasses DS effect styles / color tokens.
    // Document intentional shadows in ds-config.json → knownHardcodedExceptions.
    const shadowR    = sh('grep', ['-n', '-E', 'box-shadow\\s*:.*rgba\\s*\\(', ...allFiles]);
    const shadowHits = (shadowR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || insideBlockComment(l)) return false;
      const code    = l.replace(/^[^:]+:\d+:\s*/, '');
      const stripped = code.replace(/\/\*[^*]*\*\//g, '');
      if (/--[a-zA-Z][\w-]*\s*:/.test(code)) return false;
      if (/^\s*(\/\/|\*)/.test(code)) return false;
      if (/[`"'][^`"']*:\s*[^`"']*[`"']/.test(code)) return false;
      if (/innerHTML\s*[+=]|insertAdjacentHTML/.test(code)) return false;
      if (markExceptHit(KNOWN_FS_EXCEPTS.findIndex(e => {
        if (typeof e === 'string') return l.includes(e);
        return (!e.file || l.includes(e.file)) && (!e.pattern || new RegExp(e.pattern).test(stripped));
      }))) return false;
      return true;
    });

    const hits = [...new Set([...hexHits, ...numHits, ...mixHits, ...vwHits, ...svgUriHits, ...shadowHits])];

    // ── Parity-aware suppression (per-component) ───────────────────────────────
    // This is a PARITY skill, not a style linter: it does not exist to push var()
    // over literals. A hardcoded value is only a divergence when it CONTRADICTS the
    // Figma side. If Figma uses the same value ON THAT COMPONENT, code that hardcodes
    // that value has 100% parity — not an error, whether or not a token backs it.
    //
    // Scoping is PER COMPONENT, not global: component-values.snapshot.json holds, for
    // each component, every raw geometry number and colour swept from ALL its nodes
    // (all variants, all descendants, hidden included). A file's literals are checked
    // against the component that file belongs to — attributed agnostically by which
    // component's base selector the file contains (so Primary.vue, which carries
    // `.buttonPrimary`, is scoped to ButtonPrimary's swept values). So `.icon{width:24px}`
    // passes only because ButtonPrimary's own icon node is 24px in Figma — a stray 24px
    // that belongs to some OTHER component no longer excuses it.
    //
    // FALLBACK: when component-values.snapshot.json is absent, or a file matches no
    // component, we fall back to the global set (resolved token colours across every
    // mode + all sizing/typography numerics + captured structural geometry). This keeps
    // projects that have not captured the per-component sweep working, just coarser.
    // `100vw` is never suppressed — a scrollbar-clipping rendering bug, not a value.
    const normHex = (raw) => {
      const m = /#?([0-9a-fA-F]{3,8})\b/.exec(String(raw).trim());
      if (!m) return null;
      let h = m[1].toLowerCase();
      if (h.length === 3) h = h.split('').map(c => c + c).join('');   // #abc → #aabbcc
      if (h.length === 4) h = h.split('').map(c => c + c).join('');   // #abcd → #aabbccdd
      return h.slice(0, 6);                                            // compare RGB, ignore alpha
    };
    const addNumTo = (set, raw) => {
      const s = String(raw).trim();
      if (!/^-?\d/.test(s)) return;
      const n = parseFloat(s);
      if (Number.isFinite(n)) set.add(n);
    };
    // Global fallback sets.
    const figmaNums   = new Set([0]);   // 0 is dimensionless — parity everywhere
    const figmaColors = new Set();
    try {
      const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
      for (const raw of Object.values(snap.sizing ?? {})) addNumTo(figmaNums, raw);
      for (const scale of Object.values(snap.typography ?? {})) for (const raw of Object.values(scale ?? {})) addNumTo(figmaNums, raw);
      for (const modeMap of Object.values(snap.color ?? {})) for (const hex of Object.values(modeMap ?? {})) { const h = normHex(hex); if (h) figmaColors.add(h); }
    } catch { /* no vars snapshot — global set stays minimal */ }
    try {
      const struct = JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8'));
      const walkNums = (o) => {
        if (o == null) return;
        if (typeof o === 'number') { figmaNums.add(o); return; }
        if (typeof o === 'string') { addNumTo(figmaNums, o); return; }
        if (typeof o === 'object') for (const v of Object.values(o)) walkNums(v);
      };
      walkNums(struct.components ?? struct);
    } catch { /* no structure snapshot — skip geometry values */ }

    // Per-component sweep sets (preferred when present).
    let compValues = null;   // { CompName: { nums:Set<number>, colors:Set<string> } }
    try {
      const raw = JSON.parse(readFileSync(join(ROOT, 'component-values.snapshot.json'), 'utf8'));
      compValues = {};
      for (const [name, v] of Object.entries(raw)) {
        if (name.startsWith('_') || !v || typeof v !== 'object') continue;
        const nums = new Set([0]); for (const n of v.nums ?? []) addNumTo(nums, n);
        const colors = new Set();  for (const c of v.colors ?? []) { const h = normHex(c); if (h) colors.add(h); }
        compValues[name] = { nums, colors };
      }
      if (!Object.keys(compValues).length) compValues = null;
    } catch { /* no per-component snapshot — use global fallback */ }

    // Attribute a file to component(s) by which component base selector it contains.
    // Agnostic: base selector comes from cfg.componentSelectors or the DS naming
    // convention (lowercase first letter), then both sides are normalised (strip the
    // leading . / #, drop non-alphanumerics, lowercase) so `.button-primary` in a Vue
    // <style> matches the convention's `.buttonPrimary`.
    const componentSelectors = cfg.componentSelectors ?? {};
    const baseSelectorNorm = (name) => {
      const sel = componentSelectors[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1));
      return sel.replace(/^[.#]/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    };
    const _fileNorm = new Map();
    const fileNormText = (file) => {
      if (_fileNorm.has(file)) return _fileNorm.get(file);
      let t = '';
      try { t = readFileSync(file, 'utf8').toLowerCase().replace(/[^a-z0-9]/g, ''); } catch { /* unreadable */ }
      _fileNorm.set(file, t);
      return t;
    };
    const _fileComps = new Map();
    const componentsForFile = (file) => {
      if (!compValues || !file) return [];
      if (_fileComps.has(file)) return _fileComps.get(file);
      const norm = fileNormText(file);
      const matched = [];
      for (const name of Object.keys(compValues)) {
        const bs = baseSelectorNorm(name);
        if (bs.length >= 4 && norm.includes(bs)) matched.push(name);
      }
      _fileComps.set(file, matched);
      return matched;
    };
    // Resolve the value sets a hit is checked against: the union of its file's
    // component sweeps when attributable, else the global fallback.
    const scopedSets = (hitLine) => {
      const file = /^([^:]+):\d+:/.exec(hitLine)?.[1];
      const comps = componentsForFile(file);
      if (comps.length) {
        const nums = new Set([0]), colors = new Set();
        for (const c of comps) { for (const n of compValues[c].nums) nums.add(n); for (const h of compValues[c].colors) colors.add(h); }
        return { nums, colors, scope: comps.join('+') };
      }
      return { nums: figmaNums, colors: figmaColors, scope: compValues ? 'global (file unmapped)' : 'global' };
    };

    const matchesFigmaValue = (lit, nums, colors) => {
      const hx = /#[0-9a-fA-F]{3,8}\b/.exec(lit);
      if (hx) { const h = normHex(hx[0]); return h != null && colors.has(h); }
      const nm = /^(-?\d+(?:\.\d+)?)(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)?$/.exec(lit.trim());
      if (!nm) return false;
      const n = parseFloat(nm[1]); const unit = nm[2] || 'px';
      if (unit === 'px') return nums.has(n);
      if (unit === 'rem' || unit === 'em') return nums.has(n * 16) || nums.has(n);
      return false;   // %, vh, vw, … are layout, not Figma token values
    };
    // Every literal in a hit must have a Figma counterpart (in that component's scope).
    const hitMatchesFigma = (hitLine) => {
      const code = hitLine.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '')
        .replace(/var\([^)]*\)/g, '');   // ignore values inside var(--x, fallback) — self-documenting
      const literals = [];
      for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) literals.push(m[0]);
      for (const m of code.matchAll(/(?<![\w.-])(-?\d+(?:\.\d+)?)(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\b/g)) literals.push(m[1] + m[2]);
      if (!literals.length) return false;   // nothing comparable (e.g. rgba() shadow) → keep as-is
      const { nums, colors } = scopedSets(hitLine);
      return literals.every(l => matchesFigmaValue(l, nums, colors));
    };
    const _alwaysKeep = new Set(vwHits);   // 100vw anti-pattern is a rendering bug, never value-parity
    const divergent = [], matchedFigma = [];
    for (const h of hits) {
      if (!_alwaysKeep.has(h) && hitMatchesFigma(h)) matchedFigma.push(h);
      else divergent.push(h);
    }

    // ── Audit the exception list itself ──────────────────────────────────────
    // Every other exemption list in this engine is validated; this one was only ever
    // read. Two ways it rots, both of which hide real drift indefinitely:
    //
    //   STALE — the code it excused is gone, so the entry now silently pre-approves
    //           whatever similar value appears next.
    //   BROAD — a bare substring like "gap: 6px" exempts that value in EVERY file,
    //           including the design-system base. Scoping it to a file or anchoring
    //           the pattern keeps the exemption to the case a human actually reviewed.
    const exceptNotes = [];
    const stale = KNOWN_FS_EXCEPTS
      .map((e, i) => [e, i])
      .filter(([, i]) => !_exceptHits.has(i))
      .map(([e]) => (typeof e === 'string' ? e : (e.pattern ?? e.file ?? JSON.stringify(e))));
    // A bare string with no file scope and no anchor matches anywhere in the repo.
    const broad = KNOWN_FS_EXCEPTS.filter(e => typeof e === 'string' && /^[a-z-]+\s*:/.test(e));

    if (stale.length) {
      exceptNotes.push(C.yellow(`⚠️  ${stale.length} unused exception(s) in knownHardcodedExceptions — the code they excused is gone:`));
      for (const e of stale.slice(0, 20)) exceptNotes.push(C.dim(`     ${e}`));
      exceptNotes.push(...reportFull('stale-exceptions', stale, 20));
      exceptNotes.push(C.dim('     Remove them, or they pre-approve the next value that looks like this.'));
    }
    if (broad.length) {
      exceptNotes.push(C.yellow(`⚠️  ${broad.length} exception(s) apply repo-wide (bare substring, no file scope):`));
      for (const e of broad.slice(0, 8)) exceptNotes.push(C.dim(`     "${e}"`));
      exceptNotes.push(...reportFull('broad-exceptions', broad, 8));
      exceptNotes.push(C.dim('     Prefer { file, pattern } so the exemption covers only the reviewed case.'));
    }

    // ── Suggest the nearest DS step for each off-scale spacing literal ───────
    // The gate already knows the literal and the DS scale; making the reader look up
    // every number by hand turns a mechanical fix into an investigation. Suggest only —
    // spacing is a design decision, and "nearest" is not always "right".
    let dsSteps = [];
    try {
      const snapSizing = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8')).sizing ?? {};
      const byValue = new Map();
      for (const [name, raw] of Object.entries(snapSizing)) {
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n === 0) continue;
        if (!byValue.has(n)) byValue.set(n, []);
        byValue.get(n).push(name);
      }
      dsSteps = [...byValue.entries()].sort((a, b) => a[0] - b[0]);
    } catch { /* no snapshot — skip suggestions entirely */ }

    const SPACING_PROP = /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|inset|border-radius)[a-z-]*\s*:/i;
    // Only offer tokens from the SCALE families. A component dimension that happens to
    // be 6px is not a spacing step, and suggesting it invites a padding bound to an
    // unrelated component's height. Families are matched by token-name prefix, so a DS
    // that names them differently simply gets no suggestion rather than a wrong one.
    const FAMILY = { radius: /^radii\//i, space: /^(gap|padding)\//i };
    function stepsFor(isRadius) {
      const re = isRadius ? FAMILY.radius : FAMILY.space;
      return dsSteps
        .map(([v, names]) => [v, names.filter(n => re.test(n))])
        .filter(([, names]) => names.length);
    }
    function suggest(line) {
      if (!dsSteps.length || !SPACING_PROP.test(line)) return null;
      // Per DECLARATION, not per line: a single-line rule can hold both a padding and
      // a border-radius, and choosing one family for the whole line offers radius
      // steps for the padding — a confidently wrong answer.
      const parts = [];
      const seen = new Set();
      for (const m of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
        const prop = m[1].toLowerCase(), value = m[2];
        if (!/^(padding|margin|gap|row-gap|column-gap|inset|border-radius)/.test(prop)) continue;
        const steps = stepsFor(prop === 'border-radius');
        if (!steps.length) continue;
        for (const nm of value.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g)) {
          const n = parseFloat(nm[1]);
          if (n === 0 || steps.some(([v]) => v === n)) continue;
          const key = prop + n;
          if (seen.has(key)) continue;
          seen.add(key);
          const below = [...steps].reverse().find(([v]) => v < n);
          const above = steps.find(([v]) => v > n);
          // Name the token from the matching family where one exists: suggesting
          // gap/s for a padding is technically the right number under the wrong name.
          const famRe = prop.startsWith('padding') ? /^padding\//i
                      : prop.startsWith('gap') || prop.endsWith('gap') ? /^gap\//i
                      : null;
          const pick = names => (famRe && names.find(x => famRe.test(x))) || names[0];
          const opts = [below, above].filter(Boolean).map(([v, names]) => `${v}px (${pick(names)})`);
          if (opts.length) parts.push(`${prop} ${n}px → ${opts.join(' or ')}`);
        }
      }
      return parts.length ? C.dim(`       ↳ ${parts.join(';  ')}`) : null;
    }

    const hitLines = [];
    for (const h of divergent.slice(0, 20)) {
      hitLines.push('  ' + h);
      const s2 = suggest(h);
      if (s2) hitLines.push(s2);
    }

    // Literals that match a Figma value are parity, not failures — report them as info
    // so they stay visible (and auditable) without turning the gate red.
    const matchNotes = [];
    if (matchedFigma.length) {
      const mode = compValues ? 'per-component sweep' : 'global snapshot values';
      matchNotes.push(C.dim(`ℹ️  ${matchedFigma.length} hardcoded literal(s) match the Figma value — parity OK, not failed (${mode}):`));
      for (const h of matchedFigma.slice(0, 20)) matchNotes.push(C.dim(`     [${scopedSets(h).scope}] ${h}`));
      matchNotes.push(...reportFull('hardcoded-matches-figma', matchedFigma, 20));
    }

    const pass  = divergent.length === 0;
    return {
      pass,
      lines: [
        ...(pass ? ['✅ Clean — no literal diverges from Figma'] : [`❌ ${divergent.length} literal(s) with no matching Figma value:`, ...hitLines, ...reportFull('hardcoded-values', divergent, 20)]),
        ...matchNotes,
        ...exceptNotes,
      ],
    };
  }

  function computeGate7() {
    if (!PLUGINS.length) {
      return { pass: true, lines: ['⏭ No plugins configured in ds-config.json — skipped'] };
    }
    if (process.env.CI) {
      return { pass: true, lines: ['⏭ Build freshness skipped on CI (mtime unreliable after fresh clone)'] };
    }
    const stale      = [];
    // Use the most recently modified token file as the freshness reference
    const themeMtime = THEMES.filter(p => existsSync(join(ROOT, p)))
      .map(p => statSync(join(ROOT, p)).mtime)
      .sort((a, b) => b - a)[0] ?? null;
    for (const p of PLUGINS) {
      const src = join(ROOT, `apps/${p}/ui.src.html`);
      const out = join(ROOT, `apps/${p}/ui.html`);
      if (!existsSync(src) || !existsSync(out)) continue;
      if (statSync(src).mtime > statSync(out).mtime) stale.push(p);
      else if (themeMtime && themeMtime > statSync(out).mtime && !stale.includes(p))
        stale.push(`${p} (theme newer)`);
    }
    const pass = stale.length === 0;
    return {
      pass,
      lines: pass
        ? ['✅ All outputs current']
        : [`❌ Stale — rebuild: ${stale.join(', ')}`],
    };
  }

  // ── Refresh Figma snapshots (requires FIGMA_TOKEN) ───────────────────────────
  const figmaToken   = process.env.FIGMA_TOKEN;
  const figmaFileKey = cfg.figmaFileKey;
  if (figmaToken && figmaFileKey) {
    // These refreshers write independent files and only share the memoized buildVarIdMap
    // fetch — run them concurrently instead of serially (they were ~7s of a 12s audit).
    await Promise.all([
      fetchFigmaFileVersion(figmaFileKey, figmaToken),
      fetchComponentInventory(figmaFileKey, figmaToken, cfg.figma?.componentsPage ?? cfg.componentsPage),
      refreshComponentProps(figmaFileKey, figmaToken, join(ROOT, SNAP_COMP_PROPS)),
      refreshBoundTokens(figmaFileKey, cfg.frames ?? [], figmaToken, join(ROOT, 'bound-tokens.json')),
      refreshStateTokens(figmaFileKey, figmaToken, join(ROOT, 'component-state-tokens.json')),
      refreshStateBindings(figmaFileKey, figmaToken, join(ROOT, 'component-state-bindings.json')),
      refreshComponentValues(figmaFileKey, figmaToken, join(ROOT, 'component-values.snapshot.json')),
      SNAP_FRAME_GEOM ? refreshFrameGeometry(figmaFileKey, cfg.frames ?? [], figmaToken, join(ROOT, SNAP_FRAME_GEOM)) : Promise.resolve(),
    ]);
  }

  // ── Run gates ─────────────────────────────────────────────────────────────────
  const gates  = [];
  let anyFail  = false;

  // ── Component scope (from --component) ────────────────────────────────────────
  // Merge CLI names with an optional ds-config default, then build matchers: the
  // normalised component name (strips non-alphanumerics, lowercase) and its base
  // selector (so `.button-primary` in a Vue <style> matches `ButtonPrimary`).
  const _norm  = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const _selOf = (name) => cfg.componentSelectors?.[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1));
  const _chosenNames = [...new Set([...SCOPE_COMPONENTS, ...(cfg.scopeComponents ?? []), ...(cfg.scopeComponent ? [cfg.scopeComponent] : [])])];

  // A component contains other DS components (a button may hold an icon, a card a badge),
  // and those must be verified too — auditing the parent without its children is a false
  // pass. So expand the chosen set transitively: pull in every DS component whose base
  // selector co-occurs, in a per-component source file, with a component already in scope.
  // Aggregate files (the central theme CSS, or any file mentioning many components) are
  // skipped so scope cannot explode to the whole DS through a shared stylesheet.
  const _autoAdded = [];
  const _scopeNames = [..._chosenNames];
  if (_chosenNames.length) {
    let universe = [];
    try { universe.push(...Object.keys(JSON.parse(readFileSync(join(ROOT, SNAP_STRUCT), 'utf8')).components ?? {})); } catch { /* no struct snapshot */ }
    universe.push(...Object.keys(cfg.componentSelectors ?? {}));
    if (_liveComponentNames) universe.push(..._liveComponentNames);
    universe = [...new Set(universe)];
    const uForms = universe.map(n => ({ name: n, nameNorm: _norm(n), selNorm: _norm(_selOf(n)) }));
    const mentions = (form, t) => (form.nameNorm && t.includes(form.nameNorm)) || (form.selNorm.length >= 4 && t.includes(form.selNorm));
    const themeSet = new Set([cfg.paths?.themeCSS].flat().filter(Boolean).map(p => join(ROOT, p)));
    const maxNest  = cfg.scopeMaxNestPerFile ?? 8;
    // Precompute, per per-component source file, which universe components it mentions.
    const fileComps = [];
    for (const f of allSourceFiles()) {
      if (themeSet.has(f)) continue;                       // central token file → not component-specific
      let t = ''; try { t = readFileSync(f, 'utf8').toLowerCase().replace(/[^a-z0-9]/g, ''); } catch { continue; }
      const comps = uForms.filter(fm => mentions(fm, t)).map(fm => fm.name);
      if (comps.length && comps.length <= maxNest) fileComps.push(comps);   // skip aggregates
    }
    const inScope = new Set(_chosenNames);
    for (let changed = true; changed; ) {
      changed = false;
      for (const comps of fileComps) {
        if (comps.some(c => inScope.has(c))) {
          for (const c of comps) if (!inScope.has(c)) { inScope.add(c); _autoAdded.push(c); changed = true; }
        }
      }
    }
    _scopeNames.length = 0; _scopeNames.push(...inScope);
  }
  const _scopeForms = _scopeNames.map(name => ({
    name,
    nameNorm: _norm(name),
    selNorm:  _norm(_selOf(name)),
  }));
  const _fileScopeCache = new Map();
  function _fileHasScope(file) {
    if (_fileScopeCache.has(file)) return _fileScopeCache.get(file);
    let t = '';
    try { t = readFileSync(file, 'utf8').toLowerCase().replace(/[^a-z0-9]/g, ''); } catch { /* unreadable */ }
    const has = _scopeForms.some(f => (f.nameNorm && t.includes(f.nameNorm)) || (f.selNorm.length >= 4 && t.includes(f.selNorm)));
    _fileScopeCache.set(file, has);
    return has;
  }
  const _ANSI    = /\x1b\[[0-9;]*m/g;
  const _FILE_RE = /([\w./-]+\.(?:vue|css|scss|less|ts|tsx|js|jsx|html))(?::\d+)?/i;
  function _lineInScope(plain) {
    const n = _norm(plain);
    if (_scopeForms.some(f => (f.nameNorm && n.includes(f.nameNorm)) || (f.selNorm.length >= 4 && n.includes(f.selNorm)))) return true;
    const fm = _FILE_RE.exec(plain);
    if (fm) { const f = fm[1]; if (_fileHasScope(join(ROOT, f)) || _fileHasScope(f)) return true; }
    return false;
  }
  // Filter one gate's output to the chosen components. Per-item findings are INDENTED
  // (every gate formats sub-items that way); flush-left lines are headers/counts/prose
  // and are always kept. Drop indented items that belong to another component, and flip
  // a gate to pass only when we actually removed out-of-scope items and none of the
  // in-scope items still fail — so a real in-scope failure or a header-only failure stays red.
  function scopeFilter(result) {
    if (!_scopeForms.length) return result;
    const kept = [], dropped = [];
    let keptItemFail = false;
    for (const line of result.lines || []) {
      const plain  = String(line).replace(_ANSI, '');
      const isItem = /^\s+\S/.test(plain);
      if (isItem && !_lineInScope(plain)) { dropped.push(line); continue; }
      kept.push(line);
      if (isItem && /🚨|❌/.test(plain)) keptItemFail = true;
    }
    const lines = [...kept];
    if (dropped.length) lines.push(C.dim(`   … ${dropped.length} finding(s) outside ${_scopeNames.join(', ')} — not audited in this scoped run`));
    let pass = result.pass;
    if (!result.pass && !result.planLimited && !keptItemFail && dropped.length > 0) {
      pass = true;
      lines.push(C.dim(`   ↳ all failing items were outside ${_scopeNames.join(', ')}; gate passes for this scoped run`));
    }
    return { ...result, pass, lines };
  }

  function addGate(label, result) {
    const r = scopeFilter(result);
    // planLimited gates are neutral — they don't block the audit
    if (!r.pass && !r.planLimited) anyFail = true;
    gates.push({ label, ...r });
  }

  // Inline gates — compute upfront so they can be combined
  const _g1 = computeGate1();
  const _g5 = computeGate5();
  const _g6 = computeGate6();
  const _g7 = computeGate7();

  // Subprocess gates — all launch concurrently
  const [rParity, rStructure, rBound, rIsolation, rVisual, rState, rExemption, rMode, rNaming, rPseudo, rIcon, rStateBinding, rStateVar, rIconSlot, rComponentSlot, rFormControl, rHtmlStructure, rTransition, rIconFreshness, rRendered, rCoverage, rMotion, rEffect, rContainment] = await Promise.all([
    runScriptAsync('parity-check.mjs', ['--json']),
    runScriptAsync('structure-check.mjs'),
    runScriptAsync('bound-check.mjs'),
    runScriptAsync('subcomponent-isolation-check.mjs'),
    runScriptAsync('visual-regression-check.mjs'),
    runScriptAsync('state-check.mjs'),
    runScriptAsync('exemption-check.mjs'),
    runScriptAsync('mode-completeness-check.mjs'),
    runScriptAsync('naming-check.mjs'),
    runScriptAsync('pseudo-element-check.mjs'),
    runScriptAsync('icon-check.mjs'),
    runScriptAsync('state-binding-check.mjs'),
    runScriptAsync('component-selector-check.mjs'),
    runScriptAsync('icon-slot-check.mjs'),
    runScriptAsync('component-slot-check.mjs'),
    runScriptAsync('form-control-check.mjs'),
    runScriptAsync('html-structure-check.mjs'),
    runScriptAsync('transition-check.mjs'),
    runScriptAsync('icon-freshness-check.mjs'),
    runScriptAsync('rendered-check.mjs'),
    runScriptAsync('coverage-check.mjs'),
    runScriptAsync('motion-check.mjs'),
    runScriptAsync('effect-check.mjs'),
    runScriptAsync('container-containment-check.mjs'),
  ]);

  // ── Freshness ─────────────────────────────────────────────────────────────────
  addGate('Data is up to date  (Figma snapshots & build output are current)',
    combineGates(_g1, _g7));
  addGate('Figma frame unchanged  (live frame vs saved reference screenshot)',
    parseGate9(rVisual));

  // ── Token integrity ───────────────────────────────────────────────────────────
  addGate('Token values  (color · sizing · typography · breakpoints · text · animation)',
    parseGate2(rParity));
  addGate('Tokens used in screens exist in CSS  (every token bound in a DS screen has a CSS variable)',
    parseGate4(rBound));
  addGate('Every mode is covered  (tokens adapt across light/dark and all configured modes)',
    parseGeneric(rMode, /ADAPTS|STATIC|SKIPPED/));
  addGate('Exception lists are valid  (no stale or overly broad entries)',
    parseGeneric(rExemption, /VALID|STALE|BROKEN/));
  addGate('No invented CSS variables  (every CSS variable traces back to a Figma token)',
    parseGeneric(rNaming, /TRACEABLE|UNINVENTED|UNDOCUMENTED/));

  // ── CSS quality ───────────────────────────────────────────────────────────────
  addGate('Clean CSS  (no unused variables · no values that contradict Figma · safe containment)',
    combineGates(_g5, _g6, parseGeneric(rContainment, /✅|❌/)));
  addGate('Nested components keep their own styles  (no parent rule overrides a child component)',
    parseGate8(rIsolation));

  // ── Structure ─────────────────────────────────────────────────────────────────
  addGate('Structure  (height · spacing · base-rule variable bindings)',
    parseGate3(rStructure));
  addGate('All states are built  (each state implemented · correct selector · variable in the right rule)',
    combineGates(parseGeneric(rState, /COVERED|UNCOVERED|⚠️|⏭ HIDDEN/), parseGeneric(rStateBinding, /COVERED|MISSING/), parseGeneric(rStateVar, /CORRECT|MISMATCH/)));

  // ── Markup ────────────────────────────────────────────────────────────────────
  addGate('Markup  (ids · component classes · icon references)',
    parseGeneric(rHtmlStructure, /✅|❌/));
  addGate('Required pieces are in place  (icon slots · component slots · form controls)',
    combineGates(parseGeneric(rIconSlot, /✅|❌/), parseGeneric(rComponentSlot, /✅|❌/), parseGeneric(rFormControl, /✅|❌/)));
  addGate('Icons  (symbol markup · path data · live Figma check)',
    combineGates(parseGeneric(rPseudo, /DOCUMENTED|UNDOCUMENTED/), parseGeneric(rIcon, /DOCUMENTED|UNDOCUMENTED/), parseGeneric(rIconFreshness, /MATCH|CHANGED/)));

  // ── Animation ─────────────────────────────────────────────────────────────────
  addGate('Transitions  (duration · easing · property per DS selector)',
    parseGeneric(rTransition, /✅|❌/));

  // ── Rendered output ───────────────────────────────────────────────────────────
  addGate('Renders correctly in a browser  (real computed styles vs the DS spec)',
    parseGeneric(rRendered, /✅|❌|⏭/));
  addGate('What this audit actually checked  (which DS components & states are covered)',
    parseGeneric(rCoverage, /MODELLED|UNCHECKED|NO RENDERED|SINGLE-VARIANT/));

  // ── Motion & effects (opt-in — no-op unless configured) ─────────────────────────
  addGate('Motion  (easing & duration variables → CSS)',
    parseGeneric(rMotion, /MATCH|MISMATCH|SKIPPED|⏭/));
  addGate('Shadows  (Figma effect styles → CSS box-shadow)',
    parseGeneric(rEffect, /MATCH|MISMATCH|SKIPPED|⏭/));

  // ── Final report ──────────────────────────────────────────────────────────────
  console.log('\n' + C.bold('─'.repeat(WIDTH)));
  console.log(C.bold(`  PARITY AUDIT  ·  ${today}`));
  if (_scopeNames.length) {
    console.log(C.bold(C.yellow(`  SCOPED TO: ${_chosenNames.join(', ')}`)));
    if (_autoAdded.length) console.log(C.dim(`  + nested components pulled in: ${[...new Set(_autoAdded)].join(', ')}`));
    console.log(C.dim('  Findings outside these components are hidden and do not fail the run.'));
  }
  console.log(C.bold('─'.repeat(WIDTH)) + '\n');

  const planLimitedGates = [];
  gates.forEach((g, i) => {
    let icon;
    if (g.planLimited) { icon = C.yellow('⏭ '); planLimitedGates.push(i + 1); }
    else icon = g.pass ? C.green('✅') : C.red('❌');
    console.log(`${icon}  [${i + 1}] ${C.bold(g.label)}`);
    for (const line of g.lines || []) console.log(`       ${line}`);
    console.log();
  });

  // ── Summary table ─────────────────────────────────────────────────────────────
  const GATE_PLAIN = [
    // Up to date
    'Figma snapshots and build outputs are current',
    'Live Figma frame is unchanged vs its saved reference screenshot',
    // Token integrity
    'Token values agree (color · sizing · typography · breakpoints · text · animation)',
    'Every DS token bound in a screen has a CSS variable',
    'Every token that changes between modes is handled in CSS',
    'All documented exceptions are still valid',
    'Every CSS variable maps back to a real Figma token',
    // Clean CSS
    'No unused CSS variables, no values that contradict Figma, safe containment',
    'Child components are not overridden by parent CSS rules',
    // Structure
    'Component structure agrees (height, spacing, base-rule var bindings)',
    'All component states are built, wired, and in the right selector',
    // Markup
    'HTML structure (ids, component classes, icon refs) agrees with the snapshot',
    'Every declared slot uses the correct DS icon and component class',
    'All DS icon symbols are documented, paths verified, and current from Figma',
    // Animation
    'All CSS transitions use the documented duration, easing and property',
    // Rendered
    'Rendered computed styles agree with the DS spec (headless Chrome)',
    // Audit self-check
    'Coverage — which DS components/states the audit actually checks',
    // Motion & effects (opt-in)
    'Motion tokens (easing · duration) agree — when configured',
    'Effect/shadow styles agree with CSS box-shadow — when configured',
  ];
  const GATE_PLAN_RISK = {
    1: 'Risk: gates consuming a stale snapshot pass against outdated data — DS changes made after its _updated stamp are invisible. Fix: run /rms-figma-code-parity — the Phase 1 Plugin API captures refresh every snapshot on any plan; commit the refreshed files and this gate goes fully green.',
  };
  const COL1 = 6, COL2 = 52;
  const tRow = (num, label, result) => {
    const icon = result === 'plan' ? C.yellow('⏭') : result ? C.green('✅') : C.red('❌');
    const status = result === 'plan' ? C.yellow('Skipped') : result ? C.green('Pass') : C.red('Fail');
    const n = `[${num}]`.padEnd(COL1);
    const l = label.length > COL2 ? label.slice(0, COL2 - 1) + '…' : label.padEnd(COL2);
    return `  ${icon}  ${n}${l}${status}`;
  };
  console.log(C.bold('─'.repeat(WIDTH)));
  console.log(C.bold('  GATE SUMMARY'));
  console.log(C.bold('─'.repeat(WIDTH)));
  gates.forEach((g, i) => {
    const result = g.planLimited ? 'plan' : g.pass;
    const plainLabel = GATE_PLAIN[i] ?? g.label;
    console.log(tRow(i + 1, plainLabel, result));
    if (g.planLimited) {
      console.log(C.yellow(`         Plan detected: non-Enterprise (Figma Variables REST API not available)`));
      const risk = GATE_PLAN_RISK[i + 1];
      if (risk) console.log(C.yellow(`         ${risk}`));
    }
  });
  console.log();

  console.log('─'.repeat(WIDTH));
  if (anyFail) {
    console.log(C.bold(C.red('\n  AUDIT FAILED — fix all ❌ above before declaring parity\n')));
  } else {
    console.log(C.bold(C.green('\n  ALL GATES PASS ✅\n')));
  }
  if (planLimitedGates.length) {
    const PLAN_NOTES = {
      1: [
        'One or more snapshots are older than 24h and could not be auto-refreshed —',
        'the Figma Variables REST API is not available on this plan.',
        'This is a FRESHNESS flag, not a capability gap: every snapshot here',
        '(figma-structure, bound-tokens, component-state-tokens) can be refreshed on',
        'any plan via the Phase 1 Plugin API captures in /rms-figma-code-parity.',
        'Run Phase 1, commit the refreshed files, and this gate goes fully green.',
        'Until then, gates consuming these files run against the committed data —',
        'correct as of its _updated stamp, blind to DS changes made after it.',
      ],
    };
    console.log(C.yellow('  ⏭  PLAN-LIMITED GATES — what this means:\n'));
    for (const n of planLimitedGates) {
      const notes = PLAN_NOTES[n] ?? [`Gate [${n}] could not be fully verified due to Figma plan limitations.`];
      console.log(C.yellow(`  [${n}] ${gates[n - 1].label}`));
      for (const line of notes) console.log(C.yellow(`      ${line}`));
      console.log();
    }
  }
  console.log('─'.repeat(WIDTH) + '\n');

  // ── Write parity history ──────────────────────────────────────────────────────
  const histPath = join(ROOT, 'parity-history.json');
  let hist = [];
  try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
  hist.push({
    date:        today,
    timestamp:   new Date().toISOString(),
    pass:        gates.filter(g => g.pass && !g.planLimited).length,
    planLimited: gates.filter(g => g.planLimited).length,
    fail:        gates.filter(g => !g.pass && !g.planLimited).length,
    total:       gates.length,
    gates:       gates.map(g => ({ label: g.label, pass: g.pass, planLimited: g.planLimited ?? false })),
  });
  if (hist.length > 100) hist = hist.slice(-100);
  try { writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n'); } catch {}

  // ── HTML report ───────────────────────────────────────────────────────────────
  const htmlArgIdx = process.argv.indexOf('--report-html');
  if (htmlArgIdx !== -1 && process.argv[htmlArgIdx + 1]) {
    const REPORT_HTML = process.argv[htmlArgIdx + 1];
    let pcResult = { fail: [], aliasFail: [], newSkip: [], skip: [], passList: [], pendingFigmaSync: [] };
    try { pcResult = JSON.parse(readFileSync(join(ROOT, 'parity-check-result.json'), 'utf8')); } catch {}

    const allRows = [
      ...pcResult.fail.map(f         => ({ ...f, status: 'FAIL'       })),
      ...(pcResult.aliasFail || []).map(f => ({ ...f, status: 'ALIAS_FAIL' })),
      ...(pcResult.newSkip   || []).map(f => ({ ...f, status: 'NEW_SKIP'   })),
      ...(pcResult.skip      || []).map(f => ({ ...f, status: 'SKIP'       })),
    ];

    const dims     = ['color', 'sizing', 'typography'];
    const dimLabel = { color: 'Color', sizing: 'Sizing', typography: 'Typography' };
    const colStats = {};
    for (const dim of dims) {
      const rows = allRows.filter(r => r.dimension === dim);
      colStats[dim] = {
        ALL:        rows.length,
        FAIL:       rows.filter(r => r.status === 'FAIL').length,
        ALIAS_FAIL: rows.filter(r => r.status === 'ALIAS_FAIL').length,
        NEW_SKIP:   rows.filter(r => r.status === 'NEW_SKIP').length,
        SKIP:       rows.filter(r => r.status === 'SKIP').length,
      };
    }

    const swatchCell = val => {
      if (!val) return `<td class="empty">—</td>`;
      return val.startsWith('#')
        ? `<td class="val"><span class="sw" style="background:${val}"></span><code class="hex">${val}</code></td>`
        : `<td class="val"><code class="noncolor">${val}</code></td>`;
    };

    let sections = '';
    for (const dim of dims) {
      const rows = allRows.filter(r => r.dimension === dim);
      if (!rows.length) continue;
      const counts = colStats[dim];
      const theadHtml = `<thead><tr><th>Token</th><th>CSS Var</th><th>Mode</th><th>Figma</th><th>CSS / Issue</th><th>Status</th></tr></thead>`;
      let tbody = '';
      for (const r of rows) {
        const badgeCls = r.status === 'FAIL' ? 'missing' : r.status === 'ALIAS_FAIL' ? 'alias-fail' : r.status === 'NEW_SKIP' ? 'new-skip' : '';
        const badgeLabel = { FAIL: 'Fail', ALIAS_FAIL: 'Alias Fail', NEW_SKIP: 'New Skip', SKIP: 'Skip' }[r.status] ?? r.status;
        const issueCell = r.css
          ? swatchCell(r.css)
          : `<td class="empty" style="font-size:10px;color:#888;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.issue||r.reason||'').replace(/"/g,'&quot;')}">${r.issue || r.reason || '—'}</td>`;
        tbody += `<tr class="tr s-${r.status}" data-status="${r.status}">
        <td class="tname"><code>${r.token ?? ''}</code></td>
        <td class="tname" style="font-size:10px;color:#5b21b6"><code>${r.cssVar ?? '—'}</code></td>
        <td style="font-size:10px;color:#6b7280">${r.mode ?? '—'}</td>
        ${swatchCell(r.figma)}${issueCell}
        <td class="tst"><span class="badge ${badgeCls}">${badgeLabel}</span></td>
      </tr>`;
      }
      sections += `\n<div class="col-section" data-col="${dim}" data-counts="${encodeURIComponent(JSON.stringify(counts))}">
  <div class="tw"><table>${theadHtml}<tbody>${tbody}</tbody></table></div>
</div>`;
    }

    const firstDim = dims.find(d => (colStats[d]?.ALL ?? 0) > 0) ?? '';
    const tabsHtml = dims.filter(d => (colStats[d]?.ALL ?? 0) > 0).map((d, i) =>
      `<button class="tab${i===0?' active':''}" data-col="${d}" onclick="switchTab('${d}',this)">
  <div class="tab-top"><span class="tab-name">${dimLabel[d]}</span><span class="tab-count">${colStats[d].ALL}</span></div>
</button>`).join('');

    const gateCardsHtml = `<div style="padding:12px 28px;display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid #e4e7ec;background:#fafafa">
${gates.map((g, i) => `  <div style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:8px;font-size:11px;font-weight:600;background:${g.pass?'#dcfce7':'#fee2e2'};color:${g.pass?'#166534':'#991b1b'}" title="${(g.lines||[]).join('&#10;').replace(/"/g,'&quot;')}">${g.pass?'✅':'❌'} [${i+1}] ${g.label}</div>`).join('\n')}
</div>`;

    const nFail = pcResult.fail.length;
    const nAlias = (pcResult.aliasFail || []).length;
    const nNewSkip = (pcResult.newSkip || []).length;
    const nPass = (pcResult.passList || []).length;
    const html = buildReport({
      title: `Code Parity — ${today}`,
      metaHtml: `${nPass + nFail} tokens checked · ${today} · ${gates.filter(g => g.pass).length}/${gates.length} gates pass`,
      statCards: [
        { n: nPass,    label: 'Match',     desc: 'CSS matches Figma',     cls: 's'   },
        { n: nFail,    label: 'Fail',      desc: 'Value divergence',      cls: 'st'  },
        { n: nAlias,   label: 'Alias Fail', desc: 'Wrong primitive chain', cls: 'lo'  },
        { n: nNewSkip, label: 'New Skip',  desc: 'Needs sign-off',        cls: 'p'   },
      ],
      filterDefs: [
        { filter: 'ALL',        label: 'All',        dot: null, color: '#111'    },
        { filter: 'FAIL',       label: 'Fail',       dot: 'st', color: '#dc2626' },
        { filter: 'ALIAS_FAIL', label: 'Alias Fail', dot: 'lo', color: '#9333ea' },
        { filter: 'NEW_SKIP',   label: 'New Skip',   dot: 'p',  color: '#ca8a04' },
        { filter: 'SKIP',       label: 'Skip',       dot: null, color: '#6b7280' },
      ],
      tabsHtml,
      sections,
      firstCol: firstDim,
      extraHeadHtml: gateCardsHtml,
    });
    const htmlPath = REPORT_HTML.startsWith('/') ? REPORT_HTML : join(ROOT, REPORT_HTML);
    writeFileSync(htmlPath, html);
    console.log(`\n🌐 HTML parity report → ${REPORT_HTML}`);
  }

  process.exit(anyFail ? 1 : 0);
})();
