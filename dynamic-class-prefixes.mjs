// dynamic-class-prefixes.mjs — extract the trailing class-name prefixes of strings that are
// spliced with `+` or `${…}` at runtime, e.g. `'buttonList issue-item t-' + iss.type`. Gate 5's
// dead-CSS-class check uses these to avoid flagging a dynamically-built class as unused.
//
// Why the bound matters: the source corpus includes the minified plugin `ui.html`, which embeds
// large single-string data blobs (a base64 ICC profile, data: URIs). An UNBOUNDED `[^'"]*?` /
// `[^`$}]*` lets a single match attempt scan such a blob end-to-end and retry at every offset —
// O(n²) over hundreds of KB, which pins the CPU and (being synchronous) hangs the whole audit.
// A real class-name prefix is a handful of characters, so we cap each scan at PREFIX_SCAN_CAP:
// the capture can't span a data blob, the scan is linear, and no genuine prefix is missed.
export const PREFIX_SCAN_CAP = 200;

export function extractDynamicClassPrefixes(corpus) {
  const fragments = [
    // '…prefix-' +   and   "…prefix-" +
    ...[...corpus.matchAll(new RegExp(`['"]([^'"]{0,${PREFIX_SCAN_CAP}}?)['"]\\s*\\+`, 'g'))].map(m => m[1]),
    // `…prefix-${expr}`
    ...[...corpus.matchAll(new RegExp(`([^\`$}]{0,${PREFIX_SCAN_CAP}})\\$\\{`, 'g'))].map(m => m[1]),
  ];
  return fragments
    .map(frag => frag.match(/([a-zA-Z][\w-]*-)$/)?.[1])
    .filter(Boolean);
}
