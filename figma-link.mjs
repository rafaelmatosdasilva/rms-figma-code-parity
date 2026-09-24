// figma-link.mjs - a finding that names a component also links to it in Figma, so the reader opens
// the exact node instead of searching the file for it.
//
// The node ids come from the snapshots the audit already has (structure and component props); the
// file key from ds-config figmaFileKey. No network, no token: when either is missing, no link.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function figmaLink(fileKey, nodeId) {
  if (!fileKey || !nodeId) return null;
  return `https://www.figma.com/design/${fileKey}?node-id=${String(nodeId).replace(/:/g, '-')}`;
}

// { componentName: nodeId } from the structure snapshot, then the props snapshot for the rest.
export function figmaNodeIds(root, cfg) {
  const ids = {};
  const read = (p) => { try { return JSON.parse(readFileSync(join(root, p), 'utf8')); } catch { return null; } };
  const st = read(cfg.paths?.snapshotStructure ?? 'figma-structure.snapshot.json');
  for (const [k, v] of Object.entries(st?.components ?? st ?? {})) if (!k.startsWith('_') && v?.nodeId) ids[k] = v.nodeId;
  const pr = read(cfg.paths?.compPropsSnapshot ?? 'figma-component-props.snapshot.json');
  for (const [k, v] of Object.entries(pr ?? {})) if (!k.startsWith('_') && v?.nodeId && !ids[k]) ids[k] = v.nodeId;
  return ids;
}

// A resolver for one run: linkFor('chip') → the URL, or null.
export function figmaLinker(root, cfg) {
  const ids = figmaNodeIds(root, cfg);
  return (name) => figmaLink(cfg.figmaFileKey, ids[name]);
}
