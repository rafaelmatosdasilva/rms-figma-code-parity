// test/smoke.test.mjs - baseline "every gate runs without crashing" suite.
//
// One `[smoke <gate>]` test per gate. Each runs the gate against a MINIMAL but valid
// fixture and asserts the gate reaches a clean verdict:
//   • !crashed(out)            - no Node stack trace / TypeError / uncaught throw
//   • [0,1,2].includes(code)   - a real gate exit (0 pass / 1 fail / 2 not-run), never a crash
//
// The point is NOT that a gate passes - most exit 2 or 0 here because their snapshot /
// contract is deliberately absent, which is a valid smoke result. The point is that no
// future change can make a gate throw a stack trace and have this suite stay green.
//
// See test/mode-resolver-fixes.test.mjs for the house style; the shared harness lives in
// test/helpers.mjs (runGate builds a throwaway project from a { path: content } map).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, EMPTY_PARITY_MAP, crashed } from './helpers.mjs';

// Gates skip on env: icon-freshness needs FIGMA_TOKEN, rendered-check honours CHROME_PATH.
// runGate's child inherits this process's env, so clear both here to make the smoke run
// deterministic on any machine (a CI runner with a token, a dev Mac with Chrome installed).
delete process.env.FIGMA_TOKEN;
delete process.env.CHROME_PATH;

// ── Shared minimal fixture pieces ──────────────────────────────────────────────
// Root-level paths (no `src/` prefix) so a gate that WRITES its baseline snapshot next to
// the theme CSS (html-structure) writes into the fixture root, never a missing src/ dir.
const CONFIG = {
  figmaFileKey: 'SMOKEKEY',
  paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' },
};
const THEME = ':root{}';
// A shape-valid vars snapshot: color-axis gates read color.<mode>, motion/effect read their
// own maps. Every map is empty, so each gate finds nothing to check and exits cleanly.
const SNAP = { color: { light: {}, dark: {} }, sizing: {}, motion: {}, effects: {} };

// Every gate that dynamic-imports parity-map.mjs + reads the vars snapshot needs all three
// files present to exercise that path instead of bailing early.
const WITH_MAP_AND_SNAP = {
  'ds-config.json': CONFIG,
  'parity-map.mjs': EMPTY_PARITY_MAP,
  'figma-vars.snapshot.json': SNAP,
  'theme.css': THEME,
};

// Assert a gate ran without crashing and returned a real verdict (never an uncaught throw).
function assertClean(gate, files, args = []) {
  const { code, out } = runGate(gate, files, args);
  assert.ok(!crashed(out), `${gate} produced a stack trace:\n${out}`);
  assert.ok([0, 1, 2].includes(code), `${gate} exited ${code}, not a clean 0/1/2 verdict:\n${out}`);
  return { code, out };
}

// ── Gates that skip cleanly when their snapshot / contract is absent ────────────
// (ds-config.json alone is enough; each exits 0 or 2 without touching a snapshot.)

test('[smoke coverage-check] runs without crashing on a minimal fixture', () => {
  // No structure snapshot → skips (exit 0).
  assertClean('coverage-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke state-binding-check] runs without crashing on a minimal fixture', () => {
  // No structure-contract.mjs → skips (exit 0).
  assertClean('state-binding-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke subcomponent-isolation-check] runs without crashing on a minimal fixture', () => {
  // No CSS sources to scan → exit 0.
  assertClean('subcomponent-isolation-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke icon-freshness-check] runs without crashing on a minimal fixture', () => {
  // FIGMA_TOKEN unset (cleared above) → skips (exit 0), never hits the network.
  assertClean('icon-freshness-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke component-prop-check] runs without crashing on a minimal fixture', () => {
  // Component-props snapshot absent → exit 2 (not run), a valid smoke result.
  assertClean('component-prop-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke component-composition-check] runs without crashing on a minimal fixture', () => {
  // Composition snapshot absent → exit 2 (not run), a valid smoke result.
  assertClean('component-composition-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke icon-inventory-check] runs without crashing on a minimal fixture', () => {
  // figma-icons.snapshot.json absent → inert, skips (exit 0).
  assertClean('icon-inventory-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke state-opacity-check] runs without crashing on a minimal fixture', () => {
  // No structure snapshot → inert, skips (exit 0).
  assertClean('state-opacity-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke html-structure-check] runs without crashing on a minimal fixture', () => {
  // No plugins; first run writes a baseline snapshot into the fixture root (exit 0).
  assertClean('html-structure-check.mjs', { 'ds-config.json': CONFIG });
});

test('[smoke rendered-check] runs without crashing on a minimal fixture', () => {
  // No RENDERED_ASSERTIONS (no structure-contract.mjs) → skips before launching Chrome (exit 0).
  assertClean('rendered-check.mjs', { 'ds-config.json': CONFIG });
});

// ── Gates that read the vars snapshot (hard-required) + import parity-map.mjs ────

test('[smoke exemption-check] runs without crashing on a minimal fixture', () => {
  // Reads the snapshot unconditionally once parity-map loads; empty maps → nothing stale (exit 0).
  assertClean('exemption-check.mjs', WITH_MAP_AND_SNAP);
});

test('[smoke naming-check] runs without crashing on a minimal fixture', () => {
  // Reads the snapshot unconditionally; no declared CSS vars → all traceable (exit 0).
  assertClean('naming-check.mjs', WITH_MAP_AND_SNAP);
});

test('[smoke mode-completeness-check] runs without crashing on a minimal fixture', () => {
  // Reads the snapshot unconditionally; empty color maps, no extra collections → exit 0.
  assertClean('mode-completeness-check.mjs', WITH_MAP_AND_SNAP);
});

// ── Opt-in gates that read only the vars snapshot (no parity-map import) ─────────

test('[smoke motion-check] runs without crashing on a minimal fixture', () => {
  // Reads the snapshot unconditionally; no snapshot.motion + no figma.motion → not configured (exit 0).
  assertClean('motion-check.mjs', {
    'ds-config.json': CONFIG,
    'figma-vars.snapshot.json': SNAP,
    'theme.css': THEME,
  });
});

test('[smoke effect-check] runs without crashing on a minimal fixture', () => {
  // Reads the snapshot unconditionally; no snapshot.effects + no figma.effects → not configured (exit 0).
  assertClean('effect-check.mjs', {
    'ds-config.json': CONFIG,
    'figma-vars.snapshot.json': SNAP,
    'theme.css': THEME,
  });
});
