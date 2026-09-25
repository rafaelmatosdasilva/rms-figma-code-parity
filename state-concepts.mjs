// state-concepts.mjs - which interaction concept a state is (idea I40). A design system names its
// states its own way ("State=Pressed", "isDisabled=True", "Status=Error"); the checks need the
// concept: hover, active, focus, disabled, selected, error.
//
// ds-config.json → states maps each concept to the Figma prop (and value) that expresses it:
//   "states": { "hover": { "prop": "State", "value": "Hover" }, "disabled": { "prop": "isDisabled" } }
// A prop without a value is a boolean: true means the state. A concept the project does not declare
// falls back to reading the names, as before: a boolean prop is read by its name only when true
// ("isDisabled=True" is disabled, "isDisabled=False" is not), an enum by its value.

export const CONCEPTS = ['disabled', 'error', 'selected', 'focus', 'active', 'hover'];
// Order matters: "inactive" is disabled before it could look like active.
const HEURISTIC = [
  ['disabled', /disabled|inactive/i], ['error', /error|invalid/i], ['selected', /selected|checked|current/i],
  ['focus', /focus/i], ['active', /active|pressed/i], ['hover', /hover/i],
];
const TRUE = /^(true|yes|on)$/i, FALSE = /^(false|no|off)$/i;
const axesOf = (label) => String(label).split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2);

export function conceptOf(label, cfg = {}) {
  const pairs = axesOf(label);
  const declared = cfg.states && typeof cfg.states === 'object' ? cfg.states : {};
  for (const [concept, spec] of Object.entries(declared)) {
    if (!spec?.prop) continue;
    const hit = pairs.some(([k, v]) => k.toLowerCase() === String(spec.prop).toLowerCase()
      && (spec.value == null ? TRUE.test(v) : v.toLowerCase() === String(spec.value).toLowerCase()));
    if (hit) return concept;
  }
  for (const [k, v] of pairs) {
    if (FALSE.test(v)) continue;
    const text = TRUE.test(v) ? k : v;
    for (const [concept, re] of HEURISTIC) if (!declared[concept] && re.test(text)) return concept;
  }
  return null;
}
