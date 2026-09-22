// ── Standard contract emitter ────────────────────────────────────────────────
// Emits the design-system contract in the STANDARD format the project follows, into ONE
// local (gitignored) contracts/ folder:
//   • tokens  → one W3C DTCG dictionary (tokens.json): $type/$value, nested by dot-path,
//               per-mode values under $extensions. From the figma-vars snapshot.
//   • components → one standard <name>.contract.json each: id / version /
//               description / props[] (bindings.figma + bindings.code) / anatomy /
//               states / variants / semantics. Tokens are referenced by {family.token},
//               never copied in.
//   • schema  → contract.schema.json validates every emitted contract.
//
// It is an AUDITOR output, not a generator: nothing here produces CSS or Figma.
//
// CAPTURED vs AUTHORED are split by file so decisions can be committed while values stay
// local. CAPTURED fields (id, figmaNodeId, props types/defaults/options + bindings.figma,
// anatomy, states, variants, tokens) are refreshed from the snapshots every run into the
// local views. AUTHORED fields (version, description, notes, semantics, props[].bindings.code)
// live in a SINGLE committed file, contract.authored.json (project root), which the generator
// reads (and scaffolds once if missing) and Gate 14 also reads — so bindings apply in CI.
//
// Generic: no project names, tokens, or components are hardcoded.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pruneCandidates } from './prune-check.mjs';

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
  // Optional per-token metadata sidecar { "<name>": { description?, deprecated? } }, captured from
  // each Figma variable's own description (deprecated via a "@deprecated" marker). Additive: absent
  // leaves the DTCG defaults ($deprecated:false, no $description).
  const meta = vars.tokenMeta || {};
  const applyMeta = (leaf, name) => {
    const m = meta[name];
    if (m && typeof m === 'object') {
      if (typeof m.description === 'string' && m.description.trim()) leaf.$description = m.description.trim();
      if (m.deprecated === true) leaf.$deprecated = true;
    }
    return leaf;
  };

  // setDeep returns false on a name collision (a token path that would overwrite a leaf or descend
  // through one, e.g. a color "spacing" and a sizing "spacing/xs"). Record the drop so it is surfaced
  // loudly instead of a token silently vanishing from the dictionary ("silence is never a pass").
  const dropped = [];
  const place = (name, path, leaf) => { if (!setDeep(out, path, leaf)) dropped.push(name); };

  // color — resolved per mode; base $value is the first mode, other modes under $extensions.
  const cLight = vars.color?.[lightKey] || {};
  const cDark  = darkKey ? (vars.color?.[darkKey] || {}) : null;
  for (const name of Object.keys(cLight)) {
    const leaf = { $type: 'color', $value: cLight[name], $deprecated: false };
    if (cDark && cDark[name] !== undefined && cDark[name] !== cLight[name]) {
      leaf.$extensions = { 'com.rms.parity': { modes: { [lightKey]: cLight[name], [darkKey]: cDark[name] } } };
    }
    place(name, tokenPath(name), applyMeta(leaf, name));
  }
  // sizing — mode-agnostic dimensions (px).
  for (const [name, val] of Object.entries(vars.sizing || {})) {
    place(name, tokenPath(name), applyMeta({ $type: 'dimension', $value: String(val), $deprecated: false }, name));
  }
  // typography — DTCG composite type.
  for (const [name, val] of Object.entries(vars.typography || {})) {
    if (val && typeof val === 'object') {
      place(name, ['typography', name], applyMeta({
        $type: 'typography',
        $value: { fontSize: val.size, fontWeight: String(val.weight), lineHeight: val.lh },
        $deprecated: false,
      }, name));
    }
  }
  // breakpoints — dimensions, when present.
  for (const [name, val] of Object.entries(vars.breakpoints || {})) {
    place(name, ['breakpoint', name], applyMeta({ $type: 'dimension', $value: String(val), $deprecated: false }, name));
  }
  return { tokens: out, dropped };
}

// ── Component contract pieces ─────────────────────────────────────────────────
const FIGMA_KIND_TO_TYPE = { VARIANT: 'enum', BOOLEAN: 'boolean', TEXT: 'text', INSTANCE_SWAP: 'instance' };

function buildProps(props, propDescriptions = {}) {
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
    // Figma component-property definitions carry no per-prop description, so this is authored
    // (contract.authored.json → components[name].propDescriptions), with a forward-compat capture path.
    const desc = def.description ?? propDescriptions[name];
    if (typeof desc === 'string' && desc.trim()) p.description = desc.trim();
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

function buildContract(name, { contract, structure, props, authored, composition, componentNames }) {
  const c = contract?.[name];
  const s = structure?.[name];
  const p = props?.[name];
  const a = authored || {};
  const { states, variants } = buildStatesVariants(c, p);

  const out = {
    $schema: './contract.schema.json',
    id: 'rms.' + name,
    version: a.version || '0.1.0',                                                  // AUTHORED (from contract.authored.json)
    description: a.description                                                       // AUTHORED, else CAPTURED Figma component description
                 || (p?.description ? String(p.description).slice(0, 300)
                 : (c?._note ? String(c._note).slice(0, 300)
                 : `${name} — captured from Figma by rms-parity.`)),
    figmaNodeId: p?.nodeId || s?.nodeId || null,                                    // CAPTURED
    props: buildProps(p, a.propDescriptions),                                        // CAPTURED (+ bindings.code + authored descriptions)
    anatomy: buildAnatomy(c, s),                                                     // CAPTURED
    states,                                                                          // CAPTURED
    variants,                                                                        // CAPTURED
    semantics: a.semantics || { element: null, aria: {} },                          // AUTHORED
    notes: a.notes || '',                                                            // AUTHORED
    'x-parity': {
      note: 'Generated LOCAL view (rms-parity). CAPTURED fields refresh from the Figma snapshots each run; AUTHORED fields (version, description, notes, semantics, props[].bindings.code) come from the committed contract.authored.json — edit them THERE, not here. This file is gitignored; do not hand-edit.',
      generated: new Date().toISOString(),
      sources: 'figma-vars / figma-structure / figma-component-props snapshots + structure-contract.mjs + contract.authored.json',
    },
  };

  // AUTHORED agent guidance: when NOT to use this component, and what to use instead.
  // Optional and additive — absent leaves the contract unchanged.
  if (typeof a.whenNotToUse === 'string' && a.whenNotToUse.trim()) out.whenNotToUse = a.whenNotToUse.trim();
  {
    const ui = Array.isArray(a.useInstead)
      ? a.useInstead.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : (typeof a.useInstead === 'string' && a.useInstead.trim() ? [a.useInstead.trim()] : []);
    if (ui.length) out.useInstead = ui;
  }

  // Relationships: composesWith is DERIVED from the composition snapshot (the real DS
  // components this one nests — icons and raw selectors are excluded); neverCombineWith is
  // AUTHORED (only the genuinely invalid pairings). Emitted only when non-empty.
  {
    const kids = Array.isArray(composition?.[name]) ? composition[name] : [];
    const known = componentNames instanceof Set ? componentNames : new Set(componentNames || []);
    const composesWith = [...new Set(kids.map(stripFigmaId).filter((k) => known.has(k) && k !== name))];
    const neverCombineWith = Array.isArray(a.neverCombineWith)
      ? [...new Set(a.neverCombineWith.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
      : [];
    if (composesWith.length || neverCombineWith.length) {
      out.relationships = {};
      if (composesWith.length) out.relationships.composesWith = composesWith;
      if (neverCombineWith.length) out.relationships.neverCombineWith = neverCombineWith;
    }
  }

  // AUTHORED bindings come from the committed contract.authored.json, keyed by Figma prop name.
  const bindings = a.bindings || {};
  for (const pp of out.props) {
    const b = bindings[pp.name];
    if (b && typeof b === 'object') pp.bindings.code = b;   // { attribute } | { slot } | { attribute: true } ...
  }

  // Usage scaffold (I26): a grounded, ready-to-fill example derived from THIS contract - the authored
  // semantic element (when known) plus each prop with a concrete example value (its default, else its
  // first variant option). Nothing is invented: every value comes from the captured props / authored
  // semantics, so an agent instantiates the component with real names instead of guessing. Framework
  // syntax is intentionally left to the agent (we give the element + prop values, not JSX vs class).
  // Emitted only when there is something concrete to show.
  {
    const exampleProps = {};
    for (const pr of out.props) {
      const val = (pr.default != null && pr.default !== '') ? pr.default
        : (Array.isArray(pr.options) && pr.options.length ? pr.options[0] : undefined);
      if (val !== undefined) exampleProps[pr.name] = val;
    }
    const usage = {};
    if (out.semantics && out.semantics.element) usage.element = out.semantics.element;
    if (Object.keys(exampleProps).length) usage.props = exampleProps;
    if (Object.keys(usage).length) out.usage = usage;
  }

  // Slot constraints (I5): surface the component's slots for the agent - each Figma INSTANCE_SWAP
  // property (or a prop the contract binds to a code slot) is a place another component goes. `accepts`
  // is the component's own composesWith universe (what it actually nests), so the agent has the valid
  // set without guessing. Derived from the contract's own props + relationships; emitted only when there
  // are slots.
  {
    const accepts = out.relationships?.composesWith || [];
    const slots = out.props
      .filter((p) => p.bindings?.figma?.kind === 'INSTANCE_SWAP'
        || (p.bindings?.code && (p.bindings.code.slot === true || typeof p.bindings.code.slot === 'string')))
      .map((p) => {
        const s = { name: p.name, default: p.default ?? null };
        if (typeof p.bindings?.code?.slot === 'string') s.code = p.bindings.code.slot;
        if (accepts.length) s.accepts = accepts;
        return s;
      });
    if (slots.length) out.slots = slots;
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
    whenNotToUse: { type: 'string' },
    useInstead: { type: 'array', items: { type: 'string' } },
    relationships: {
      type: 'object',
      properties: {
        composesWith: { type: 'array', items: { type: 'string' } },
        neverCombineWith: { type: 'array', items: { type: 'string' } },
      },
    },
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

// Lint the hand-edited contract.authored.json so a malformed binding is surfaced loudly
// instead of being silently ignored (which would resurface the false positive it was meant
// to fix). Non-failing — returns a list of human-readable issue strings. Only shape checks:
// bindings must be { attribute: string|true } and/or { slot: string|true }; unknown keys
// (typos like "atribute") are flagged with a hint.
function lintAuthored(doc) {
  const issues = [];
  const comps = doc?.components;
  if (!comps || typeof comps !== 'object') return issues;
  for (const [name, entry] of Object.entries(comps)) {
    if (!entry || typeof entry !== 'object') { issues.push(`${name}: entry must be an object`); continue; }
    // Optional agent-guidance fields (checked even when there are no bindings).
    if ('whenNotToUse' in entry && typeof entry.whenNotToUse !== 'string') issues.push(`${name}.whenNotToUse must be a string`);
    if ('useInstead' in entry) {
      const ok = typeof entry.useInstead === 'string' || (Array.isArray(entry.useInstead) && entry.useInstead.every((x) => typeof x === 'string'));
      if (!ok) issues.push(`${name}.useInstead must be a string or a list of strings`);
    }
    if ('neverCombineWith' in entry && !(Array.isArray(entry.neverCombineWith) && entry.neverCombineWith.every((x) => typeof x === 'string'))) issues.push(`${name}.neverCombineWith must be a list of strings`);
    const b = entry.bindings;
    if (b === undefined) continue;
    if (typeof b !== 'object' || Array.isArray(b)) { issues.push(`${name}.bindings must be an object`); continue; }
    for (const [prop, bind] of Object.entries(b)) {
      if (!bind || typeof bind !== 'object' || Array.isArray(bind)) {
        issues.push(`${name}.bindings.${prop} must be like { attribute: "codeName" } or { slot: "slotName" }`); continue;
      }
      for (const k of Object.keys(bind)) {
        if (k === 'attribute' || k === 'slot') continue;
        const lk = k.toLowerCase();
        const hint = (lk.startsWith('at') || lk.includes('trib')) ? ' (did you mean "attribute"?)'
                   : lk.startsWith('sl') ? ' (did you mean "slot"?)'
                   : ' (expected "attribute" or "slot")';
        issues.push(`${name}.bindings.${prop}: unknown key "${k}"${hint}`);
      }
      if (!('attribute' in bind) && !('slot' in bind)) issues.push(`${name}.bindings.${prop}: needs "attribute" or "slot"`);
      if ('attribute' in bind && !(typeof bind.attribute === 'string' || bind.attribute === true)) issues.push(`${name}.bindings.${prop}.attribute must be a string or true`);
      if ('slot' in bind && !(typeof bind.slot === 'string' || bind.slot === true)) issues.push(`${name}.bindings.${prop}.slot must be a string or true`);
    }
  }
  return issues;
}

// ── Change detection + reference integrity (the auditor's "time axis") ─────────
// Flatten a DTCG dictionary to a Map of dot-path -> { deprecated }.
function flattenTokens(node, prefix = [], out = new Map()) {
  if (!node || typeof node !== 'object') return out;
  if (node.$value !== undefined) { out.set(prefix.join('.'), { deprecated: node.$deprecated === true, type: node.$type }); return out; }
  for (const k of Object.keys(node)) { if (!k.startsWith('$')) flattenTokens(node[k], [...prefix, k], out); }
  return out;
}
// The DTCG $type each anatomy slot expects, so a token of the wrong type (a color used where a
// dimension belongs) is caught. Unlisted slots skip the type check (existence only).
const REF_KEY_TYPE = { radiusToken: 'dimension', gapToken: 'dimension', inlineToken: 'dimension', blockToken: 'dimension', typographyToken: 'typography' };
// Every {family.token} reference inside a contract's anatomy, with the slot key it sits under.
function collectRefSlots(contract, out = []) {
  const walk = (v, key) => {
    if (typeof v === 'string') { const m = v.match(/^\{(.+)\}$/); if (m) out.push({ ref: m[1], key }); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], k);
  };
  walk(contract.anatomy, 'anatomy');
  return out;
}

// Blast radius (I20): how many components depend on each token / component, so a change to a shared
// contract reads as authorship rather than a quiet local tweak (S9 "may it?"). Counts only - the
// engine SURFACES the reach, it never enforces authority. Pure and testable.
export function usageCounts(built) {
  const tokens = new Map();       // token dot-path -> Set(component that references it)
  const components = new Map();   // component -> Set(component that composes it)
  for (const { name, contract } of built) {
    for (const ref of new Set(collectRefSlots(contract).map((r) => r.ref))) {
      if (!tokens.has(ref)) tokens.set(ref, new Set());
      tokens.get(ref).add(name);
    }
    for (const child of (contract.relationships?.composesWith || [])) {
      if (!components.has(child)) components.set(child, new Set());
      components.get(child).add(name);
    }
  }
  const sizes = (m) => new Map([...m].map(([k, v]) => [k, v.size]));
  return { tokens: sizes(tokens), components: sizes(components) };
}

const semverMajor = (v) => { const n = parseInt(String(v ?? '0').split('.')[0], 10); return Number.isFinite(n) ? n : 0; };

// Classify the change between a component's previous emitted contract and the new one.
// breaking = a consumer relying on the old shape breaks (prop/option/state removed, default
// changed); additive = new prop/option/state. Advisory only — never fails the audit.
function diffContract(prev, next, name) {
  const out = [];
  if (!prev) return out;   // first emit — nothing to compare
  const pmap = new Map((prev.props || []).map((p) => [p.name, p]));
  const nmap = new Map((next.props || []).map((p) => [p.name, p]));
  for (const [pn, pp] of pmap) {
    const np = nmap.get(pn);
    if (!np) { out.push({ level: 'breaking', msg: `${name}: prop "${pn}" removed` }); continue; }
    if (JSON.stringify(pp.default) !== JSON.stringify(np.default))
      out.push({ level: 'breaking', msg: `${name}: prop "${pn}" default changed (${JSON.stringify(pp.default)} -> ${JSON.stringify(np.default)})` });
    const po = new Set(pp.options || []); const no = new Set(np.options || []);
    const removed = [...po].filter((o) => !no.has(o));
    const added   = [...no].filter((o) => !po.has(o));
    if (removed.length) out.push({ level: 'breaking', msg: `${name}: prop "${pn}" removed option(s) ${removed.join(', ')}` });
    if (added.length)   out.push({ level: 'additive', msg: `${name}: prop "${pn}" added option(s) ${added.join(', ')}` });
  }
  for (const pn of nmap.keys()) if (!pmap.has(pn)) out.push({ level: 'additive', msg: `${name}: prop "${pn}" added` });
  const ps = new Set((prev.states || []).map((s) => s.name).filter(Boolean));
  const ns = new Set((next.states || []).map((s) => s.name).filter(Boolean));
  for (const s of ps) if (!ns.has(s)) out.push({ level: 'breaking', msg: `${name}: state "${s}" removed` });
  for (const s of ns) if (!ps.has(s)) out.push({ level: 'additive', msg: `${name}: state "${s}" added` });
  // Semver guard: a breaking change should carry a major-version bump.
  if (out.some((c) => c.level === 'breaking') && semverMajor(next.version) <= semverMajor(prev.version))
    out.push({ level: 'breaking', msg: `${name}: breaking change but version still ${next.version} — bump the major in contract.authored.json` });
  return out.map((c) => ({ ...c, component: name }));   // tag with the component for blast-radius
}
// Structural token diff (removals break consumers silently; additions are safe; a token newly
// flagged $deprecated is a heads-up). Value changes are NOT here — the parity gates already
// report value drift against Figma.
function diffTokens(prevFlat, nextFlat) {
  const out = [];
  for (const name of prevFlat.keys()) if (!nextFlat.has(name)) out.push({ level: 'breaking', msg: `token "${name}" removed`, ref: name });
  for (const [name, meta] of nextFlat) {
    if (!prevFlat.has(name)) out.push({ level: 'additive', msg: `token "${name}" added`, ref: name });
    else if (meta.deprecated && !prevFlat.get(name).deprecated) out.push({ level: 'deprecation', msg: `token "${name}" deprecated`, ref: name });
  }
  return out;
}

// A machine-readable index for AI agents (the llms.txt convention): components, where their
// contracts live, and the token dictionary. Generated, local (lives beside the contracts).
function buildLlms(built, tokens, tokenCount) {
  const families = Object.keys(tokens).filter((k) => !k.startsWith('$'));
  const lines = ['# Design system — machine-readable index', '',
    `> Generated by rms-parity from Figma + code. ${built.length} components, ${tokenCount} W3C DTCG tokens. Each component links to its contract.`, '',
    '## Components', ''];
  for (const { name, contract } of built) {
    const desc = String(contract.description || '').replace(/\s+/g, ' ').trim();
    const props = (contract.props || []).map((p) => p.name).join(', ');
    lines.push(`- [${name}](./${name}.contract.json): ${desc}${props ? `  · props: ${props}` : ''}`);
    // Agent guidance + relationships, one sub-line each when present.
    const rel = contract.relationships || {};
    if (contract.whenNotToUse) lines.push(`    - avoid: ${String(contract.whenNotToUse).replace(/\s+/g, ' ').trim()}`);
    if (Array.isArray(contract.useInstead) && contract.useInstead.length) lines.push(`    - use instead: ${contract.useInstead.join(', ')}`);
    if (Array.isArray(rel.composesWith) && rel.composesWith.length) lines.push(`    - composes: ${rel.composesWith.join(', ')}`);
    if (Array.isArray(rel.neverCombineWith) && rel.neverCombineWith.length) lines.push(`    - never with: ${rel.neverCombineWith.join(', ')}`);
  }
  lines.push('', '## Tokens', '', `- [tokens.json](./tokens.json) — W3C DTCG dictionary (${tokenCount} tokens; families: ${families.join(', ')}).`, '');
  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function generateContracts(ROOT, cfg, opts = {}) {
  const paths = cfg.paths || {};
  const vars = readJSON(resolve(ROOT, paths.snapshotVars || 'figma-vars.snapshot.json'));
  if (!vars) throw new Error(`vars snapshot not found (${paths.snapshotVars})`);
  const structure = readJSON(resolve(ROOT, paths.snapshotStructure || 'figma-structure.snapshot.json'))?.components || {};
  const props = readJSON(resolve(ROOT, paths.compPropsSnapshot || 'figma-component-props.snapshot.json')) || {};
  // Optional composition snapshot ({ "<Component>": ["Child", ...] }) drives relationships.composesWith.
  // Absent → relationships are simply omitted (additive, never an error).
  const composition = readJSON(resolve(ROOT, paths.compositionSnapshot || 'component-composition.snapshot.json')) || {};

  let CONTRACT = {};
  const contractPath = resolve(ROOT, cfg.paths?.structureContract || 'structure-contract.mjs');
  if (existsSync(contractPath)) {
    try { CONTRACT = (await import(pathToFileURL(contractPath).href)).CONTRACT || {}; } catch { /* keep going */ }
  }

  // Output: ONE local directory holding the standard triple — per-component contracts, the
  // DTCG token dictionary, and the schema (the standard per-component shape, without extra folders). Kept
  // local by default (a single .gitignore below) since it carries the DS's real values.
  // Override any path via cfg.contracts.{out,tokensOut,schemaOut}.
  const cc = cfg.contracts || {};
  const outDir    = cc.out       ? resolve(ROOT, cc.out)       : join(ROOT, 'contracts');
  const tokensOut = cc.tokensOut ? resolve(ROOT, cc.tokensOut) : join(outDir, 'tokens.json');
  const schemaOut = cc.schemaOut ? resolve(ROOT, cc.schemaOut) : join(outDir, 'contract.schema.json');
  // The AUTHORED layer is a SINGLE committed file at the project root (decisions only, no captured
  // values), so it is safe to share and applies in CI — unlike the local, gitignored generated views.
  const authoredPath = cc.authored ? resolve(ROOT, cc.authored) : join(ROOT, 'contract.authored.json');

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

  // Load the committed AUTHORED layer. Scaffold it once if missing (empty bindings per component);
  // never rewrite it afterwards, so it stays user-owned with clean git diffs.
  let authoredDoc = readJSON(authoredPath);
  if (!authoredDoc) {
    authoredDoc = {
      _note: 'Hand-authored contract layer (rms-parity) — COMMIT this file. It holds decisions only (Figma->code bindings, semantics, notes), never captured DS values, so it is safe to share and applies in CI. The generated contracts/ + tokens.json are local, gitignored views built from this + the Figma snapshots. Resolve a prop rename or slot by adding, under a component: "bindings": { "<figmaProp>": { "attribute": "codeName" } }  or  { "slot": "slotName" }. Optional agent guidance per component: "whenNotToUse" (string), "useInstead" (string or list), "neverCombineWith" (list of component names).',
      components: Object.fromEntries(allNames.map((n) => [n, { bindings: {} }])),
    };
    try { writeFileSync(authoredPath, JSON.stringify(authoredDoc, null, 2) + '\n'); } catch { /* best-effort */ }
  }
  const authoredIssues = lintAuthored(authoredDoc);   // malformed bindings → surfaced, never silently ignored

  // Keep the generated DS data LOCAL by default — the token file and contracts carry
  // real, project-specific token values (proprietary). Drop a .gitignore in each output
  // dir so they are never pushed by accident. Opt out with cfg.contracts.gitignore=false.
  if (cc.gitignore !== false) {
    for (const d of new Set([outDir, dirname(tokensOut)])) {
      ensureDir(d);
      try { writeFileSync(join(d, '.gitignore'), '# rms-parity generated DS data — kept local, do not commit.\n*\n'); } catch { /* best-effort */ }
    }
  }

  // 1) DTCG token dictionary (diff the structural shape vs the previous emit).
  const prevTokens = readJSON(tokensOut);
  const { tokens, dropped: droppedTokens } = buildTokens(vars, cfg.figma?.modes);
  ensureDir(dirname(tokensOut));
  writeFileSync(tokensOut, JSON.stringify(tokens, null, 2) + '\n');
  const tokenChanges = prevTokens ? diffTokens(flattenTokens(prevTokens), flattenTokens(tokens)) : [];   // first run has no baseline
  const tokenMap = flattenTokens(tokens);   // name -> { deprecated, type }

  // 2) Schema.
  ensureDir(dirname(schemaOut));
  writeFileSync(schemaOut, JSON.stringify(CONTRACT_SCHEMA, null, 2) + '\n');

  // 3) Per-component contracts + validate + change/reference detection.
  ensureDir(outDir);
  const emitted = [];
  const invalid = [];
  const built = [];
  const breaking = [...tokenChanges];
  const undefinedRefs = [];
  const typeMismatches = [];
  const componentNames = new Set(allNames);   // real DS components, to filter composesWith
  for (const name of targets) {
    const file = join(outDir, name + '.contract.json');
    const prev = readJSON(file);                                              // previous emit (for the diff)
    const contract = buildContract(name, { contract: CONTRACT, structure, props, authored: authoredDoc.components?.[name], composition, componentNames });
    const errs = validateContract(contract);
    writeFileSync(file, JSON.stringify(contract, null, 2) + '\n');
    emitted.push(name);
    built.push({ name, contract });
    if (errs.length) invalid.push({ name, errs });
    breaking.push(...diffContract(prev, contract, name));
    for (const { ref, key } of collectRefSlots(contract)) {
      const t = tokenMap.get(ref);
      if (!t) { undefinedRefs.push(`${name}: references undefined token {${ref}}`); continue; }
      const expected = REF_KEY_TYPE[key];
      if (expected && t.type && t.type !== expected) typeMismatches.push(`${name}: {${ref}} is a ${t.type} but a ${expected} is expected (${key})`);
    }
  }

  // Blast radius (I20): attach how many components depend on each changed token/component.
  const usage = usageCounts(built);
  for (const c of breaking) {
    const n = c.ref != null ? usage.tokens.get(c.ref) : (c.component != null ? usage.components.get(c.component) : undefined);
    if (n) c.consumers = n;
  }

  // 4) AI index (llms.txt) — a machine-readable summary for agents, local beside the contracts.
  const llmsOut = cc.llmsOut ? resolve(ROOT, cc.llmsOut) : join(outDir, 'llms.txt');
  try { writeFileSync(llmsOut, buildLlms(built, tokens, countLeaves(tokens)) + '\n'); } catch { /* best-effort */ }

  // Prune candidates (I8): a lean-library advisory over what we just built. Surfaced, never enforced.
  const prune = pruneCandidates({ built, usage, tokensDict: tokens });

  return { tokensOut, schemaOut, outDir, authoredPath, llmsOut, tokenCount: countLeaves(tokens), components: emitted, invalid, authoredIssues, breaking, undefinedRefs, typeMismatches, droppedTokens, prune };
}
