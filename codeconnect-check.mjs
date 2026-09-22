// codeconnect-check.mjs - validate Figma Code Connect mappings against the contract (I31).
//
// Code Connect is a DOWNSTREAM artifact - it can be wrong or stale (per McKinsey QBDS: "do NOT seed
// [truth] from it"). So we never SOURCE truth from it, and - importantly - we NEVER call the plan-gated
// Code Connect REST API (publish/read is Figma Enterprise/Org only). We only READ committed *.figma.tsx
// files already in the repo (whatever the user's own `figma connect` tooling wrote) and diff their
// mappings against the emitted contracts, flagging entries that are stale or invalid. The join is by
// Figma NODE ID (the connect URL's node-id vs contract.figmaNodeId) - no name guessing. Advisory only.
//
// Detected, never imposed: with no *.figma.* files (or the API-only Enterprise setup and nothing
// committed locally) this does not run and any-plan projects are byte-identical.

// Normalize a Figma node id from any form (789-35349, 789:35349, 789%3A35349) to canonical "789:35349".
export function normalizeNodeId(raw) {
  if (!raw) return null;
  const m = String(raw).replace(/%3A/gi, ':').match(/(\d+)[:\-](\d+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// Extract the balanced { … } object that starts at-or-after `from` in `text`. Returns the inner body
// string, or '' when there is no object. Brace-counting, string-aware enough for typical CC files.
function objectAfter(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return '';
}

// Top-level keys of an object body ("small: 'sm', 'Large Size': 'lg'" -> ['small','Large Size']).
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, i = 0;
  const atTop = () => depth === 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (atTop()) {
      const m = body.slice(i).match(/^(['"]?)([A-Za-z0-9 _-]+)\1\s*:/);
      if (m) { keys.push(m[2].trim()); i += m[0].length; continue; }
    }
    i++;
  }
  return keys;
}

// Parse one Code Connect source file's text into connect entries:
//   [{ component, nodeId, props: [{ figmaProp, kind, options? }] }]
// figma.enum/boolean/string/instance calls are associated with the nearest preceding figma.connect.
export function parseCodeConnect(text) {
  if (typeof text !== 'string' || !text.includes('figma.connect')) return [];
  const connects = [];
  { const re = /figma\.connect\(\s*([A-Za-z_$][\w$.]*)\s*,\s*(['"`])([^'"`]*)\2/g; let m;
    while ((m = re.exec(text))) connects.push({ index: m.index, component: m[1], nodeId: normalizeNodeId(m[3]), props: [] }); }
  if (!connects.length) return [];

  const ownerOf = (idx) => { let owner = connects[0]; for (const c of connects) { if (c.index <= idx) owner = c; else break; } return owner; };

  const re = /figma\.(enum|boolean|string|instance)\(\s*(['"`])([^'"`]+)\2\s*(,)?/g;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1], figmaProp = m[3];
    const prop = { figmaProp, kind };
    if (kind === 'enum' && m[4]) prop.options = topLevelKeys(objectAfter(text, re.lastIndex));
    ownerOf(m.index).props.push(prop);
  }
  return connects;
}

// Compare parsed entries against the emitted contracts (array of contract objects). Joins by node id.
// Findings (each advisory): 'no-contract' (maps a node with no matching contract), 'unknown-prop'
// (a Figma property the contract does not have), 'unknown-option' (an enum option not in the contract).
export function codeConnectFindings(entries, contracts) {
  const byNode = new Map();
  for (const c of (contracts || [])) if (c && c.figmaNodeId) byNode.set(normalizeNodeId(c.figmaNodeId), c);

  const findings = [];
  let checked = 0, matched = 0;
  for (const e of (entries || [])) {
    checked++;
    const contract = e.nodeId ? byNode.get(e.nodeId) : null;
    if (!contract) { findings.push({ component: e.component, nodeId: e.nodeId, kind: 'no-contract' }); continue; }
    matched++;
    const props = Array.isArray(contract.props) ? contract.props : [];
    const validProp = new Set(props.map((p) => p.bindings?.figma?.property || p.name).filter(Boolean));
    const optionsOf = new Map(props.map((p) => [p.bindings?.figma?.property || p.name, new Set(p.options || [])]));
    for (const mp of (e.props || [])) {
      if (!validProp.has(mp.figmaProp)) { findings.push({ component: e.component, nodeId: e.nodeId, kind: 'unknown-prop', figmaProp: mp.figmaProp }); continue; }
      if (mp.kind === 'enum' && Array.isArray(mp.options)) {
        const valid = optionsOf.get(mp.figmaProp) || new Set();
        if (valid.size) for (const opt of mp.options) if (!valid.has(opt)) findings.push({ component: e.component, nodeId: e.nodeId, kind: 'unknown-option', figmaProp: mp.figmaProp, option: opt });
      }
    }
  }
  return { findings, checked, matched };
}
