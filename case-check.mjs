// case-check.mjs — Gate: no text casing the DS doesn't define.
//
// Figma text styles here carry no forced casing, so a `text-transform:
// uppercase | lowercase | capitalize` in the token / component CSS is INVENTED
// styling that drifts from Figma (real case: a `.group-label` "uppercase group
// heading" that had no Figma text style behind it, and spread into two plugins).
// This catches that class of drift at the source — the same "no all-caps" rule
// the docs-truth gate enforces on a styleguide, applied to the DS CSS itself.
//
// A DS that genuinely defines an upper/lower/title text style (Figma textCase)
// exempts it via `ds-config.json → knownTextTransforms` — either the casing word
// ("uppercase") to allow it everywhere, or a "<file>:<line>" to allow one spot.
//
// Requires at project root: ds-config.json (paths.themeCSS, paths.pluginCSS).
// Exit 0 = no unbacked casing.  Exit 1 = drift found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); }
catch { console.error('❌ ds-config.json not found.'); process.exit(1); }

const files = [
  ...[cfg.paths?.themeCSS ?? 'src/theme.css'].flat(),
  ...((cfg.paths?.pluginCSS ?? []).flat()),
].filter((p) => p && !/^https?:\/\//.test(p));
const exempt = new Set((cfg.knownTextTransforms ?? []).map((s) => String(s).toLowerCase()));

const findings = [];
for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const css = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '); // strip comments
  const re = /text-transform\s*:\s*(uppercase|lowercase|capitalize)/gi;
  let m;
  while ((m = re.exec(css))) {
    const line = css.slice(0, m.index).split('\n').length;
    const word = m[1].toLowerCase();
    if (exempt.has(word) || exempt.has((rel + ':' + line).toLowerCase())) continue;
    findings.push({ file: rel, line, transform: word });
  }
}

if (!findings.length) { console.log('✅ [text-case] no text-transform the DS doesn\'t define'); process.exit(0); }
console.log(`❌ [text-case] ${findings.length} text-transform not backed by a Figma text style — the DS defines no such casing:`);
for (const f of findings) console.log(`  • ${f.file}:${f.line} — text-transform: ${f.transform}`);
console.log('  Fix: remove it (match Figma), or, if a Figma text style really has this casing, exempt it in ds-config.json → knownTextTransforms.');
process.exit(1);
