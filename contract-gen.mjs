// ── Standard contract emitter (Phase A) ──────────────────────────────────────
// Emits the design-system contract in the STANDARD format the project follows:
//   • tokens  → one W3C DTCG dictionary (ds.tokens.json): $type/$value, nested by
//               dot-path, per-mode values under $extensions. From figma-vars snapshot.
//   • components → one Equinor-shaped *.contract.json each: id / version /
//               description / props[] (bindings.figma + bindings.code) / anatomy /
//               states / variants / semantics. Tokens are referenced by {family.token},
//               never copied in.
//   • schema  → contract.schema.json validates every emitted contract.
//
// It is an AUDITOR output, not a generator: nothing here produces CSS or Figma, and
// NO gate reads these files — they cannot change any pass/fail (zero behavior change).
// CAPTURED fields (id, figmaNodeId, props types/defaults/options + bindings.figma,
// anatomy, states, variants) are auto-refreshed from the snapshots every run. AUTHORED
// fields (version, description, notes, semantics, props[].bindings.code) are PRESERVED
// across regenerations — same merge-aware guarantee as intent-gen.mjs. See the plan:
// temporal-baking-hippo.md (Phase A).
//
// Generic: no project names, tokens, or components are hardcoded.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function ensureDir(p) { try { mkdirSync(p, { recursive: true }); } catch { /* best-effort */ } }

// A DS token name like "buttonPrimary/background/color" → path ["buttonPrimary","background","color"].
const tokenPath = (name) => String(name).split('/').map(s => s.trim()).filter(Boolean);
// → a reference string "{buttonPrimary.background.color}" (the standard {family.token} syntax).
const tokenRef  = (name) => '{' + tokenPath(name).join('.') + '}';

// Set a leaf at a nested path, creating groups as needed. Skips (returns false) if the
// path would overwrite an existing leaf or descend through one (name collision).
function setDeep(root, path, leaf) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null) o[path[i]] = {};
    else if (typeof o[path[i]] !== 'object' || o[path[i]].$value !== undefined) return false;
    o = o[path[i]];
  }
  const last = path[path.length - 1];
  if (o[last] !== undefined && o[last].$value === undefined && typeof o[last] === 'object') return false;
  o[last] = leaf;
  return true;
}

function countLeaves(node) {
  if (node == null || typeof node !== 'object') return 0;
  if (node.$value !== undefined) return 1;
  let n = 0;
  for (const k of Object.keys(node)) if (!k.startsWith('$')) n += countLeaves(node[k]);
  return n;
}

const stripFigmaId = (key) => String(key).split('#')[0].trim();

// Figma property types considered STATES (vs plain VARIANTS) for anatomy grouping.
const STATE_NAMES = new Set(['state', 'disabled', 'hover', 'focus', 'active', 'selected', 'pressed', 'loading', 'checked', 'filled']);

// ── DTCG token dictionary ────────────────────────────────────────────────────
function buildTokens(vars, modes) {
  const out = {
    $description: 'Design-system tokens (W3C DTCG). Auto-generated from the Figma snapshot by rms-parity — do not edit by hand. Project-specific DS data: keep LOCAL, never commit to the public skill.',
  };
  const lightKey = modes?.[0]?.snapshotKey || 'light';
  const darkKey  = modes?.[1]?.snapshotKey || null;

  // color — resolved per mode; base $value is the first mode, other modes under $extensions.
  const cLight = vars.color?.[lightKey] || {};
  const cDark  = darkKey ? (vars.color?.[darkKey] || {}) : null;
  for (const name of Object.keys(cLight)) {
    const leaf = { $type: 'color', $value: cLight[name], $deprecated: false };
    if (cDark && cDark[name] !== undefined && cDark[name] !== cLight[name]) {
      leaf.$extensions = { 'com.rms.parity': { modes: { [lightKey]: cLight[name], [darkKey]: cDark[name] } } };
    }
    setDeep(out, tokenPath(name), leaf);
  }
  // sizing — mode-agnostic dimensions (px).
  for (const [name, val] of Object.entries(vars.sizing || {})) {
    setDeep(out, tokenPath(name), { $type: 'dimension', $value: String(val), $deprecated: false });
  }
  // typography — DTCG composite type.
  for (const [name, val] of Object.entries(vars.typography || {})) {
    if (val && typeof val === 'object') {
      setDeep(out, ['typography', name], {
        $type: 'typography',
        $value: { fontSize: val.size, fontWeight: String(val.weight), lineHeight: val.lh },
        $deprecated: false,
      });
    }
  }
  // breakpoints — dimensions, when present.
  for (const [name, val] of Object.entries(vars.breakpoints || {})) {
    setDeep(out, ['breakpoint', name], { $type: 'dimension', $value: String(val), $deprecated: false });
  }
  return out;
}

// ── Component contract pieces ─────────────────────────────────────────────────
const FIGMA_KIND_TO_TYPE = { VARIANT: 'enum', BOOLEAN: 'boolean', TEXT: 'text', INSTANCE_SWAP: 'instance' };

function buildProps(props) {
  const properties = props?.properties || {};
  const out = [];
  for (const [key, def] of Object.entries(properties)) {
    const name = stripFigmaId(key);
    const p = {
      name,
      type: FIGMA_KIND_TO_TYPE[def.type] || 'unknown',
      default: def.defaultValue,
      bindings: {
        figma: { kind: def.type, property: name },   // CAPTURED — from Figma
        code: null,                                   // AUTHORED — filled by hand, preserved
      },
    };
    if (Array.isArray(def.variantOptions)) p.options = def.variantOptions;
    out.push(p);
  }
  return out;
}

function insetOf(paddingVar) {
  if (!paddingVar) return null;
  const inset = {};
  if (paddingVar.tb) inset.blockToken = tokenRef(paddingVar.tb);
  if (paddingVar.lr) inset.inlineToken = tokenRef(paddingVar.lr);
  return Object.keys(inset).length ? inset : null;
}

function buildAnatomy(contract, structure) {
  const c = contract || {};
  const s = structure || {};
  const root = {};

  const inset = insetOf(c.paddingVar || s.paddingVar);
  if (inset) root.inset = inset;

  const gap = c.gapVar ?? s.gapVar;
  if (gap) root.gapToken = tokenRef(gap);
  else if (c.gapPx === 0) root.gap = 0;

  const radius = c.innerRadiusVar || s.innerRadiusVar;
  if (radius) root.radiusToken = tokenRef(radius);

  if (c.strokeSides) root.stroke = c.strokeSides;

  const h = c.h ?? s.h;
  if (h != null) root.height = h;

  const fontSize = c.fontSizeVar || s.fontSizeVar;
  if (fontSize) root.typographyToken = tokenRef('typography/' + fontSize);

  const anatomy = { root };

  // children → named parts (from the hand-authored contract).
  for (const ch of (c.children || [])) {
    if (!ch || !ch.name) continue;
    const part = {};
    if (ch.cssSelector) part.selector = ch.cssSelector;
    if (ch.gapVar) part.gapToken = tokenRef(ch.gapVar);
    else if (ch.gapPx === 0) part.gap = 0;
    const ci = insetOf(ch.paddingVar);
    if (ci) part.inset = ci;
    anatomy[ch.name] = part;
  }
  return anatomy;
}

function buildStatesVariants(contract, props) {
  const pm = contract?.propertyMap || {};
  const properties = props?.properties || {};
  const states = [];
  const variants = [];
  for (const [figProp, mapping] of Object.entries(pm)) {
    if (mapping == null || typeof mapping !== 'object') continue;   // TEXT/INSTANCE_SWAP or single-selector: skip
    const isState = STATE_NAMES.has(figProp.toLowerCase());
    for (const [opt, selector] of Object.entries(mapping)) {
      if (typeof selector !== 'string') continue;
      const entry = { when: { [figProp]: opt }, selector };
      if (isState) { entry.name = `${figProp}=${opt}`; states.push(entry); }
      else variants.push(entry);
    }
  }
  return { states, variants };
}

function buildContract(name, { contract, structure, props, prev }) {
  const c = contract?.[name];
  const s = structure?.[name];
  const p = props?.[name];
  const { states, variants } = buildStatesVariants(c, p);

  const out = {
    $schema: './contract.schema.json',
    id: 'rms.' + name,
    version: prev?.version || '0.1.0',                                              // AUTHORED (preserved)
    description: prev?.description || (c?._note ? String(c._note).slice(0, 300)     // AUTHORED (preserved once set)
                 : `${name} — captured from Figma by rms-parity.`),
    figmaNodeId: p?.nodeId || s?.nodeId || null,                                    // CAPTURED
    props: buildProps(p),                                                           // CAPTURED (+ bindings.code authored)
    anatomy: buildAnatomy(c, s),                                                     // CAPTURED
    states,                                                                          // CAPTURED
    variants,                                                                        // CAPTURED
    semantics: prev?.semantics || { element: null, aria: {} },                      // AUTHORED (preserved)
    notes: prev?.notes || '',                                                        // AUTHORED (preserved)
    'x-parity': {
      note: 'Auditor contract (rms-parity). CAPTURED fields (id, figmaNodeId, props types/defaults/options + bindings.figma, anatomy, states, variants) are auto-refreshed from the Figma snapshots each run — do not hand-edit. AUTHORED fields (version, description, notes, semantics, props[].bindings.code) are preserved across regenerations — edit these. No gate reads this file.',
      generated: new Date().toISOString(),
      sources: 'figma-vars / figma-structure / figma-component-props snapshots + structure-contract.mjs',
    },
  };

  // Merge-aware: preserve authored props[].bindings.code by prop name.
  if (Array.isArray(prev?.props)) {
    const prevByName = new Map(prev.props.map((pp) => [pp.name, pp]));
    for (const pp of out.props) {
      const old = prevByName.get(pp.name);
      if (old?.bindings?.code != null) pp.bindings.code = old.bindings.code;
    }
  }
  return out;
}

// ── Schema + minimal validator (no external deps) ─────────────────────────────
const CONTRACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://rms-parity/contract.schema.json',
  title: 'rms-parity component contract',
  type: 'object',
  required: ['id', 'version', 'props', 'anatomy'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', pattern: '^rms\\.' },
    version: { type: 'string' },
    description: { type: 'string' },
    figmaNodeId: { type: ['string', 'null'] },
    props: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'bindings'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          bindings: {
            type: 'object',
            required: ['figma', 'code'],
            properties: {
              figma: { type: 'object', required: ['kind', 'property'] },
              code: { type: ['object', 'null'] },
            },
          },
        },
      },
    },
    anatomy: { type: 'object', required: ['root'] },
    states: { type: 'array' },
    variants: { type: 'array' },
    semantics: { type: 'object' },
  },
};

// Minimal structural validator covering the schema above (required keys + prop shape).
// Returns a list of human-readable error strings (empty = valid).
function validateContract(c) {
  const errs = [];
  for (const k of CONTRACT_SCHEMA.required) if (c[k] === undefined) errs.push(`missing "${k}"`);
  if (c.id !== undefined && !/^rms\./.test(String(c.id))) errs.push('"id" must start with "rms."');
  if (c.anatomy !== undefined && (typeof c.anatomy !== 'object' || c.anatomy.root === undefined)) errs.push('"anatomy.root" is required');
  if (c.props !== undefined) {
    if (!Array.isArray(c.props)) errs.push('"props" must be an array');
    else c.props.forEach((p, i) => {
      if (!p || typeof p !== 'object') { errs.push(`props[${i}] not an object`); return; }
      if (!p.name) errs.push(`props[${i}] missing "name"`);
      if (!p.bindings || typeof p.bindings !== 'object') { errs.push(`props[${i}] missing "bindings"`); return; }
      const f = p.bindings.figma;
      if (!f || f.kind === undefined || f.property === undefined) errs.push(`props[${i}].bindings.figma needs {kind, property}`);
      if (!('code' in p.bindings)) errs.push(`props[${i}].bindings missing "code"`);
    });
  }
  return errs;
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function generateContracts(ROOT, cfg, opts = {}) {
  const paths = cfg.paths || {};
  const vars = readJSON(resolve(ROOT, paths.snapshotVars || 'figma-vars.snapshot.json'));
  if (!vars) throw new Error(`vars snapshot not found (${paths.snapshotVars})`);
  const structure = readJSON(resolve(ROOT, paths.snapshotStructure || 'figma-structure.snapshot.json'))?.components || {};
  const props = readJSON(resolve(ROOT, paths.compPropsSnapshot || 'figma-component-props.snapshot.json')) || {};

  let CONTRACT = {};
  const contractPath = resolve(ROOT, cfg.paths?.structureContract || 'structure-contract.mjs');
  if (existsSync(contractPath)) {
    try { CONTRACT = (await import(pathToFileURL(contractPath).href)).CONTRACT || {}; } catch { /* keep going */ }
  }

  // Output locations. Standard-aligned defaults: dedicated, discoverable, COMMITTED
  // artifacts at the project root — contracts/ + tokens/ as siblings (mirrors Equinor's
  // eds-contracts / eds-tokens packages), NOT buried in src. These are meant to be
  // versioned and treated as an API (Southleft), the opposite of the private
  // design-intent.json. Override any path via cfg.contracts.{out,tokensOut,schemaOut}.
  const cc = cfg.contracts || {};
  const outDir    = cc.out       ? resolve(ROOT, cc.out)       : join(ROOT, 'contracts');
  const tokensOut = cc.tokensOut ? resolve(ROOT, cc.tokensOut) : join(ROOT, 'tokens', 'ds.tokens.json');
  const schemaOut = cc.schemaOut ? resolve(ROOT, cc.schemaOut) : join(outDir, 'contract.schema.json');

  // Which components to emit. Default: EVERY component the scan found — the union of the
  // structure snapshot, the hand-authored contract, and the props snapshot. Nothing is
  // hardcoded to a project or a component. Narrow to specific names with cfg.contracts.only:
  // [names] (or the legacy cfg.contracts.pilot) when you deliberately want a subset.
  const allNames = [...new Set([
    ...Object.keys(structure),
    ...Object.keys(CONTRACT),
    ...Object.keys(props).filter((k) => !k.startsWith('_')),
  ])];
  let targets = cc.only ?? opts.only ?? cc.pilot ?? opts.pilot ?? 'all';
  if (targets === 'all' || (Array.isArray(targets) && targets.includes('*'))) targets = allNames;
  if (typeof targets === 'string') targets = [targets];
  targets = targets.filter((n) => structure[n] || CONTRACT[n] || props[n]);

  // Keep the generated DS data LOCAL by default — the token file and contracts carry
  // real, project-specific token values (proprietary). Drop a .gitignore in each output
  // dir so they are never pushed by accident. Opt out with cfg.contracts.gitignore=false.
  if (cc.gitignore !== false) {
    for (const d of new Set([outDir, dirname(tokensOut)])) {
      ensureDir(d);
      try { writeFileSync(join(d, '.gitignore'), '# rms-parity generated DS data — kept local, do not commit.\n*\n'); } catch { /* best-effort */ }
    }
  }

  // 1) DTCG token dictionary.
  const tokens = buildTokens(vars, cfg.figma?.modes);
  ensureDir(dirname(tokensOut));
  writeFileSync(tokensOut, JSON.stringify(tokens, null, 2) + '\n');

  // 2) Schema.
  ensureDir(dirname(schemaOut));
  writeFileSync(schemaOut, JSON.stringify(CONTRACT_SCHEMA, null, 2) + '\n');

  // 3) Per-component contracts (merge-aware) + validate.
  ensureDir(outDir);
  const emitted = [];
  const invalid = [];
  for (const name of targets) {
    const file = join(outDir, name + '.contract.json');
    const prev = readJSON(file);
    const contract = buildContract(name, { contract: CONTRACT, structure, props, prev });
    const errs = validateContract(contract);
    writeFileSync(file, JSON.stringify(contract, null, 2) + '\n');
    emitted.push(name);
    if (errs.length) invalid.push({ name, errs });
  }

  return { tokensOut, schemaOut, outDir, tokenCount: countLeaves(tokens), components: emitted, invalid };
}
