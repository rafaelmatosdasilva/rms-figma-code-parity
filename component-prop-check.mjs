// component-prop-check.mjs - Gate: Component prop parity (Figma properties <-> code props)
// Run from project root: node scripts/component-prop-check.mjs
//
// Compares each Figma component's PROPERTY NAMES (size, showLabel, labelContent, ...)
// against the code component's declared props. Reads props straight from the code, so
// it does NOT depend on Figma Code Connect (not every Figma account has it). Supports
// Vue (defineProps / props option) and React (Props type / destructured params /
// propTypes); add more via PROP_EXTRACTORS.
//
// Catches exactly what token/CSS gates cannot:
//   - a Figma property that is MISSING from the code component's props
//   - a property whose NAME differs (Figma "size" vs code "buttonSize")
//
// Reads at project root:
//   ds-config.json                     - paths, componentSelectors, componentFiles,
//                                        componentSrcDirs, knownUnimplementedComponents,
//                                        knownPropExceptions
//   figma-component-props.snapshot.json - Figma property definitions (written by audit.mjs)
//
// Exit 0 = every Figma property maps to a matching code prop (or is exempt).
// Exit 1 = a property is missing in code, or a name differs, or a component with Figma
//          properties has no code component (no silent skips).
// Exit 2 = the component-props snapshot is missing (gate did NOT run, never a pass) -
//          it should be committed; run the audit with FIGMA_TOKEN to generate it.

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join, extname, basename, relative } from 'path';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const SNAP_PATH = cfg.paths?.compPropsSnapshot ??
  (cfg.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json').replace(/[^/\\]+$/, 'figma-component-props.snapshot.json');

if (!existsSync(join(ROOT, SNAP_PATH))) {
  console.log(`\n⚠️  ${SNAP_PATH} not found at project root.`);
  console.log('   This snapshot lists each Figma component\'s properties and should be committed.');
  console.log('   Run /rms-figma-code-parity once - it captures this via the Figma plugin (no token,');
  console.log('   any plan) - then commit it.');
  console.log('   (exit 2 - treated as "not run", never a pass)\n');
  process.exit(2);
}
const SNAP = JSON.parse(readFileSync(join(ROOT, SNAP_PATH), 'utf8'));

const KNOWN_UNIMPLEMENTED = new Set(cfg.knownUnimplementedComponents ?? []);
const KNOWN_PROP_EXCEPTIONS = new Set(cfg.knownPropExceptions ?? []);   // "Component/prop"
const COMPONENT_FILES = cfg.componentFiles ?? {};                        // Figma name -> file path
const COMPONENT_SELECTORS = cfg.componentSelectors ?? {};
// Documented intentional renames: Figma property name -> code prop name, per component.
// e.g. { "buttonPrimary": { "size": "buttonSize", "labelContent": "label" } }
const PROP_ALIASES = cfg.componentPropAliases ?? {};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// Figma property keys carry a node-id suffix: "Show Label#958:0" -> "Show Label".
const cleanFigmaProp = (k) => k.replace(/#[\d:]+$/, '').trim();
const baseSelectorNorm = (name) => norm(COMPONENT_SELECTORS[name] ?? ('.' + name.charAt(0).toLowerCase() + name.slice(1)));

// ── Discover candidate source files ───────────────────────────────────────────
const SRC_DIRS = (cfg.componentSrcDirs ?? ['src', 'components', 'app', 'lib', 'packages']).map(d => join(ROOT, d));
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '.parity-refs']);
const CODE_EXT = new Set(['.vue', '.tsx', '.jsx', '.ts', '.js', '.svelte']);
function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (CODE_EXT.has(extname(e.name)) && !/\.(test|spec|stories)\./.test(e.name)) out.push(p);
  }
}
const candidateFiles = [];
for (const d of SRC_DIRS) if (existsSync(d)) walk(d, candidateFiles);
if (!candidateFiles.length) walk(ROOT, candidateFiles);   // fallback: whole repo (minus SKIP_DIR)
const fileText = new Map();
const readText = (f) => { if (!fileText.has(f)) { try { fileText.set(f, readFileSync(f, 'utf8')); } catch { fileText.set(f, ''); } } return fileText.get(f); };

// ── Prop extractors, keyed by extension. Each returns a Set of prop names. ─────
// Union of everything found; over-collecting a few names is fine (only unmatched
// Figma properties fail, and extra code props are advisory).
function idsFromDestructure(block) {
  const out = [];
  for (const m of block.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?::|=|,|\})/g)) {
    if (m[1] && m[1] !== 'props') out.push(m[1]);
  }
  return out;
}
function extractVue(text) {
  const names = new Set();
  // defineProps<{ ... }>()
  for (const m of text.matchAll(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) names.add(p[1]);
  // defineProps({ ... })  and options  props: { ... }
  for (const m of text.matchAll(/(?:defineProps\s*\(|[^.\w]props\s*:)\s*\{([\s\S]*?)\}\s*[),]/g))
    for (const p of m[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(p[1]);
  // defineProps([ 'a', 'b' ])  and options  props: [ 'a', 'b' ]
  for (const m of text.matchAll(/(?:defineProps\s*\(|[^.\w]props\s*:)\s*\[([\s\S]*?)\]/g))
    for (const p of m[1].matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)) names.add(p[1]);
  return names;
}
function extractReact(text) {
  const names = new Set();
  // interface XProps { ... }  /  type XProps = { ... }
  for (const m of text.matchAll(/(?:interface|type)\s+\w*Props\b[^{]*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) names.add(p[1]);
  // destructured function params: function C({ a, b }  /  const C = ({ a, b }
  for (const m of text.matchAll(/(?:function\s+[A-Z][\w$]*|(?:const|let|var)\s+[A-Z][\w$]*\s*=)\s*(?:function\s*)?\(\s*\{([\s\S]*?)\}/g))
    for (const id of idsFromDestructure(m[1])) names.add(id);
  // C.propTypes = { a: ..., b: ... }
  for (const m of text.matchAll(/\.propTypes\s*=\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(p[1]);
  return names;
}
function extractSvelte(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}
const PROP_EXTRACTORS = {
  '.vue': extractVue,
  '.svelte': extractSvelte,
  '.tsx': extractReact, '.jsx': extractReact, '.ts': extractReact, '.js': extractReact,
};
function extractProps(file) {
  const fn = PROP_EXTRACTORS[extname(file)];
  return fn ? fn(readText(file)) : new Set();
}

const _LIT = `(['"\`][^'"\`]*['"\`]|true|false|-?\\d+(?:\\.\\d+)?)`;
const _unq = (s) => String(s).replace(/^['"\`]|['"\`]$/g, '').trim();
// Best-effort: code prop -> default value (normalised prop name -> literal string).
// Covers React default params & defaultProps, Vue withDefaults / defineProps({default}).
function extractDefaults(text) {
  const out = new Map();
  const put = (name, val) => { if (name) out.set(norm(name), _unq(val)); };
  for (const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${_LIT}`, 'g'))) put(m[1], m[2]);   // ({ a = 'x' })
  for (const m of text.matchAll(/withDefaults\s*\([\s\S]*?,\s*\{([\s\S]*?)\}\s*\)/g))
    for (const p of m[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${_LIT}`, 'g'))) put(p[1], p[2]);
  for (const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*\\{[^{}]*\\bdefault\\s*:\\s*${_LIT}`, 'g'))) put(m[1], m[2]);
  for (const m of text.matchAll(/defaultProps\s*=\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${_LIT}`, 'g'))) put(p[1], p[2]);
  return out;
}
// Best-effort: code prop -> the set of string-literal options it accepts, from a TS
// union type (`size?: 'small' | 'medium' | 'large'`). Used to check variant coverage.
function extractOptions(text) {
  const out = new Map();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*((?:['"`][^'"`]*['"`]\s*\|\s*)+['"`][^'"`]*['"`])/g)) {
    const opts = [...m[2].matchAll(/['"`]([^'"`]*)['"`]/g)].map(x => norm(x[1]));
    if (opts.length >= 2) out.set(norm(m[1]), new Set(opts));
  }
  return out;
}
// #4: a Figma INSTANCE_SWAP property is a SLOT, not a value prop - it maps to a code
// slot (Vue <slot>, React children/ReactNode). Best-effort detection of the code's slots.
function extractSlots(text) {
  const named = new Set();
  let hasDefault = false;
  for (const m of text.matchAll(/<slot\b[^>]*\bname\s*=\s*['"`]([\w-]+)['"`]/g)) named.add(norm(m[1]));  // Vue named
  if (/<slot(\s|\/|>)/.test(text) && !/<slot\b[^>]*\bname\s*=/.test(text)) hasDefault = true;            // Vue default
  for (const m of text.matchAll(/defineSlots\s*<\s*\{([\s\S]*?)\}/g))
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) named.add(norm(p[1]));                  // Vue defineSlots
  if (/\bchildren\b/.test(text)) hasDefault = true;                                                      // React children
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*React\.?ReactNode/g)) named.add(norm(m[1])); // React ReactNode props as slots
  return { named, hasDefault };
}

// ── Resolve a Figma component name to its code file ───────────────────────────
// 1) explicit componentFiles map  2) base selector present (Vue <style>)
// 3) a declared component name matches  4) the file basename matches
function declaredNames(text) {
  const out = [];
  for (const m of text.matchAll(/\bname\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/g)) out.push(m[1]);          // Vue options / defineOptions
  for (const m of text.matchAll(/(?:function|class)\s+([A-Z][\w$]*)/g)) out.push(m[1]);                // React fn/class
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:styled|React|forwardRef|memo|\()/g)) out.push(m[1]);
  return out;
}
function resolveFile(figmaName) {
  if (COMPONENT_FILES[figmaName]) {
    const p = join(ROOT, COMPONENT_FILES[figmaName]);
    return existsSync(p) ? { file: p, how: 'componentFiles' } : { file: null, how: 'componentFiles(missing)' };
  }
  const fig = norm(figmaName);
  const sel = baseSelectorNorm(figmaName);
  const bySelector = [], byName = [], byBasename = [];
  for (const f of candidateFiles) {
    const t = readText(f);
    const tn = norm(t);
    if (sel.length >= 4 && tn.includes(sel)) bySelector.push(f);
    if (declaredNames(t).some(n => norm(n) === fig)) byName.push(f);
    if (norm(basename(f, extname(f))) === fig) byBasename.push(f);
  }
  const pick = bySelector.length ? bySelector : byName.length ? byName : byBasename;
  if (pick.length === 1) return { file: pick[0], how: bySelector.length ? 'selector' : byName.length ? 'name' : 'basename' };
  if (pick.length > 1)  return { file: null, how: `ambiguous (${pick.length} files)` };
  return { file: null, how: 'not found' };
}

// ── Compare Figma properties to code props, per component ─────────────────────
// Deterministic: a Figma property matches a code prop only by EXACT name (normalised)
// or an explicit documented alias. Everything else Figma-side is MISSING (fail), and
// leftover code props are EXTRA (advisory). Renames are then offered as SUGGESTIONS
// only - pairing names automatically is unreliable (a boolean "showLabel" is not the
// text prop "label"), so it never decides pass/fail; document a real rename as an alias.
// A Figma "State" variant (hover/focus/active/...) is not a code prop - it maps to CSS
// pseudo-classes, which Gate 11 (All states are built) verifies. Skip it here so a
// component that implements states in CSS isn't wrongly flagged as missing a `state` prop.
// Skips: a property named state/states, or a VARIANT whose options are all interaction states.
const STATE_WORDS = new Set(['default', 'hover', 'focus', 'focused', 'active', 'pressed',
  'selected', 'checked', 'indeterminate', 'visited', 'disabled', 'loading', 'error', 'on', 'off']);
const STATE_PROP_NAMES = new Set((cfg.knownStateProps ?? ['State', 'state', 'States']).map(norm));
const isStateAxis = (name, def) => STATE_PROP_NAMES.has(norm(name)) ||
  (def?.type === 'VARIANT' && Array.isArray(def.variantOptions) && def.variantOptions.length >= 2 &&
   def.variantOptions.every(o => STATE_WORDS.has(norm(o))));

const MISSING = [], NOFILE = [], EXTRA = [], SUGGEST = [], OK = [], VALUE_FAIL = [], VALUE_INFO = [], SLOT_FAIL = [];
const rows = [];   // structured parity rows: { component, figmaProp, figmaValue, codeProp, codeValue, status }

// How a Figma property definition reads in the report: 's · m · l', 'boolean', 'text', 'icon (instance)'.
const figmaValueOf = (def) => {
  if (!def) return '(unknown)';
  if (def.type === 'VARIANT' && Array.isArray(def.variantOptions)) return def.variantOptions.join(' · ');
  if (def.type === 'BOOLEAN') return 'boolean';
  if (def.type === 'TEXT') return 'text';
  if (def.type === 'INSTANCE_SWAP') return def.defaultValue ? `icon (${def.defaultValue})` : 'icon (instance)';
  return String(def.type || '(value)').toLowerCase();
};

for (const [figmaName, entry] of Object.entries(SNAP)) {
  if (figmaName === '_updated' || !entry?.properties) continue;
  const figDefs = new Map(Object.entries(entry.properties)
    .filter(([k, v]) => !isStateAxis(cleanFigmaProp(k), v))   // states are Gate 11's job, not props
    .map(([k, v]) => [cleanFigmaProp(k), v]));   // name -> {type, defaultValue, variantOptions}
  const figNames = [...figDefs.keys()].filter(Boolean);
  if (!figNames.length) continue;
  if (KNOWN_UNIMPLEMENTED.has(figmaName)) continue;

  const { file, how } = resolveFile(figmaName);
  if (!file) {
    NOFILE.push(`${figmaName}: has Figma properties [${figNames.join(', ')}] but no code component found (${how}) - set ds-config.json → componentFiles["${figmaName}"], or exempt via knownUnimplementedComponents`);
    for (const fp of figNames) rows.push({ component: figmaName, figmaProp: fp, figmaValue: figmaValueOf(figDefs.get(fp)), codeProp: 'not in code', codeValue: `(no code file: ${how})`, status: 'missing' });
    continue;
  }
  const text = readText(file);
  const codeNorm     = new Map([...extractProps(file)].map(p => [norm(p), p]));   // normName -> original
  const codeDefaults = extractDefaults(text);                                     // normName -> default literal
  const codeOptions  = extractOptions(text);                                      // normName -> Set(option norms)
  const aliases  = PROP_ALIASES[figmaName] ?? {};
  const rel = relative(ROOT, file);

  // #1/#3: for a matched prop, compare Figma's default value, variant options and type
  // against the code. Pushes to VALUE_FAIL/VALUE_INFO (text output + exit code) AND returns
  // the report row's { status, codeValue }. Only fails on values actually readable from the
  // code (a default or a string-literal union); a parsing gap stays a non-failing 'match'.
  const checkValues = (fp, def, codeName) => {
    if (KNOWN_PROP_EXCEPTIONS.has(`${figmaName}/${fp}`)) return { status: 'match', codeValue: '(exempt)' };
    const cn = norm(codeName);
    const figDefault = def?.defaultValue;
    const codeDefault = codeDefaults.get(cn);
    if (figDefault != null && figDefault !== '' && codeDefault != null && norm(figDefault) !== norm(codeDefault)) {
      VALUE_FAIL.push(`${figmaName}/${fp}: default differs - Figma "${figDefault}" vs code "${codeName}=${codeDefault}"  (${rel})`);
      return { status: 'value', codeValue: `default ${codeDefault}` };
    }
    if (def?.type === 'VARIANT' && Array.isArray(def.variantOptions) && def.variantOptions.length) {
      const opts = codeOptions.get(cn);
      if (opts) {
        const miss = def.variantOptions.filter(o => !opts.has(norm(o)));
        if (miss.length) {
          VALUE_FAIL.push(`${figmaName}/${fp}: code prop "${codeName}" is missing Figma variant option(s) ${miss.map(o => `"${o}"`).join(', ')}  (${rel})`);
          return { status: 'value', codeValue: [...opts].join(' · ') };
        }
        return { status: 'match', codeValue: [...opts].join(' · ') };
      }
      VALUE_INFO.push(`${figmaName}/${fp}: Figma variants [${def.variantOptions.join(', ')}] - could not read the code prop's allowed values to verify  (${rel})`);
      return { status: 'match', codeValue: '(present)' };
    }
    if (def?.type === 'BOOLEAN') {
      if (codeDefault != null && codeDefault !== 'true' && codeDefault !== 'false')
        VALUE_INFO.push(`${figmaName}/${fp}: Figma BOOLEAN but code default "${codeDefault}" is not boolean - check the prop type  (${rel})`);
      return { status: 'match', codeValue: 'boolean' };
    }
    return { status: 'match', codeValue: codeDefault != null ? `default ${codeDefault}` : '(present)' };
  };

  const codeSlots = extractSlots(text);
  const matchedCode = new Set();
  const missingHere = [];
  for (const fp of figNames) {
    const def = figDefs.get(fp);
    const figmaValue = figmaValueOf(def);
    const pushRow = (codeProp, codeValue, status) => rows.push({ component: figmaName, figmaProp: fp, figmaValue, codeProp, codeValue, status });

    if (KNOWN_PROP_EXCEPTIONS.has(`${figmaName}/${fp}`)) { OK.push(`${figmaName}/${fp} (exempt)`); pushRow(fp, '(exempt)', 'match'); continue; }

    // An INSTANCE_SWAP (e.g. an icon) is NOT assumed to be a slot: the code may expose it as
    // a prop OR a slot. Match either, and report the actual representation.
    if (def?.type === 'INSTANCE_SWAP') {
      const fn = norm(fp);
      if (codeNorm.has(fn)) { matchedCode.add(fn); OK.push(`${figmaName}/${fp} (prop)`); pushRow(codeNorm.get(fn), 'prop', 'match'); continue; }
      const aliasTo0 = aliases[fp] && norm(aliases[fp]);
      if (aliasTo0 && codeNorm.has(aliasTo0)) { matchedCode.add(aliasTo0); OK.push(`${figmaName}/${fp} → ${aliases[fp]} (prop, alias)`); pushRow(aliases[fp], 'prop', 'match'); continue; }
      if (codeSlots.named.has(fn)) { OK.push(`${figmaName}/${fp} (slot)`); pushRow(fp, 'slot', 'match'); continue; }
      if (codeSlots.hasDefault)   { OK.push(`${figmaName}/${fp} (default slot)`); pushRow('(default slot)', 'slot', 'match'); continue; }
      SLOT_FAIL.push(`${figmaName}: Figma instance-swap "${fp}" has no code prop or slot  (${rel})`);
      pushRow('not in code', '-', 'missing'); continue;
    }

    const fn = norm(fp);
    if (codeNorm.has(fn)) { matchedCode.add(fn); OK.push(`${figmaName}/${fp}`); const v = checkValues(fp, def, codeNorm.get(fn)); pushRow(codeNorm.get(fn), v.codeValue, v.status); continue; }
    const aliasTo = aliases[fp] && norm(aliases[fp]);
    if (aliasTo && codeNorm.has(aliasTo)) { matchedCode.add(aliasTo); OK.push(`${figmaName}/${fp} → ${aliases[fp]} (alias)`); const v = checkValues(fp, def, codeNorm.get(aliasTo)); pushRow(aliases[fp], v.codeValue, v.status); continue; }
    missingHere.push(fp);   // row added after rename-pairing below
    MISSING.push(`${figmaName}: Figma property "${fp}" has no code prop  (${rel})`);
  }
  const extraHere = [...codeNorm.entries()].filter(([cn]) => !matchedCode.has(cn));

  // Pair an unmatched Figma prop with an unused code prop when one name clearly contains the
  // other (>=3 chars) → a RENAME row (and consume that code prop so it isn't also 'extra').
  const pairedCode = new Set();
  for (const fp of missingHere) {
    const fn = norm(fp);
    const def = figDefs.get(fp);
    const hit = extraHere.find(([cn]) => !pairedCode.has(cn) && cn.length >= 3 && fn.length >= 3 && (cn.includes(fn) || fn.includes(cn)));
    if (hit) {
      pairedCode.add(hit[0]);
      SUGGEST.push(`${figmaName}: Figma "${fp}" might be code "${hit[1]}" - if so add componentPropAliases["${figmaName}"]["${fp}"] = "${hit[1]}"`);
      rows.push({ component: figmaName, figmaProp: fp, figmaValue: figmaValueOf(def), codeProp: hit[1], codeValue: '(rename?)', status: 'rename' });
    } else {
      rows.push({ component: figmaName, figmaProp: fp, figmaValue: figmaValueOf(def), codeProp: 'not in code', codeValue: '-', status: 'missing' });
    }
  }

  for (const [cn, cp] of extraHere) {
    if (pairedCode.has(cn)) continue;   // already shown as a rename row
    EXTRA.push(`${figmaName}: code prop "${cp}" has no Figma property  (${rel})`);
    rows.push({ component: figmaName, figmaProp: 'not in Figma', figmaValue: '-', codeProp: cp, codeValue: '(present)', status: 'extra' });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ OK        ${OK.length}`);
console.log(`❌ MISSING   ${MISSING.length}   (Figma property with no matching code prop)`);
console.log(`❌ VALUE     ${VALUE_FAIL.length}   (wrong default, or a Figma variant the code doesn't accept)`);
console.log(`❌ SLOT      ${SLOT_FAIL.length}   (Figma instance-swap slot with no code slot)`);
console.log(`❌ NO FILE   ${NOFILE.length}   (Figma component with props, no code component found)`);
if (EXTRA.length)      console.log(`ℹ️ EXTRA     ${EXTRA.length}   (code prop with no Figma property - advisory)`);
if (SUGGEST.length)    console.log(`ℹ️ RENAME?   ${SUGGEST.length}   (possible renames - advisory)`);
if (VALUE_INFO.length) console.log(`ℹ️ VALUE?    ${VALUE_INFO.length}   (could not read a code value to verify - advisory)`);

const fail = MISSING.length + NOFILE.length + VALUE_FAIL.length + SLOT_FAIL.length;

// Structured result for the parity report table (best-effort; never affects the gate result).
try {
  writeFileSync(join(ROOT, 'component-prop-result.json'), JSON.stringify({
    pass: fail === 0,
    rows,
    summary: { total: rows.length, match: rows.filter(r => r.status === 'match').length, diverged: rows.filter(r => r.status !== 'match').length },
  }, null, 2) + '\n');
} catch { /* result file is optional */ }
if (MISSING.length)    { console.log('\n─── Missing in code (rename the code prop to match, add the prop, or document an alias) ──'); for (const l of MISSING) console.log(`  ❌ ${l}`); }
if (VALUE_FAIL.length) { console.log('\n─── Wrong value (default or variant options do not match Figma) ──'); for (const l of VALUE_FAIL) console.log(`  ❌ ${l}`); }
if (SLOT_FAIL.length)  { console.log('\n─── Missing slot (Figma instance swap with no code slot) ──'); for (const l of SLOT_FAIL) console.log(`  ❌ ${l}`); }
if (NOFILE.length)     { console.log('\n─── No code component found ──'); for (const l of NOFILE) console.log(`  ❌ ${l}`); }
if (SUGGEST.length)    { console.log('\n─── Possible renames (advisory) ──'); for (const l of SUGGEST) console.log(`  ℹ️ ${l}`); }
if (VALUE_INFO.length) { console.log('\n─── Values not verified (advisory) ──'); for (const l of VALUE_INFO.slice(0, 20)) console.log(`  ℹ️ ${l}`); }
if (EXTRA.length)      { console.log('\n─── Extra code props (advisory) ──'); for (const l of EXTRA.slice(0, 20)) console.log(`  ℹ️ ${l}`); }

if (fail) { console.log(''); process.exit(1); }
console.log('\nEvery Figma component property maps to a matching code prop, with the right default and variants. ✓\n');
process.exit(0);
