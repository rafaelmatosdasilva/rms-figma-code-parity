// markup-source.mjs - the structural fingerprint of an app's markup: element ids, the DS component
// classes on interactive elements, icon references with their nearest context, and each button's
// inner structure.
//
// This reading used to live inside html-structure-check.mjs. The markup gate and the code capture
// now share it. Pure.

export function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

// Find the nearest ancestor id or DS class context for a <use> element, walking back up to 600 chars.
function nearestContext(html, useIdx, dsClasses) {
  const before = html.slice(Math.max(0, useIdx - 600), useIdx);
  const tags = [...before.matchAll(/<([a-z]+)([^>]*)>/gi)];
  for (let i = tags.length - 1; i >= 0; i--) {
    const attrs = tags[i][2];
    const idM = /\bid="([^"]+)"/.exec(attrs);
    if (idM) return `#${idM[1]}`;
    const clsM = /\bclass="([^"]*)"/.exec(attrs);
    if (clsM) {
      const cls = clsM[1].split(/\s+/).find((c) => dsClasses.has(c));
      if (cls) return `.${cls}`;
    }
  }
  return '(root)';
}

// fingerprint(html, dsClasses:Set) → { ids, components, icons, buttonContent }
export function fingerprint(html, dsClasses) {
  const static_html = stripScripts(html);

  // All element IDs (exclude generated/empty)
  const ids = [...static_html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).filter((id) => id.trim());

  // DS component classes on interactive elements
  const components = [];
  const tagRe = /<(button|div|span)[^>]*\bclass="([^"]*)"[^>]*>/gi;
  let tm;
  while ((tm = tagRe.exec(static_html)) !== null) {
    const ds = tm[2].split(/\s+/).filter((c) => dsClasses.has(c));
    if (!ds.length) continue;
    const idM = /\bid="([^"]+)"/.exec(tm[0]);
    components.push({ id: idM ? idM[1] : null, classes: ds.sort() });
  }

  // <use href="#icon-X"> with context
  const icons = [];
  const useRe = /<use\s+href="#([^"]+)"/g;
  let um;
  while ((um = useRe.exec(static_html)) !== null) {
    if (!um[1].startsWith('icon-')) continue;
    icons.push({ context: nearestContext(static_html, um.index, dsClasses), icon: um[1] });
  }

  // Button inner structure - catches spurious text labels, extra spans, or missing icons.
  // For each <button id="X"> with a static (non-template) ID: svg (direct <svg>), spans (class
  // names on <span> children, sorted), text (visible text after stripping tags).
  const buttonContent = [];
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bm;
  while ((bm = btnRe.exec(static_html)) !== null) {
    const idM = /\bid="([^"]+)"/.exec(bm[1]);
    if (!idM) continue;
    const btnId = idM[1];
    if (/["'+${}]/.test(btnId)) continue; // skip JS-template IDs
    const inner = bm[2];
    buttonContent.push({
      id: btnId,
      svg: /<svg\b/i.test(inner),
      spans: [...inner.matchAll(/<span\b[^>]*\bclass="([^"]*)"[^>]*>/gi)].map((m) => m[1].trim()).sort(),
      text: inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    });
  }

  return { ids, components, icons, buttonContent };
}

// Which classes count as DS component classes. ds-config.json → htmlStructureClasses when set.
// Otherwise the classes the project's saved markup snapshot already fingerprints, so a project
// keeps its result without a config edit. Returns { classes:Set, from: 'config'|'snapshot'|'none' }.
export function markupClassSet(cfg = {}, stored = {}) {
  if (Array.isArray(cfg.htmlStructureClasses)) return { classes: new Set(cfg.htmlStructureClasses), from: 'config' };
  const fromSnap = new Set();
  for (const [k, app] of Object.entries(stored ?? {})) {
    if (k.startsWith('_') || !Array.isArray(app?.components)) continue;
    for (const c of app.components) for (const cls of c?.classes ?? []) if (typeof cls === 'string') fromSnap.add(cls);
  }
  return fromSnap.size ? { classes: fromSnap, from: 'snapshot' } : { classes: new Set(), from: 'none' };
}
