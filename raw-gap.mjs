// raw-gap.mjs — match a CSS `gap` value against a raw (unbound) DS inner-frame gap in px.
//
// A DS inner frame whose children sit flush (auto-layout gap 0) or use a raw px gap has no gap
// *token*, so it never appeared in the token-only childFrameGaps check and the code could drift
// (add a stray gap) unnoticed. A `children` contract entry pins the raw value with `gapPx`, and
// Gate [3f] uses this to assert the CSS renders the same literal.
//
//   rawGapMatches('0',   0) → true      rawGapMatches('4px', 0) → false
//   rawGapMatches('0px', 0) → true      rawGapMatches('4px', 4) → true
//   rawGapMatches(null,  0) → false     rawGapMatches('4',   4) → false  (px unit required for >0)

export function rawGapMatches(cssGapValue, gapPx) {
  if (cssGapValue == null) return false;
  const got = String(cssGapValue).trim();
  return gapPx === 0 ? (got === '0' || got === '0px') : got === `${gapPx}px`;
}
