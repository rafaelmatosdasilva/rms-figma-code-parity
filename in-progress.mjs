// in-progress.mjs - work in progress is not drift (idea I52).
//
// A component on only one side is not a difference while the project says it is still being made:
//   • it is in ds-config.json → knownUnimplementedComponents (not built yet), or
//   • its decision status (I33: contract.authored.json, or a tag in the Figma description) is experimental.
// Such a component is listed as in progress and never fails a gate. An experimental component that is now
// on both sides is compared as usual; a knownUnimplementedComponents entry that is now on both sides is
// reported, so the owner can take it off the list (the list is the owner's, never edited here).
//
// Every gate that skips unbuilt components reads `await inProgressNames(ROOT, cfg)` instead of the bare list.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveStatus } from './decision-status.mjs';
import { loadLocator } from './component-locator.mjs';

const readJson = (ROOT, p) => { try { return JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')); } catch { return null; } };

// The component names each side has: Figma (the structure and props snapshots) and code (a CSS rule for
// the component's class, or a contract entry with a selector).
async function sides(ROOT, cfg) {
  const struct = readJson(ROOT, cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json')?.components ?? {};
  const props = readJson(ROOT, cfg.paths?.compPropsSnapshot ?? 'src/figma-component-props.snapshot.json') ?? {};
  const figma = new Set([...Object.keys(struct), ...Object.keys(props)].filter((n) => !n.startsWith('_')));
  const css = [cfg.paths?.themeCSS ?? 'src/theme.css', ...(cfg.paths?.pluginCSS ?? [])].flat()
    .map((p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return ''; } }).join('\n');
  const locator = await loadLocator(ROOT, cfg);
  const inCode = (name) => {
    const cls = locator.classFor(name);
    if (!cls) return false;
    const esc = String(cls).replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.${esc}(?![\\w-])`).test(css);
  };
  return { figma, inCode, props };
}

// [{ name, why, figma, code, ready }]: ready means it is on both sides now.
export async function inProgressList(ROOT, cfg = {}) {
  const authored = readJson(ROOT, cfg.contracts?.authored ?? 'contract.authored.json')?.components ?? {};
  const known = cfg.knownUnimplementedComponents ?? [];
  const { figma, inCode, props } = await sides(ROOT, cfg);
  const names = new Set([...known, ...Object.keys(authored), ...Object.keys(props).filter((n) => !n.startsWith('_'))]);
  const out = [];
  for (const name of names) {
    const status = resolveStatus(authored[name], props[name]?.description);
    const why = known.includes(name) ? 'not built yet' : status?.state === 'experimental' ? 'experimental' : null;
    if (!why) continue;
    const f = figma.has(name), c = inCode(name);
    out.push({ name, why, figma: f, code: c, ready: f && c });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The names every gate skips: the knownUnimplementedComponents list as the owner wrote it, plus the
// experimental components that are still on one side only.
export async function inProgressNames(ROOT, cfg = {}) {
  let list = [];
  try { list = await inProgressList(ROOT, cfg); } catch { /* the bare list still applies */ }
  return new Set([...(cfg.knownUnimplementedComponents ?? []), ...list.filter((x) => x.why === 'experimental' && !x.ready).map((x) => x.name)]);
}

export function sideLabel(x) {
  return x.figma && x.code ? 'in Figma and in code' : x.figma ? 'only in Figma' : x.code ? 'only in code' : 'on neither side yet';
}
