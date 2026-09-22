// fix-hint.mjs - contract-aware fix citations (feature #1).
//
// A failure should not only say a value is wrong; it should point at the MACHINE-READABLE source of
// truth the rest of the toolchain (and any AI agent) can consume without guessing: the token's real
// name, its verified value, and the emitted file that declares it. Pure and degrade-safe - with no
// emitted contracts it still names the token and its convention var; with them it cites the exact
// value and the file. Never throws. Reused by parity-check (and available to any gate).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Token "radii/button" -> CSS var "--radii-button" (the naming convention: the default the code is
// expected to use). Project-specific EXPLICIT overrides live in parity-map and are not needed here;
// this is only the citation's suggested var, never a match decision.
export function tokenVar(name) {
  const parts = String(name || '').split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length ? '--' + parts.join('-') : null;
}

// Walk a DTCG dictionary by a "a/b/c" (or "a.b.c") token name to its $value leaf. Returns the value
// as a string (objects - e.g. a typography composite - are JSON-stringified), or null when the path
// does not resolve to a leaf. Depth-bounded by the name; never throws on odd shapes.
export function resolveTokenValue(dict, name) {
  if (!dict || typeof dict !== 'object' || !name) return null;
  const parts = String(name).split(/[/.]/).map((s) => s.trim()).filter(Boolean);
  let node = dict;
  for (const p of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[p];
  }
  if (!node || typeof node !== 'object' || node.$value == null) return null;
  const v = node.$value;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Load the emitted DTCG dictionary once (or null when it has not been generated yet). Degrade-safe.
export function loadTokensDict(root, contractsDir) {
  try {
    const f = join(contractsDir || join(root || '.', 'contracts'), 'tokens.json');
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch { return null; }
}

// Build the one-line source citation for a token failure. Names the token and the convention var,
// and - when the emitted dictionary is present and the token resolves - the verified value plus the
// file that declares it, so a fix can be applied (or generated) against real facts, not a guess.
export function tokenSource(name, { dict = null, contractsDir = 'contracts' } = {}) {
  if (!name) return '';
  const varName = tokenVar(name);
  const varPart = varName ? ` -> var(${varName})` : '';
  const value = dict ? resolveTokenValue(dict, name) : null;
  return value != null
    ? `Source: token '${name}'${varPart} = ${value}  (${contractsDir}/tokens.json)`
    : `Source: token '${name}'${varPart}  (see ${contractsDir}/tokens.json)`;
}
