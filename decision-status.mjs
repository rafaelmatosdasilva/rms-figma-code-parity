// decision-status.mjs - per-component decision status + the *why* (I33).
//
// The problem it kills: an agent composing from the DS finds TWO right answers and no note saying
// which one won (an old component kept beside its replacement). Status is the easy half; the *why*
// is the field an agent actually needs. So each component contract may carry:
//
//   status: { state: 'current' | 'deprecated' | 'experimental', supersededBy?, since?, rationale?, source }
//
// Where the data comes from (agnostic, never invented, zero-config = nothing emitted):
//   1. AUTHORED  - contract.authored.json → components[name]: { status, supersededBy, since, rationale }
//   2. CAPTURED  - the Figma component description, ONLY if the DS already uses a tag convention:
//                  @deprecated [why…] · @experimental · @status <state> · @use-instead <Name>
//                  (aliases @superseded-by / @supersededBy / @replaced-by) · @since <x> · @why / @rationale <text>
// Authored wins per field; the captured description fills the gaps. Nothing is imposed: a DS that
// writes no tags and authors nothing gets no status field at all.
//
// statusFindings() then checks the decisions against each other (advisory, never fails): a pointer
// at a component that does not exist, a replacement that is itself deprecated, a deprecation with
// neither a replacement nor a reason, and - the "two right answers" case - guidance or composition
// that still sends an agent to a deprecated component.

export const STATES = ['current', 'deprecated', 'experimental'];

const TAG_RE = /@(deprecated|experimental|status|use-instead|useinstead|superseded-by|supersededby|replaced-by|since|why|rationale)\b[ \t]*:?[ \t]*([^\n@]*)/gi;

// Parse the tag convention out of a free-text description. Returns {} when no tag is present.
export function parseStatusTags(description) {
  const out = {};
  if (typeof description !== 'string' || !description.includes('@')) return out;
  for (const m of description.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase().replace(/-/g, '');
    const val = m[2].trim().replace(/[.;,]\s*$/, '');
    if (tag === 'deprecated') { out.state = 'deprecated'; if (val && !out.rationale) out.rationale = val; }
    else if (tag === 'experimental') out.state = 'experimental';
    else if (tag === 'status') { const s = val.toLowerCase().split(/\s+/)[0]; if (STATES.includes(s)) out.state = s; }
    else if (tag === 'useinstead' || tag === 'supersededby' || tag === 'replacedby') { const t = val.split(/[\s,]+/)[0]; if (t) out.supersededBy = t; }
    else if (tag === 'since') { if (val) out.since = val.split(/\s+/)[0]; }
    else if (tag === 'why' || tag === 'rationale') { if (val) out.rationale = val; }
  }
  // A replacement implies the old one is deprecated, unless the DS said otherwise.
  if (out.supersededBy && !out.state) out.state = 'deprecated';
  return out;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// Merge authored fields (win) over tags parsed from the captured description. null = nothing said.
export function resolveStatus(authored, description) {
  const a = authored || {};
  const aStatus = a.status && typeof a.status === 'object' ? a.status : null;   // tolerate { status: { state, … } }
  const fromA = {
    state: str(aStatus ? aStatus.state : a.status)?.toLowerCase(),
    supersededBy: str(aStatus?.supersededBy ?? a.supersededBy),
    since: str(aStatus?.since ?? a.since),
    rationale: str(aStatus?.rationale ?? a.rationale),
  };
  if (fromA.state && !STATES.includes(fromA.state)) fromA.state = undefined;   // lintAuthored reports it
  const fromF = parseStatusTags(description);
  const out = {};
  for (const k of ['state', 'supersededBy', 'since', 'rationale']) {
    const v = fromA[k] ?? fromF[k];
    if (v !== undefined) out[k] = v;
  }
  if (!Object.keys(out).length) return null;
  if (!out.state) out.state = out.supersededBy ? 'deprecated' : 'current';
  const hasA = Object.values(fromA).some((v) => v !== undefined);
  const hasF = Object.keys(fromF).length > 0;
  out.source = hasA && hasF ? 'authored+figma' : hasA ? 'authored' : 'figma';
  return out;
}

// One human line for llms.txt / reports: "deprecated · use Foo instead · since 2.0 · why: …".
export function statusLine(status) {
  if (!status) return '';
  const bits = [status.state];
  if (status.supersededBy) bits.push(`use ${status.supersededBy} instead`);
  if (status.since) bits.push(`since ${status.since}`);
  if (status.rationale) bits.push(`why: ${String(status.rationale).replace(/\s+/g, ' ').trim()}`);
  return bits.join(' · ');
}

// Shape checks for the authored fields (surfaced beside the other contract.authored.json issues).
export function lintStatusFields(name, entry) {
  const issues = [];
  if (!entry || typeof entry !== 'object') return issues;
  if ('status' in entry) {
    const s = entry.status && typeof entry.status === 'object' ? entry.status.state : entry.status;
    if (typeof s !== 'string' || !STATES.includes(s.trim().toLowerCase()))
      issues.push(`${name}.status must be one of ${STATES.join(' | ')}`);
  }
  for (const k of ['supersededBy', 'since', 'rationale'])
    if (k in entry && typeof entry[k] !== 'string') issues.push(`${name}.${k} must be a string`);
  return issues;
}

// Cross-check every component's decision against the others. built = [{ name, contract }].
export function statusFindings(built) {
  const byName = new Map(built.map((b) => [b.name, b.contract]));
  const stateOf = (n) => byName.get(n)?.status?.state;
  const out = [];
  for (const { name, contract } of built) {
    const st = contract?.status;
    if (st) {
      const to = st.supersededBy;
      if (to === name) out.push({ kind: 'self', component: name, msg: `${name} is superseded by itself` });
      else if (to && !byName.has(to)) out.push({ kind: 'unknown-target', component: name, msg: `${name} points at "${to}", which is not a DS component` });
      else if (to && stateOf(to) === 'deprecated') {
        // Follow the chain to the component that actually won, so the fix names it.
        const seen = new Set([name]); let cur = to;
        while (stateOf(cur) === 'deprecated' && byName.get(cur)?.status?.supersededBy && !seen.has(cur)) { seen.add(cur); cur = byName.get(cur).status.supersededBy; }
        out.push({ kind: 'chain', component: name, msg: `${name} is superseded by ${to}, which is itself deprecated${cur !== to && byName.has(cur) && stateOf(cur) !== 'deprecated' ? ` (point it at ${cur})` : ''}` });
      }
      if (st.state === 'deprecated' && !st.supersededBy && !st.rationale)
        out.push({ kind: 'not-legible', component: name, msg: `${name} is deprecated with no replacement and no reason, so an agent cannot tell what won or why` });
    }
    // The "two right answers" case: live guidance that still sends an agent to a deprecated component.
    if (stateOf(name) === 'deprecated') continue;   // a deprecated parent nesting another is expected
    for (const target of (contract?.useInstead || []))
      if (stateOf(target) === 'deprecated') out.push({ kind: 'guidance-to-deprecated', component: name, msg: `${name} says use ${target} instead, but ${target} is deprecated${byName.get(target).status.supersededBy ? ` (use ${byName.get(target).status.supersededBy})` : ''}` });
    for (const child of (contract?.relationships?.composesWith || []))
      if (stateOf(child) === 'deprecated') out.push({ kind: 'composes-deprecated', component: name, msg: `${name} still composes deprecated ${child}${byName.get(child).status.supersededBy ? ` (replace with ${byName.get(child).status.supersededBy})` : ''}` });
  }
  return out;
}
