// structure-contract.mjs — Copy to your PROJECT ROOT and fill in your DS component contracts.
// This file is consumed by structure-check.mjs.

// ─── Structural contract (ground-truth per component, State=Default variant) ──
// Captured from live Figma via /rms-parity Phase 1.
// Fields:
//   h              — height in px, or 'auto'
//   paddingVar     — { tb: 'padding/token', lr: 'padding/token' } or null
//   gapVar         — 'gap/token' or null
//   fontSizeVar    — scale key ('m', 's', 'l') or null
//   fontWeightVar  — scale key or null
//   fillStructure  — 'direct' | 'before' | 'none'
//                    'before' = fill is on a child Background rect → CSS ::before
//   innerRadiusVar — 'radii/token' or null
//   strokeOnDefault — true if Figma State=Default has a stroke
//   strokeSides    — 'bottom' | 'all' (optional). When set, Gate [3b] enforces which
//                    CSS border sides are used. 'bottom' → requires border-bottom, forbids
//                    the border: shorthand. 'all' → requires the border: shorthand.
//                    Omit when the component has no stroke (strokeOnDefault: false).
//   hoverPill      — { innerH, radiusVar, insetH } (optional). When set, Gate [3d]
//                    verifies the ::before pseudo-element geometry:
//                      innerH    — pill height in px (outer h minus vertical inset × 2)
//                      radiusVar — Figma token for border-radius (e.g. 'radii/button')
//                      insetH    — horizontal inset in px (0 = full outer width, no side gap)
//   children       — [{ name, cssSelector, gapVar?, paddingVar? }] (optional). Inner Figma
//                    frames with their own bound gap/padding. Gate [3f] verifies the CSS
//                    selector uses the matching var; the snapshot cross-check verifies the
//                    contracted values still match Figma (childFrameGaps/childFramePadding).
//                    cssSelector: null = frame is flattened into the parent (gap/padding on
//                    the root rule or geometric) — CSS lookup skipped, cross-check still runs.
export const CONTRACT = {
  // Example:
  // button: {
  //   h: 32,
  //   paddingVar: { tb: 'padding/s', lr: 'padding/m' },
  //   gapVar: 'gap/s',
  //   fontSizeVar: 'm', fontWeightVar: 'm',
  //   fillStructure: 'direct', innerRadiusVar: 'radii/button',
  //   strokeOnDefault: false,
  //   children: [
  //     { name: 'content', cssSelector: '.button-content', gapVar: 'gap/m', paddingVar: { tb: null, lr: null } },
  //   ],
  // },
};

// ─── CSS height/min-height rules to verify ────────────────────────────────────
// For each component with a fixed height, verify the CSS selector enforces it.
export const CSS_HEIGHT_RULES = {
  // Example:
  // button: { selector: '.button', prop: 'height' },
};

// ─── CSS base-rule var bindings to verify ────────────────────────────────────
// For multi-state components, verify the correct var is wired into the base rule.
// This catches "right value, wrong var" (e.g. --node-label instead of --node-label-unselected).
export const CSS_BASE_RULE_VARS = [
  // Example:
  // { key: 'node/label', selector: '.node', prop: 'color', expectedVar: '--node-label-unselected' },
];

// ─── Figma layout token → CSS var mapping ────────────────────────────────────
// Maps Figma sizing token paths to the CSS var that must appear in the rule.
// Used by structure-check.mjs property binding checks (Gate [3]).
// Only add entries for tokens that have a dedicated CSS var in your system.
export const FIGMA_LAYOUT_TO_CSS = {
  // 'gap/xs':      '--gap-xs',
  // 'gap/s':       '--gap-s',
  // 'gap/m':       '--gap-m',
  // 'gap/l':       '--gap-l',
  // 'gap/xl':      '--gap-xl',
  // 'padding/xxs': '--padding-xxs',
  // 'padding/xs':  '--padding-xs',
  // 'padding/s':   '--padding-s',
  // 'padding/m':   '--padding-m',
  // 'padding/l':   '--padding-l',
  // 'radii/button':  '--radius-full',
  // 'radii/tooltip': '--radius-tooltip',
};

// ─── Font scale key → CSS var mapping ────────────────────────────────────────
// Keys match the fontSizeVar / fontWeightVar values in CONTRACT above.
export const FONT_SCALE_TO_CSS = {
  // 'm': { size: '--m-size', weight: '--m-weight' },
  // 's': { size: '--s-size', weight: '--s-weight' },
  // 'l': { size: '--l-size', weight: '--l-weight' },
};

// ─── Per-component CSS selector config ───────────────────────────────────────
// Used by the property binding checks in Gate [3].
//   main        — selector for gap, padding, font, radius (default)
//   gapSel      — override for gap (e.g. gap only in a state sub-rule)
//   fontSel     — override for font-size/weight (e.g. font on a child element)
//   radiusSel   — override for border-radius (e.g. on ::before pseudo-element)
//   skipTBPadding — omit top/bottom padding check (height-based layout, no tb padding in CSS)
export const COMPONENT_CSS_SELECTORS = {
  // button: { main: '.button' },
  // input:  { main: '.inputWrap', fontSel: '.inputField', skipTBPadding: true },
  // card:   { main: '.card', radiusSel: '.card::before' },
};

// ─── CSS property assertions (Gate [3e]) ─────────────────────────────────────
// Guards plugin-specific selectors that aren't in CONTRACT but must stay in sync
// with DS geometry. Each entry: { sel, prop, expected|present|expectedVar }.
//   expected    — exact CSS value string (e.g. '40px', '4px 0')
//   present     — boolean: property must (true) or must NOT (false) appear in that block
//   expectedVar — property must use var(expectedVar) (e.g. '--radius-full')
// Use for plugin-level wrappers that mirror a DS component's geometry.
export const CSS_PROPERTY_ASSERTIONS = [
  // Example: a .listRow wrapper that mirrors the buttonList DS component
  // { sel: '.listRow',         prop: 'height',        expected:    '40px'          },
  // { sel: '.listRow',         prop: 'border-bottom', present:     true            },
  // { sel: '.listRow',         prop: 'border',        present:     false           },
  // { sel: '.listRow::before', prop: 'inset',         expected:    '4px 0'         },
  // { sel: '.listRow::before', prop: 'border-radius', expectedVar: '--radius-full' },
];

// ─── Sub-component isolation: documented broad rules ────────────────────────
// Consumed by subcomponent-isolation-check.mjs (Gate [8]).
// Key   = normalized CSS selector (single spaces, no leading/trailing whitespace).
// Value = isolation proof category:
//   LEAF             — no DS sub-component ever nests inside this component
//   ISOLATED         — explicit sub-component overrides appear later in the cascade
//   NON-VISUAL       — rule sets only layout/motion properties (no color/fill/stroke)
//   OWNED CHILDREN   — children are native HTML elements, not DS sub-components
//   ISOLATION FIX    — this rule IS the isolation override for a parent's broad rule
//   PLUGIN-SPECIFIC  — product-level wrapper; children are not DS components
//   DECORATIVE       — icon/illustration slot with no DS sub-components
export const ALLOWED_BROAD_RULES = {
  // '.buttonTertiary svg': 'LEAF — leaf component; no nested DS sub-component',
  // '.node svg': 'ISOLATED — sub-component override rules appear later in cascade',
};

// ─── Figma state/variant → CSS selector + var binding mapping ─────────────────
// Full verification chain per state (Gate [3]):
//   1. The CSS selector exists in your source files (theme CSS or plugin CSS)
//   2. The selector's rule uses the correct token var for each declared property
//   3. That token var resolves to the correct hex — Gate [2] covers this
//
// Fields:
//   component  — matches a key in CONTRACT above
//   figmaState — Figma variant property value (e.g. 'Hover', 'Disabled', 'Small')
//   selector   — CSS selector that activates this state in code
//   vars       — array of { prop, expectedVar }
//                prop        — CSS property name (e.g. 'background-color', 'color')
//                expectedVar — token var that MUST be used for this prop in this rule
//
// If vars is omitted, only selector existence is verified.
// If vars is present, both existence AND correct var binding are verified.
export const STATE_SELECTORS = [
  // {
  //   component:  'button',
  //   figmaState: 'Hover',
  //   selector:   '.button:hover',
  //   vars: [
  //     { prop: 'background-color', expectedVar: '--button-background-hover' },
  //     { prop: 'color',            expectedVar: '--button-text-hover' },
  //   ],
  // },
  // {
  //   component:  'button',
  //   figmaState: 'Disabled',
  //   selector:   '.button[disabled]',
  //   vars: [
  //     { prop: 'background-color', expectedVar: '--button-background-disabled' },
  //     { prop: 'color',            expectedVar: '--button-text-disabled' },
  //     { prop: 'border-color',     expectedVar: '--button-border-disabled' },
  //   ],
  // },
  // {
  //   component:  'input',
  //   figmaState: 'Focus',
  //   selector:   '.input:focus-within',
  //   vars: [
  //     { prop: 'border-color', expectedVar: '--input-border-focus' },
  //   ],
  // },
  // {
  //   component:  'input',
  //   figmaState: 'Error',
  //   selector:   '.input.error',
  //   vars: [
  //     { prop: 'border-color', expectedVar: '--input-border-error' },
  //     { prop: 'color',        expectedVar: '--input-label-error' },
  //   ],
  // },
  // {
  //   component:  'checkbox',
  //   figmaState: 'Selected',
  //   selector:   '.checkbox[checked]',
  //   vars: [
  //     { prop: 'background-color', expectedVar: '--checkbox-background-selected' },
  //     { prop: 'border-color',     expectedVar: '--checkbox-border-selected' },
  //   ],
  // },
];

// ─── Surface container enforcement (Gate [3h]) ────────────────────────────────
// Lists every surface container in your plugin/app that components can be
// placed inside. Gate [3h] verifies that each selector declares
// `--area-bg: var(--bgVar)` in CSS, so components using `var(--area-bg, fallback)`
// automatically inherit the correct surface background.
//
// Fields:
//   sel   — CSS selector for the surface container
//   bgVar — the CSS custom property this surface uses for its background
export const SURFACE_CONTAINERS = [
  // { sel: '.main-panel',   bgVar: '--bg'           },
  // { sel: '.detail-panel', bgVar: '--bg-secondary'  },
];
