// css-values.mjs - read CSS values the way a browser means them, so two spellings of the same value
// compare equal: #fff and #ffffff, rgb() / hsl() / oklch() / color(srgb …) and hex, 0.5rem and 8px,
// 200ms and 0.2s. Pure, no dependencies. Anything it cannot read returns null, and the caller keeps
// its own exact comparison (never a guess).

const NAMED = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1] };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const pct = (s, of = 1) => (String(s).trim().endsWith('%') ? (num(s) / 100) * of : num(s));
const alpha = (s) => (s == null ? 1 : clamp(pct(s, 1), 0, 1));
const args = (inner) => inner.replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean);

// sRGB 0..1 from linear light
const gamma = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [gamma(r), gamma(g), gamma(bb)].map((x) => clamp(x, 0, 1) * 255);
}

// Any CSS colour → [r, g, b, a] (r/g/b 0..255, a 0..1), or null.
export function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) return [...NAMED[s]];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i) => parseInt(h.slice(i, i + 2), 16);
    return [v(0), v(2), v(4), h.length === 8 ? +(v(6) / 255).toFixed(4) : 1];
  }
  m = s.match(/^(rgba?|hsla?|oklch|oklab|color)\((.*)\)$/);
  if (!m) return null;
  const [fn, inner] = [m[1], m[2]];
  const parts = args(inner);
  const slash = parts.indexOf('/');
  const main = slash === -1 ? parts : parts.slice(0, slash);
  const channels = fn === 'color' ? 4 : 3;   // color() names its space first
  const a = slash === -1 ? (main.length === channels + 1 ? main[channels] : null) : parts[slash + 1];
  if (fn === 'rgb' || fn === 'rgba') {
    const [r, g, b] = main.slice(0, 3).map((x) => pct(x, 255));
    return [r, g, b].some((x) => x == null) ? null : [r, g, b, alpha(a)];
  }
  if (fn === 'hsl' || fn === 'hsla') {
    const h = num(main[0]), sa = pct(main[1], 1), l = pct(main[2], 1);
    if ([h, sa, l].some((x) => x == null)) return null;
    return [...hslToRgb(h, sa, l), alpha(a)];
  }
  if (fn === 'oklch') {
    const L = pct(main[0], 1), C = pct(main[1], 0.4), H = num(main[2]) ?? 0;
    if (L == null || C == null) return null;
    const rad = (H * Math.PI) / 180;
    return [...oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad)), alpha(a)];
  }
  if (fn === 'oklab') {
    const L = pct(main[0], 1), A = pct(main[1], 0.4), B = pct(main[2], 0.4);
    if ([L, A, B].some((x) => x == null)) return null;
    return [...oklabToRgb(L, A, B), alpha(a)];
  }
  if (fn === 'color' && main[0] === 'srgb') {
    const [r, g, b] = main.slice(1, 4).map((x) => pct(x, 1));
    return [r, g, b].some((x) => x == null) ? null : [r * 255, g * 255, b * 255, alpha(a)];
  }
  return null;   // display-p3 and other spaces: not converted (reported as not comparable by callers)
}

// Canonical hex: #rrggbb, or #rrggbbaa when not opaque. null when unreadable.
export function colorHex(input) {
  const c = parseColor(input);
  if (!c) return null;
  const h = (x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 1 ? h(c[3] * 255) : '');
}

// Same colour? Channels within 1/255 (rounding across colour spaces), alpha within 0.01.
export function sameColor(a, b) {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return null;
  return Math.abs(x[0] - y[0]) <= 1 && Math.abs(x[1] - y[1]) <= 1 && Math.abs(x[2] - y[2]) <= 1 && Math.abs(x[3] - y[3]) <= 0.01;
}

// A length in CSS px: px, rem (rootPx, default 16), em (emPx), pt, and calc() of those added or
// subtracted. Unitless numbers are returned only with { unitless: true }. null when unreadable.
export function lengthPx(input, { rootPx = 16, emPx = rootPx, unitless = false } = {}) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  const calc = s.match(/^calc\((.*)\)$/);
  if (calc) s = calc[1];
  const terms = s.match(/[+-]?\s*[\d.]+[a-z%]*/g);
  if (!terms || terms.join('').replace(/\s+/g, '') !== s.replace(/\s+/g, '')) return null;
  if (!calc && terms.length > 1) return null;
  let total = 0;
  for (const t of terms) {
    const m = t.replace(/\s+/g, '').match(/^([+-]?[\d.]+)([a-z%]*)$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = m[2];
    if (u === 'px') total += n;
    else if (u === 'rem') total += n * rootPx;
    else if (u === 'em') total += n * emPx;
    else if (u === 'pt') total += (n * 96) / 72;
    else if (u === '' && (unitless || n === 0)) total += n;
    else return null;
  }
  return +total.toFixed(4);
}

// A duration in ms: ms or s. null when unreadable.
export function timeMs(input) {
  const m = String(input ?? '').trim().toLowerCase().match(/^([\d.]+)(ms|s)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? +(m[2] === 's' ? n * 1000 : n).toFixed(4) : null;
}

// Do two scalar values mean the same? true / false, or null when neither reading applies.
// kind: 'length' (unitless numbers count as px, as Figma floats are px), 'time', 'color', 'any'.
export function sameValue(a, b, kind = 'any', opts = {}) {
  const sa = String(a ?? '').trim(), sb = String(b ?? '').trim();
  if (sa === sb) return true;
  if (kind === 'color' || kind === 'any') { const c = sameColor(sa, sb); if (c !== null) return c; }
  if (kind === 'time' || kind === 'any') { const x = timeMs(sa), y = timeMs(sb); if (x !== null && y !== null) return Math.abs(x - y) < 0.01; }
  if (kind === 'length' || kind === 'any') {
    const u = kind === 'length';
    const x = lengthPx(sa, { ...opts, unitless: u }), y = lengthPx(sb, { ...opts, unitless: u });
    if (x !== null && y !== null) return Math.abs(x - y) < 0.01;
  }
  const x = Number(sa), y = Number(sb);
  if (sa !== '' && sb !== '' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 1e-6;
  return null;
}

// Easing curves: keywords and cubic-bezier() compared by their four numbers (so ".4" = "0.4" and
// "ease-in-out" = "cubic-bezier(0.42, 0, 0.58, 1)"). null when either is not a curve.
const EASE = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
export function bezierOf(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (EASE[s]) return EASE[s];
  const m = s.match(/^cubic-bezier\(([^)]*)\)$/);
  if (!m) return null;
  const n = m[1].split(',').map((x) => parseFloat(x));
  return n.length === 4 && n.every(Number.isFinite) ? n : null;
}
export function sameEasing(a, b) {
  const x = bezierOf(a), y = bezierOf(b);
  if (!x || !y) return null;
  return x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
}
