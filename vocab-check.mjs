// vocab-check.mjs - closed-vocabulary / raw-container advisory (I16).
//
// Opt-in and project-declared (never imposed): runs only when ds-config.json declares
//   "closedVocab": { "bannedTags": ["div","span"], "surfaces": ["src/App.vue", …], "suggest": "use <Box as>" }
// It counts raw HTML container tags the project chose to ban, in the declared surfaces, so a team that
// wants "typed primitive, not a raw <div>" can watch that trend. Advisory - the engine SURFACES the
// count (governance is the team's call), it never fails. Pure + testable.

// Count opening tags for each banned tag name. A word-boundary lookahead means `<div` does NOT match
// inside `<divider>` (the char after the name must be whitespace, `/` or `>`).
export function scanBannedContainers(text, bannedTags) {
  const counts = {};
  const src = String(text || '');
  for (const tag of bannedTags || []) {
    const name = String(tag).replace(/^</, '').replace(/>$/, '').trim();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = src.match(new RegExp(`<${esc}(?=[\\s/>])`, 'gi'));
    if (m && m.length) counts[name] = m.length;
  }
  return counts;
}
