// baseline.mjs - gate-level adoption baseline + ratchet (feature #2).
//
// A real codebase is rarely 100% green on day one. Without a baseline, adopting the audit means
// either a wall of red (ignored) or turning gates off (drift hides). The baseline records which
// gates are failing at adoption time as ACCEPTED DEBT: those gates no longer fail the run, but any
// gate NOT in the baseline that fails is a real regression and fails. Debt can only ratchet DOWN -
// a baselined gate that goes green is surfaced so it can be locked in and never regress silently.
//
// Gate-level (not per-finding) on purpose: it uses only the pass/fail the audit already has for all
// gates, is fully deterministic, imposes no structure, and the committed baseline is legible - you
// can read exactly which gates are owed. Pure and degrade-safe; the file is COMMITTED (shared in CI).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Read the accepted-debt gate labels from the baseline file, or null when there is no baseline.
// Never throws; a malformed file reads as "no baseline" (adoption is opt-in, never a hard stop).
export function loadBaselineLabels(path) {
  try {
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(doc?.gates) ? doc.gates.filter((x) => typeof x === 'string') : [];
  } catch { return null; }
}

// The gates that are genuinely failing right now (plan-limited gates are neutral, never debt).
export function currentFailingLabels(gates) {
  return (gates || []).filter((g) => !g.pass && !g.planLimited).map((g) => g.label);
}

// Compare the current gate results against the baseline. Returns:
//   debt        - failing AND baselined (accepted; does not fail the run)
//   regressions - failing AND not baselined (real; fails the run)
//   ratcheted   - baselined but now passing (lock it in with --baseline so it can't regress)
//   stale       - baseline labels that no longer match any gate (renamed/removed; prune them)
//   gateFail    - whether the gate portion of the verdict should fail (regressions only)
export function classifyBaseline(gates, baselineLabels) {
  const base    = new Set(baselineLabels || []);
  const present = new Set((gates || []).map((g) => g.label));
  const failing = currentFailingLabels(gates);
  const failSet = new Set(failing);
  const debt        = failing.filter((l) => base.has(l));
  const regressions = failing.filter((l) => !base.has(l));
  const ratcheted   = [...base].filter((l) => present.has(l) && !failSet.has(l));
  const stale       = [...base].filter((l) => !present.has(l));
  return { debt, regressions, ratcheted, stale, gateFail: regressions.length > 0 };
}

// Capture the current failing gates as the new baseline and write it. Returns the labels written.
export function writeBaseline(path, gates) {
  const labels = currentFailingLabels(gates);
  const doc = {
    $note: 'rms-parity adoption baseline (gate-level accepted debt). These gates are currently failing and are treated as KNOWN DEBT - they do not fail the run. A gate NOT listed here that fails is a real regression and fails the audit. Debt only ratchets down: a baselined gate that goes green is reported so you can re-run --baseline to lock it in. COMMIT this file (no secrets - only gate labels).',
    created: new Date().toISOString(),
    gates: labels,
  };
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return labels;
}
