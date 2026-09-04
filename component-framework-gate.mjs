// component-framework-gate.mjs — decide whether the component-prop / composition gates apply.
//
// These two gates only make sense for a component FRAMEWORK codebase (Vue/React with declared
// props and instance nesting). A DS *consumer* that implements the components as CSS classes +
// markup (a plain-HTML plugin, say) has no prop-components for them to match, so every DS
// component reports "no code file" and the gates would hard-fail a codebase they don't apply to.
//
// Returns a skip reason string (→ the gate should SKIP, neutral) or null (→ run the gate):
//   • frameworkComponents === false in ds-config → the project opted out.
//   • status === 2 → the gate's opt-in snapshot was never captured (composition), which is an
//     opt-out, not a misconfiguration.

export function frameworkGateSkipReason(frameworkComponents, status) {
  if (frameworkComponents === false)
    return 'ds-config frameworkComponents:false (DS components implemented as CSS/markup, not prop-based framework components).';
  if (status === 2)
    return 'snapshot not captured (opt-in). Run the Plugin API capture and commit it to enable.';
  return null;
}
