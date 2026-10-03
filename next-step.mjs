// next-step.mjs - one next step, and one plain summary, per run (idea I55, "the agent's part as small as
// possible"). An agent relays what the engine says instead of composing its own reading of a long report,
// so two runs over the same state say the same thing.
//
//   • nextStep(state)   → the single NEXT line: what to do now, with the exact command.
//   • buildSummary(...) → the plain-language result to relay in the chat as is; also written to
//                         .design-system-engine-out/summary.md, and printed again by `--summary`.
// Pure: the audit passes in what it already computed.
import { ZERO_FAIL } from './run-diff.mjs';

const ANSI = /\x1b\[[0-9;]*m/g;
const clean = (l) => String(l).replace(ANSI, '').trim();
const gateName = (label) => clean(label).replace(/\s{2}\(.*$/, '');

// The ❌ lines of a gate, and the measured differences Gate [13] lists.
// A count line ("❌ FAIL  1", "❌ BROKEN  2 (…)") says how many, not which: left out. A "Fix:" hint the gate
// printed is kept, as the way to fix the line before it.
const COUNT = /^❌\s+[A-Z][A-Z ?]*\s+\d+(\/\d+)?(\s|$)/;
export function failLines(gate) {
  return (gate?.lines ?? []).map(clean).filter((t) => (t.startsWith('❌') && !ZERO_FAIL.test(t) && !COUNT.test(t)) || /^Fix:/.test(t));
}
export function measuredLines(gates) {
  return (gates ?? []).flatMap((g) => (g.lines ?? []).map(clean))
    .filter((t) => /^⚠️\s+\S+ .*: Figma .*, rendered |while disabled \(/.test(t));
}

// state: { failing: [gate], scope: [names], handback: { code, figma }, burndownNext, baselineWritten: { count, file },
//         toBuild: { tokens, file, theme, components } (build mode), cmd }
export function nextStep({ failing = [], scope = [], handback = {}, burndownNext = null, baselineWritten = null, toBuild = null, build = false, cmd = 'rms-design-system-engine' } = {}) {
  const rerun = scope.length ? `${cmd} --component ${scope.join(',')}` : cmd;
  if (baselineWritten) return `NEXT: tell the user ${baselineWritten.file} now holds the accepted debt; commit it only when they ask.`;
  // Build mode, one component checked: it is being built from Figma, so a failure is part of building it, not a
  // difference for the person to decide (a build run reported its tag's wrong height instead of fixing it).
  if (failing.length && build && scope.length) {
    const g = failing[0];
    return `NEXT: you are building ${scope.join(', ')} from Figma: fix each ❌ line under "${gateName(g.label)}"${failing.length > 1 ? ` (and ${failing.length - 1} more failing gate${failing.length > 2 ? 's' : ''})` : ''} the way it says (Figma's value wins), then run ${rerun} again until it passes. Tell the person only what you could not fix.`;
  }
  if (failing.length) {
    const g = failing[0];
    return `NEXT: tell the user what fails under "${gateName(g.label)}"${failing.length > 1 ? ` (and ${failing.length - 1} more failing gate${failing.length > 2 ? 's' : ''})` : ''} and the fix it names. Change the code only when they ask for that fix, then run ${rerun}. To accept a known difference instead: ${cmd} --baseline --findings (only when they ask).`;
  }
  if (handback.code) return `NEXT: show the user ${handback.code}; apply it only when they ask (git apply ${handback.code}), then run ${rerun}.`;
  if (handback.figma) return `NEXT: show the user ${handback.figma}, the changes to make in Figma. Nothing is changed in Figma by the skill.`;
  // Build mode: what is built matches; build the next thing, tokens first, then one component at a time.
  if (toBuild?.tokens) return `NEXT: build the tokens: copy the declarations in ${toBuild.file} into ${toBuild.theme ?? 'the theme CSS'}, then run ${cmd}.`;
  if (toBuild?.components?.length) {
    const c = toBuild.components[0];
    // Only what the person asked for: once it is built, the next component waits for them to ask (a build evaluation
    // run built every component when it was asked for the tokens, and ran out of turns before it answered).
    const left = toBuild.components.join(', ');
    return `NEXT: what is built matches Figma. If the person asked for ${c} (or for every component), build it: run ${cmd} --query ${c} for what it needs, write it with those names, then run ${cmd} --component ${c} until it passes. Otherwise stop here and tell them what is built and what is still to build (${left}).`;
  }
  if (burndownNext && !scope.length) return `NEXT: ${cmd} --component ${burndownNext}`;
  return 'NEXT: nothing to do. Parity holds for what was checked.';
}

// The plain summary. verdict: 'failed' | 'debt' | 'pass' | 'baseline' (the run wrote the baseline).
// The state of the Figma data, said once, so no one has to infer it (idea I56): whether this run refreshed anything
// from the Figma API, and how old the committed snapshots it used are. An agent relays it; it never claims a
// refresh the engine did not make. snapshots: [{ file, ageHours }] (ageHours null when unreadable).
export function dataStateLine({ refreshedFromApi = false, fromFigmaCli = null, snapshots = [], cmd = 'rms-design-system-engine' } = {}) {
  if (fromFigmaCli) return `**Figma data.** Variables, component props and structure were read from ${fromFigmaCli.file}${fromFigmaCli.source ? ` (${fromFigmaCli.source})` : ''}, written by figma-cli, in this run.`;
  const known = snapshots.filter((s) => Number.isFinite(s.ageHours));
  const age = (h) => (h < 24 ? 'updated today' : `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? '' : 's'} old`);
  const oldest = known.length ? known.reduce((a, b) => (b.ageHours > a.ageHours ? b : a)) : null;
  const missing = snapshots.filter((s) => !Number.isFinite(s.ageHours)).map((s) => s.file);
  const used = oldest ? `the committed snapshots (the oldest, ${oldest.file}, ${age(oldest.ageHours)})` : 'no readable snapshot';
  const gap = missing.length ? ` Not readable: ${missing.join(', ')}.` : '';
  if (refreshedFromApi) return `**Figma data.** Component properties and values were refreshed from the Figma API in this run; variables and structure come from ${used}.${gap}`;
  return `**Figma data was not refreshed in this run.** The audit used ${used}.${gap} To refresh them: ${cmd} --recipe refresh-figma.`;
}

// only: { words, a11y: { static, browser } | null } when the run was --only: the summary says what ran, so a part
// never reads as the whole system.
export function buildSummary({ verdict, gates = [], scope = [], burndown = [], next, notRun = 0, baselineWritten = null, data = null, only = null, toBuild = null } = {}) {
  const lines = [];
  const failing = gates.filter((g) => !g.pass && !g.planLimited && !g.baselined);
  const debt = gates.filter((g) => g.baselined);
  lines.push(`# ${only && !gates.length ? 'Accessibility result' : 'Parity result'}${scope.length ? ` for ${scope.join(', ')}` : ''}`, '');
  lines.push(verdict === 'baseline' ? `**Baseline written.** ${baselineWritten?.count ?? 0} failing item${baselineWritten?.count === 1 ? '' : 's'} recorded as accepted debt in ${baselineWritten?.file ?? 'design-system-engine-baseline.json'}; from now on only new ones fail.`
    : verdict === 'failed' ? `**Not in parity.** ${failing.length} of ${gates.length} gate${gates.length === 1 ? ' fails' : 's fail'}.`
    : verdict === 'debt' ? `**No regressions.** ${debt.length} gate${debt.length === 1 ? '' : 's'} carry accepted debt.`
      : only && !gates.length ? '**Accessibility checked.** Its findings are advice: the report lists each with its fix.'
      : toBuild ? `**What is built matches Figma.** Every gate that ran passes${notRun ? ` (${notRun} not verified)` : ''}; the rest is still to build.`
      : `**In parity.** Every gate that ran passes${notRun ? ` (${notRun} not verified)` : ''}.`);
  if (only) {
    lines.push('', `Only ${only.words} ran in this run; nothing else was checked.`);
    if (only.a11y) {
      const n = (x) => (x == null ? null : `${x} finding${x === 1 ? '' : 's'}`);
      const parts = [only.a11y.static != null ? `${n(only.a11y.static)} from the code` : null, only.a11y.browser != null ? `${n(only.a11y.browser)} in the browser` : 'the browser part did not run (no page or no Chrome)'].filter(Boolean);
      lines.push(`Accessibility: ${parts.join(', ')}.`);
    }
  }
  if (data) lines.push('', data);
  for (const g of verdict === 'baseline' ? [] : failing) {
    const f = failLines(g);
    lines.push('', `- **${gateName(g.label)}** fails:`);
    for (const t of f.slice(0, 5)) lines.push(/^Fix:/.test(t) ? `    - ${t}` : `  - ${t.replace(/^❌\s*/, '')}`);
    if (f.length > 5) lines.push(`  - and ${f.length - 5} more`);
  }
  const measured = measuredLines(gates);
  if (measured.length) {
    lines.push('', `**Measured differences** (rendered in the browser, advisory): ${measured.length}`);
    for (const t of measured.slice(0, 8)) lines.push(`- ${t.replace(/^⚠️\s*/, '')}`);
    if (measured.length > 8) lines.push(`- and ${measured.length - 8} more`);
  }
  if (burndown.length) {
    lines.push('', burndown[0].replace(/^📉\s*/, ''));
    const up = burndown.find((l) => /^\s*next up:/.test(l));
    if (up) lines.push(`Fix first: ${up.trim().replace(/^next up:\s*/, '')}`);
  }
  if (toBuild) lines.push('', toBuild);
  if (next) lines.push('', next);
  return lines.join('\n') + '\n';
}
