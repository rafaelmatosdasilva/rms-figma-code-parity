// audit-parse.mjs - turn a gate script's output into the lines the audit report shows.
//
// Kept out of audit.mjs so tests can feed a gate's real output through the same parser the report
// uses. Rules, the same for every gate:
//   • the gate's own summary lines (its summary pattern) are shown;
//   • a skip or "not verified" line is always shown, so a gate that did not check anything never
//     reads as a silent green;
//   • a passing gate that printed no line at all says so, instead of showing an empty green;
//   • on a fail, the ❌/🚨 lines are added, each line once;
//   • status null means only one thing: the script file does not exist.

export const SKIP_RE = /^\s*⏭|\bskipped\b|\bnot verified\b|\bnot run\b/i;

export function parseGateOutput(r, summaryRe, { maxDetails = 20 } = {}) {
  if (r.status === null) return { pass: true, lines: ['⏭ script not found - skipped'] };
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const pass = r.status === 0;
  const seen = new Set();
  const keep = (l) => { const k = l.trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; };
  const rows = out.split('\n');
  const summary = rows.filter((l) => l.trim() && (summaryRe.test(l) || SKIP_RE.test(l))).filter(keep).map((l) => l.trim());
  const failDetails = pass ? [] : rows.filter((l) => /🚨|❌/.test(l)).filter(keep).map((l) => '  ' + l.trim()).slice(0, maxDetails);
  if (pass && !summary.length) summary.push('⚠️  this gate printed no result line, so its outcome is not visible here');
  if (!pass && !summary.length && !failDetails.length) {
    const last = rows.map((l) => l.trim()).filter(Boolean).slice(-3);
    failDetails.push(...(last.length ? last.map((l) => '  ' + l) : ['  ❌ the gate failed without printing a reason']));
  }
  return { pass, lines: [...summary, ...failDetails] };
}

// The summary pattern of every gate the audit parses generically. One table, so a test can check a
// gate's real output against the pattern the report uses.
export const GATE_SUMMARY = {
  'mode-completeness-check.mjs': /✅ OK|❌ FAIL|ADAPTS|STATIC|SKIPPED/,
  'exemption-check.mjs': /VALID|STALE|BROKEN/,
  'naming-check.mjs': /TRACEABLE|UNINVENTED|UNDOCUMENTED/,
  'docs-truth-check.mjs': /\[docs-truth\]/,
  'case-check.mjs': /\[text-case\]/,
  'reimplementation-check.mjs': /\[reimplementation\]/,
  'container-containment-check.mjs': /✅|❌/,
  'state-check.mjs': /COVERED|UNCOVERED|⚠️|⏭ HIDDEN/,
  'state-binding-check.mjs': /COVERED|MISSING/,
  'state-opacity-check.mjs': /CORRECT|MISMATCH/,
  'component-prop-check.mjs': /OK|MISSING|VALUE|SLOT|NO FILE|EXTRA|RENAME\?|REALIZED|UNREALIZED|UNMAPPED|VIA STATE/,
  'component-composition-check.mjs': /OK|MISSING|NO FILE|EXTRA|SKIP/,
  'template-composition-check.mjs': /USES|MISSING|NO FILE|ORDER|skipped/,
  'html-structure-check.mjs': /✅|❌|ℹ️  \[15\]/,
  'screen-element-check.mjs': /IN CODE|MISSING|MISMATCH|SEP GAP|counterpart|built as|row-separator|ADVISORY/,
  'icon-slot-check.mjs': /✅|❌/,
  'component-slot-check.mjs': /✅|❌/,
  'form-control-check.mjs': /✅|❌/,
  'pseudo-element-check.mjs': /DOCUMENTED|UNDOCUMENTED/,
  'icon-check.mjs': /DOCUMENTED|UNDOCUMENTED/,
  'icon-freshness-check.mjs': /MATCH|CHANGED/,
  'icon-inventory-check.mjs': /IN CODE|MISSING/,
  'transition-check.mjs': /✅|❌/,
  'motion-check.mjs': /MATCH|MISMATCH|SKIPPED|⏭/,
  'effect-check.mjs': /MATCH|MISMATCH|SKIPPED|⏭/,
  'rendered-check.mjs': /✅|❌|⏭/,
  'coverage-check.mjs': /MODELLED|UNCHECKED|NO RENDERED|SINGLE-VARIANT|MODE-BLIND|MODE COVERAGE|UNVERIFIED FILL|FILL COVERAGE|CODE CAPTURE/,
};
