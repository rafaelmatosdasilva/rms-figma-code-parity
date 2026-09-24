// pair-derive.mjs - derive text/background contrast pairs from token NAMES (I14).
//
// I28 checks WCAG contrast for text/bg token pairs, but only ones the project AUTHORS in
// a11y.tokenPairs - authored data someone must maintain. Most DSes already encode the role in the
// token NAME by convention (`menuList/text/default/color`, `menuList/background/hover/color`), so
// the pairs can be DERIVED: within one component, pair each text/label/icon token with the background
// token that shares its qualifier (state or variant), falling back to the component's default/only
// background. Component-scoped + qualifier-matched, so it never explodes into every-text × every-bg.
// A component with no background token is skipped (we never invent the surface it sits on). Pure.

const TEXT_ROLES = new Set(['text', 'label', 'content', 'foreground', 'fg', 'icontext', 'caption', 'title', 'heading', 'placeholder', 'link']);
const ICON_ROLES = new Set(['icon', 'iconprimary', 'iconsecondary', 'stroke']);   // non-text: WCAG 3:1 (large)
const BG_ROLES   = new Set(['background', 'bg', 'fill', 'surface', 'container']);

// tokenNames: the color token keys for one mode (names are mode-independent; values are resolved per
// mode later by the caller). Returns [{ name, text, bg, large }] - text/bg are exact token names.
export function deriveContrastPairs(tokenNames) {
  const byComp = new Map();
  for (const name of (tokenNames || [])) {
    if (typeof name !== 'string') continue;
    const segs = name.split('/');
    if (segs.length < 3 || segs[segs.length - 1] !== 'color') continue;   // need comp/role/.../color
    const comp = segs[0];
    const role = segs[1].toLowerCase();
    const qualifier = segs.slice(2, -1).join('/');                        // between role and "color"
    let b = byComp.get(comp);
    if (!b) { b = { texts: [], bgs: [] }; byComp.set(comp, b); }
    if (TEXT_ROLES.has(role))      b.texts.push({ token: name, qualifier, large: false });
    else if (ICON_ROLES.has(role)) b.texts.push({ token: name, qualifier, large: true });
    else if (BG_ROLES.has(role))   b.bgs.push({ token: name, qualifier });
  }

  const pairs = [];
  const seen = new Set();
  for (const [, { texts, bgs }] of byComp) {
    if (!texts.length || !bgs.length) continue;
    const bgByQual = new Map(bgs.map((x) => [x.qualifier, x.token]));
    const fallbackBg = bgByQual.get('default') ?? bgByQual.get('') ?? (bgs.length === 1 ? bgs[0].token : null);
    for (const t of texts) {
      const bg = bgByQual.get(t.qualifier) ?? fallbackBg;
      if (!bg || bg === t.token) continue;
      const key = `${t.token}|${bg}`;
      if (seen.has(key)) continue; seen.add(key);
      pairs.push({ name: `${t.token} on ${bg}`, text: t.token, bg, large: t.large });
    }
  }
  return pairs;
}
