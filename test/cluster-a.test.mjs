// Regression tests for "cluster A" gate fixes: bound-check.mjs, state-check.mjs and
// transition-check.mjs. Each gate reads ds-config.json + snapshots + CSS from its cwd,
// prints ✅/❌ lines, and exits 0 (pass) / 1 (fail) / 2 (not run - input snapshot missing).
//
// Fixtures are built from a { relpath: content } map and run via the shared harness
// (test/helpers.mjs → runGate). Every fixture is modelled on the gate's own inputs and
// early-exit conditions (read the gate source, do not guess).
//
// Bugs locked here (all three gates were fixed for the same class of bug + one parser bug):
//   • bound-check / state-check / transition-check: paths.themeCSS may now be an ARRAY of
//     files. The old code passed the array straight to path.join → TypeError. The fix flattens
//     [cfg.paths.themeCSS].flat() and reads every listed file.
//   • transition-check findAllBlocks: a rule now closes on a `}` ANYWHERE on a line (keeping the
//     text before it), so a rule whose closing brace shares its last declaration's line
//     (`padding: 4px; }`) no longer swallows the following rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, EMPTY_PARITY_MAP, crashed } from './helpers.mjs';

// ── 1) bound-check.mjs ────────────────────────────────────────────────────────
// Inputs: ds-config.json (else exit 1), parity-map.mjs (optional), bound-tokens.json
// (else exit 2 - "not run"), and the themeCSS file(s). isCovered maps a Figma token `a/b`
// to CSS var `--a-b` (normalize drops /color, then `/`→`-`). No snapshotVars ⇒ the orphan
// report is skipped and a fully-covered run exits 0.

test('[regression bound-check] single-file themeCSS: a bound token whose --a-b var is declared → COVERED, exit 0', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand-primary: #f00; }',
    'bound-tokens.json': ['brand/primary'],           // brand/primary → --brand-primary (declared)
  });
  assert.equal(code, 0, out);
  assert.match(out, /COVERED\s+1\b/);
  assert.match(out, /UNCOVERED\s+0\b/);
});

test('[regression bound-check] a bound token with no matching CSS var → UNCOVERED, exit 1', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --brand-primary: #f00; }',
    'bound-tokens.json': ['brand/missing'],           // → --brand-missing (NOT declared)
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNCOVERED\s+1\b/);
  assert.match(out, /brand\/missing/);
});

test('[bugfix bound-check] themeCSS as an ARRAY of two files resolves a var declared only in the SECOND file → exit 0, no crash', () => {
  const { code, out } = runGate('bound-check.mjs', {
    'ds-config.json': { paths: { themeCSS: ['a.css', 'b.css'] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'a.css': ':root { --unrelated: 1px; }',           // needed var is NOT here …
    'b.css': ':root { --brand-primary: #f00; }',      // … it is only in the second file
    'bound-tokens.json': ['brand/primary'],
  });
  assert.ok(!crashed(out), out);                      // old code: path.join(root, [array]) → TypeError
  assert.equal(code, 0, out);
  assert.match(out, /COVERED\s+1\b/);                 // proves BOTH array files were actually read
});

// ── 2) state-check.mjs ────────────────────────────────────────────────────────
// Inputs: ds-config.json (else exit 1), parity-map.mjs (optional), component-state-tokens.json
// (else exit 2 - the early exit that guards the theme-CSS read), and the themeCSS file(s).
// The theme-CSS read (the array-crash site) is only reached AFTER component-state-tokens.json
// is present, so every fixture below supplies it. Same `a/b` → `--a-b` coverage convention.

test('[regression state-check] a covered visible state token → COVERED, exit 0', () => {
  const { code, out } = runGate('state-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --button-hover-bg: #eee; }',
    'component-state-tokens.json': { 'button/hover/bg': 'x' },  // → --button-hover-bg (declared)
  });
  assert.equal(code, 0, out);
  assert.match(out, /COVERED\s+1\b/);
  assert.match(out, /UNCOVERED\s+0\b/);
});

test('[regression state-check] an uncovered visible state token → UNCOVERED, exit 1', () => {
  const { code, out } = runGate('state-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'theme.css': ':root { --button-hover-bg: #eee; }',
    'component-state-tokens.json': { 'button/missing/bg': 'x' },  // → --button-missing-bg (NOT declared)
  });
  assert.equal(code, 1, out);
  assert.match(out, /UNCOVERED\s+1\b/);
  assert.match(out, /button\/missing\/bg/);
});

test('[bugfix state-check] themeCSS as an ARRAY does not crash and resolves a var in the SECOND file → exit 0, no crash', () => {
  const { code, out } = runGate('state-check.mjs', {
    'ds-config.json': { paths: { themeCSS: ['a.css', 'b.css'] } },
    'parity-map.mjs': EMPTY_PARITY_MAP,
    'a.css': ':root { --unrelated: 1px; }',
    'b.css': ':root { --button-hover-bg: #eee; }',
    'component-state-tokens.json': { 'button/hover/bg': 'x' },
  });
  assert.ok(!crashed(out), out);                      // old code threw on [array] passed to path.join
  assert.equal(code, 0, out);
  assert.match(out, /COVERED\s+1\b/);
});

// ── 3) transition-check.mjs ───────────────────────────────────────────────────
// Inputs: ds-config.json (else exit 1), structure-contract.mjs (exports TRANSITION_CONTRACT;
// empty/absent ⇒ exit 0 "skipped"), and the themeCSS file(s) - the FIRST themeCSS path must
// exist (else exit 1). Each contract value is a transition string (or array of them); the gate
// splits the CSS `transition:` value on top-level commas and requires each documented part as an
// exact (whitespace-normalised) member.

test('[regression transition-check] a contracted selector with the correct transition → PASS, exit 0', () => {
  const { code, out } = runGate('transition-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'structure-contract.mjs': "export const TRANSITION_CONTRACT = { '.btn': 'color 120ms ease' };",
    'theme.css': '.btn { transition: color 120ms ease; }',
  });
  assert.equal(code, 0, out);
  assert.match(out, /PASS\s+1\/1/);
});

test('[regression transition-check] a wrong duration → FAIL, exit 1', () => {
  const { code, out } = runGate('transition-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'structure-contract.mjs': "export const TRANSITION_CONTRACT = { '.btn': 'color 120ms ease' };",
    'theme.css': '.btn { transition: color 999ms ease; }',   // duration drifted from the contract
  });
  assert.equal(code, 1, out);
  assert.match(out, /missing \[ color 120ms ease \]/);
  assert.match(out, /999ms/);
});

test("[bugfix transition-check] a closing brace on the last declaration's line does not swallow the following rule", () => {
  // `.card` has NO transition of its own and its `}` shares the `padding` line. The following
  // `.tooltip` rule DOES declare `opacity 999ms linear`. Under the OLD line-leading-`}`-only
  // scanner, `.card`'s block ran on and SWALLOWED `.tooltip`, so `.card` borrowed its transition
  // and spuriously PASSED (exit 0). Post-fix, `.card`'s block ends at the `}` on the padding line:
  //   • `.card`  → correctly reported as having no transition (FAIL) - the divergence is caught.
  //   • `.tooltip` → parsed independently and PASSES (the 1 in "PASS 1/2").
  const { code, out } = runGate('transition-check.mjs', {
    'ds-config.json': { paths: { themeCSS: 'theme.css' } },
    'structure-contract.mjs':
      "export const TRANSITION_CONTRACT = { '.card': 'opacity 999ms linear', '.tooltip': 'opacity 999ms linear' };",
    'theme.css': [
      '.card {',
      '  padding: 4px; }',                 // closing brace shares the last declaration's line
      '.tooltip {',
      '  transition: opacity 999ms linear;',
      '}',
    ].join('\n'),
  });
  assert.ok(!crashed(out), out);
  assert.equal(code, 1, out);                          // old (buggy) code would have exited 0 here
  assert.match(out, /\.card:\s+"transition" property not declared/);  // .tooltip's rule not swallowed
  assert.match(out, /PASS\s+1\/2/);                    // .tooltip still parsed & passed on its own
});

test('[bugfix transition-check] themeCSS as an ARRAY does not crash (transition declared in the SECOND file) → exit 0', () => {
  const { code, out } = runGate('transition-check.mjs', {
    'ds-config.json': { paths: { themeCSS: ['a.css', 'b.css'] } },
    'structure-contract.mjs': "export const TRANSITION_CONTRACT = { '.btn': 'color 120ms ease' };",
    'a.css': ':root { --x: 1px; }',                    // first file must exist; no transition here
    'b.css': '.btn { transition: color 120ms ease; }', // contract satisfied by the second file
  });
  assert.ok(!crashed(out), out);                       // old code threw on [array] passed to path.join
  assert.equal(code, 0, out);
  assert.match(out, /PASS\s+1\/1/);
});
