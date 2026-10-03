// route.mjs - the request, as the person wrote it, routed by the engine to a recipe and the exact command
// (idea I56: "if a decision can be made deterministically, the model does not make it").
//
//   rms-design-system-engine --route "<the request, as written>"
//
// The agent's first step for every request. Picking the recipe, the scope and the command was the model's
// decision, and the evaluation showed smaller models get it wrong (a question answered from memory, the wrong
// recipe, a pasted step list followed or asked about). Here it is a fixed table, tested, the same on any
// model, in English and Portuguese. route() is pure: projectState() reads the project for it.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// What the router needs from the project: is there a config, which components, when the snapshots were
// captured (the oldest _updated stamp, as a date), and the command to write (the engine's path when the
// terminal command is not on PATH).
export function projectState(ROOT, { engineDir, env = process.env } = {}) {
  const hasConfig = existsSync(join(ROOT, 'ds-config.json'));
  let conf = {};
  try { conf = hasConfig ? JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')) : {}; } catch { /* unreadable: the defaults */ }
  const read = (rel) => { try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); } catch { return null; } };
  const structure = read(conf.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json');
  const vars = read(conf.paths?.snapshotVars ?? 'src/figma-vars.snapshot.json');
  const stamps = [structure?._updated, vars?._updated].filter(Boolean).map((u) => new Date(u)).filter((d) => !Number.isNaN(d.getTime()));
  const oldest = stamps.length ? new Date(Math.min(...stamps)) : null;
  const onPath = String(env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, 'rms-design-system-engine')));
  return {
    hasConfig,
    build: conf.build === true,
    pages: uiFiles(ROOT),
    rawColours: rawColoursOf(structure?.components ?? {}),
    components: Object.keys(structure?.components ?? {}),
    snapshotDate: oldest ? oldest.toISOString().slice(0, 10) : null,
    cmd: onPath || !engineDir ? 'rms-design-system-engine' : `node ${join(engineDir, 'audit.mjs')}`,
  };
}

// The colours each Figma component paints with no variable bound: { tag: ['Tone=Positive #d6f5e3, #136c3a'] }.
export function rawColoursOf(components = {}) {
  const out = {};
  const hexes = (colors) => Object.values(colors ?? {}).filter((c) => c?.hex && !c.token).map((c) => c.hex.toLowerCase());
  for (const [name, c] of Object.entries(components)) {
    const list = [];
    if (hexes(c?.colors).length) list.push(`${hexes(c.colors).join(', ')}`);
    for (const [vk, v] of Object.entries(c?.variants ?? {})) if (hexes(v?.colors).length) list.push(`${vk} ${hexes(v.colors).join(', ')}`);
    if (list.length) out[name] = list;
  }
  return out;
}

// The project's UI files (pages, screens, components), so a request that names a page by its name ("the gallery
// page") is told which file that is. Bounded: the first 400, skipping dependencies, builds and the engine's own files.
const UI_FILE = /\.(html?|jsx|tsx|vue|svelte|astro)$/i;
const NOT_UI_DIR = /^(node_modules|\.git|dist|build|out|coverage|\.next|\.design-system-engine-out|\.claude|contracts|test|tests|__tests__|figma-mcp)$/;
export function uiFiles(ROOT, limit = 400) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!NOT_UI_DIR.test(e.name)) walk(join(dir, e.name)); }
      else if (UI_FILE.test(e.name) && !/\.(test|spec|stories)\./.test(e.name)) out.push(relative(ROOT, join(dir, e.name)).split('\\').join('/'));
    }
  };
  walk(ROOT);
  return out.sort();
}

// The UI files whose path names a word of the request ("gallery" → apps/gallery/ui.html). Words that name a component,
// or say nothing about a place (page, screen, button…), do not count.
const PLACE_STOP = new Set(['page', 'pages', 'screen', 'screens', 'view', 'file', 'component', 'components', 'next', 'small', 'large', 'green', 'blue', 'with', 'from', 'that', 'this', 'there', 'where', 'add', 'make', 'build', 'create', 'show', 'index', 'main', 'app', 'apps', 'src', 'pagina', 'tela']);
export function pagesNamed(text, pages = [], components = []) {
  const comp = new Set(components.flatMap((c) => [c.toLowerCase(), ...c.split(/(?=[A-Z])|[-_ ]/).map((x) => x.toLowerCase())]));
  const words = new Set((String(text).toLowerCase().match(/[a-zà-ú][a-zà-ú0-9]{3,}/g) ?? []).filter((w) => !PLACE_STOP.has(w) && !comp.has(w)));
  if (!words.size) return [];
  const hits = pages.map((p) => ({ p, n: p.toLowerCase().split(/[\/._-]+/).filter((seg) => words.has(seg)).length })).filter((h) => h.n > 0);
  const best = Math.max(0, ...hits.map((h) => h.n));
  return hits.filter((h) => h.n === best).map((h) => h.p).slice(0, 3);
}

// A component named in the request: its name as written in the snapshot, or split at camel case, hyphens and
// underscores ("statusBar" is also "status bar" and "status-bar").
export function namedComponents(text, components = []) {
  const t = ` ${String(text).toLowerCase()} `;
  const found = [];
  for (const name of components) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().trim();
    const forms = new Set([name.toLowerCase(), words, words.replace(/ /g, '-'), words.replace(/ /g, '')]);
    if ([...forms].some((f) => f && new RegExp(`[^a-z0-9]${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?[^a-z0-9]`).test(t))) found.push(name);
  }
  return found;
}

const QUESTION = /^\s*(how|why|what|where|when|which|can i|should i|is there|como|porqu[eê]|porque|o que|onde|quando|qual|quais|d[aá] para|posso)\b|\?\s*$/i;
const LINK = /https?:\/\/(?:[\w.-]*gitlab[\w.-]*|[\w.-]*notion\.(?:so|site))\/\S+/i;
const links = (t) => t.match(new RegExp(LINK.source, 'gi')) ?? [];
const FIGMA_URL = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[\w-]+\S*/i;
const STEP_LIST = /(^|\s)1[.)]\s[\s\S]*\s2[.)]\s/;

// Each rule: [recipe, test, what to run, a note]. First match wins; the order is part of the contract (tested).
const BUILD_VERB = /\b(build|create|implement|generate|code|constr[oó]i\w*|cria\w*|implementa\w*|gera\w*)\b/i;
const TO_CODE = /\b(turn|convert|transforma\w*|converte\w*)\b[\s\S]{0,60}\b(into|in|em)\s+(real\s+)?(code|components?|c[oó]digo|componentes)\b/i;
// A prototype ("prototype a settings page", "mock up a checkout with our components"): made only of the system's
// components, checked and drawn by the engine; what the system lacks is listed, never invented.
export const PROTOTYPE = /\b(prototyp\w*|mock[\s-]?ups?|wireframes?|prot[oó]tipos?|maquet\w*)\b/i;
const RULES = [
  ['guidelines-links', (t) => LINK.test(t)],
  ['prototype', (t) => PROTOTYPE.test(t) && !/\b(in|no|na)\s+figma(?![-\w/.])/i.test(t)],
  // Building from Figma (a project that has only Figma, or a component Figma has and the code does not yet):
  // the engine lists what to build and checks each piece; the agent writes it with the names and values it prints.
  ['build-from-figma', (t, s) => (TO_CODE.test(t) || BUILD_VERB.test(t) && (/\bfrom (the )?(figma|design)\b|\bdo figma\b|design system|sistema de design|\btokens?\b|\b(components?|componentes?)\b|\binto code\b|em c[oó]digo/i.test(t) || (s.build && s.named.length > 0))) && !/\b(in|no|na)\s+figma(?![-\w/.])/i.test(t)],
  ['fix-a-difference', (t) => /\b(change|set|make|update|muda|mudar|altera|alterar|p[oõ]e|coloca)\w*\b[\s\S]{0,60}\b(in|no|na)\s+figma(?![-\w/.])|\bfigma\b[\s\S]{0,30}\b(to|para)\s+\d/i.test(t), 'figma'],
  ['refresh-figma', (t) => /maxSnapshotAgeDays|go(es)? green|fica(r)? verde|raise the (age|limit)/i.test(t), 'forbidden-green'],
  // Before accept-debt: "que valores aceita o size" asks what a prop accepts, it accepts no debt.
  ['ask-the-system', (t) => QUESTION.test(t) && /\b(props?|propriedades?|values?|valores?|tokens?|variables?|vari[aá]ve(l|is)|names?|nomes?)\b/i.test(t) && !/debt|d[ií]vida|baseline/i.test(t)],
  ['accept-debt', (t) => /\baccept|known (debt|difference)|as debt|d[ií]vida|aceit/i.test(t)],
  ['fix-a-difference', (t) => /\b(fix|correct|repair|corrig|conserta|repara|resolve)\w*/i.test(t) && !QUESTION.test(t)],
  // New UI to build ("add a Saved confirmation next to the Save button"): the names come from the system, never from
  // memory, and a value the system does not have is said, not invented (I62). Not a note, not Figma, not debt.
  ['ask-the-system', (t) => /\b(add|create|build|make|put|insert|show|acrescent\w*|adicion\w*|cria\w*|constr[oó]i\w*|p[oõ]e|coloca\w*|mostra\w*)\b/i.test(t) && /\b(confirmation|message|badge|banner|toast|button|link|label|page|screen|section|row|card|list|menu|modal|dialog|form|field|header|footer|empty state|tooltip|confirma[çc][ãa]o|mensagem|p[aá]gina|ecr[ãa]|sec[çc][ãa]o|linha|bot[ãa]o|cart[ãa]o|lista|formul[aá]rio|campo|estado vazio)s?\b/i.test(t) && !/figma|\bnotes?\b|\bnotas?\b|baseline|debt|d[ií]vida|config/i.test(t) && !QUESTION.test(t), 'build-ui'],
  // Only a part of the run: the accessibility check, the Figma checks, or some gates (--only). Before the notes
  // recipe: "check the accessibility of the button" asks for the check, "how do I note its role" for the recipe.
  ['audit-component', (t) => onlyPart(t) != null, 'only'],
  ['a11y-notes', (t) => /\bnotes?\b|\bnotas?\b|annotat|anota|toggle|\brole\b|\baria\b|accessib|acessib|alt text|screen reader|leitor de ecr/i.test(t)],
  ['visual-diff', (t) => /\bimages?\b|imagem|imagens|visual|screenshot|pixel/i.test(t)],
  ['burndown', (t) => /fix first|first to fix|what first|primeiro|prioridad|priorit|work .{0,20}down|next up/i.test(t)],
  ['states-and-variants', (t) => /hover|disabled|desativad|desabilitad|\bstates?\b|estado|variant|combina|pressed|focus|selected/i.test(t)],
  ['refresh-figma', (t) => /refresh|atualiz|snapshot|stale|desatualiz|design (has )?changed|mudou|changed in figma/i.test(t)],
  ['ci-and-hooks', (t) => /\bci\b|webhook|git hook|pipeline|pre-?commit|pre-?push|\bhooks?\b/i.test(t)],
  ['first-setup', (t) => /\bset ?up\b|configur|install/i.test(t)],
];

// Sentences the agent says as written, so what it can and cannot do is never its own wording.
export const SAY = {
  figma: 'I can\'t change Figma: this skill only reads it. A person makes that change in the Figma editor; the audit below shows the Figma value and the code value.',
  noVariable: (name, list) => `Figma paints ${name} (${list.join('; ')}) with colours that have no variable: the code writes them as Figma has them, and the design system has no token for them yet.`,
  noRefresh: (date) => `I couldn't refresh the Figma snapshots here: there is no Figma tool in this session. The audit below uses the committed snapshots${date ? ` (captured ${date})` : ''}, so a change made in Figma after that is not in it. To refresh them, connect the Figma MCP server to Claude Code, or set FIGMA_TOKEN in the project's .env file; never paste a token in the chat.`,
};

// route(text, { hasConfig, components, cmd, snapshotDate }) → { recipe, question, run: [commands], notes: [lines], say: [lines], sayIf }
export function route(text, { hasConfig = true, components = [], cmd = 'rms-design-system-engine', snapshotDate = null, build = false, pages = [], rawColours = {} } = {}) {
  const r = routeOnly(text, { hasConfig, components, cmd, build, pages });
  const say = [];
  let sayIf = null;
  // Building a component Figma paints with a colour that has no variable: the person hears it, in the reply.
  if (r.recipe === 'build-from-figma' || r.kind === 'build-ui') for (const n of namedComponents(text, components)) if (rawColours[n]) say.push(SAY.noVariable(n, rawColours[n]));
  if (r.kind === 'figma') say.push(SAY.figma);
  if (r.recipe === 'refresh-figma' && r.kind !== 'forbidden-green') {
    r.notes.push('A refresh needs a Figma tool in this session (the Figma MCP use_figma tool) for the capture in the recipe below. With it, capture first, then run the command. Without it, do not offer a refresh and never edit a snapshot.');
    sayIf = 'when there is no Figma tool in this session';
    say.push(SAY.noRefresh(snapshotDate));
  }
  delete r.kind;
  return { ...r, say, sayIf };
}

function routeOnly(text, { hasConfig, components, cmd, build = false, pages = [] }) {
  const t = String(text ?? '');
  const question = QUESTION.test(t);
  const named = namedComponents(t, components);
  const scoped = named.length ? `${cmd} --component ${named.join(',')}` : cmd;
  const notes = [];

  // A pasted step list: take only the intent. The skill owns setup, running and reporting.
  if (STEP_LIST.test(t)) {
    notes.push('The request lists steps: do not follow them. The skill does setup, the run and the report itself; report in the chat, write no report file, commit nothing.');
    return { recipe: hasConfig ? (named.length ? 'audit-component' : 'full-audit') : 'first-setup', question: false, run: hasConfig ? [scoped] : setupRun(t, cmd, notes), notes };
  }
  if (!hasConfig && !LINK.test(t)) return { recipe: 'first-setup', question, run: setupRun(t, cmd, notes), notes };

  for (const [recipe, test, kind] of RULES) {
    if (!test(t, { build, named })) continue;
    if (recipe === 'build-from-figma') {
      notes.push('Build from Figma: the engine says what to build, in order (tokens first, then each component after the ones it nests), and checks each piece. Write the code only with the names, classes and values the engine prints (--query for a component); write no value Figma does not have: use the closest one the system has and say so, or ask. After each piece, run the scoped check until it passes. Commit nothing unless asked.');
      return { recipe, question, run: question ? [] : named.length ? [`${cmd} --query ${named.join(' ')}`] : [cmd], notes };
    }
    if (recipe === 'guidelines-links') return { recipe, question, run: [`${cmd} --guidelines ${links(t).join(' ')}`], notes };
    if (recipe === 'prototype') {
      notes.push('A prototype is made only of the design system\'s components with their own options, and the engine\'s layout pieces; never write HTML, CSS or a component for it, and never change the system\'s files. Write it as a composition in prototypes/<name>.json, run --prototype on it, and fix each ❌ line until it is drawn. A need nothing fits is a Missing box; tell the person every gap it lists, as written.');
      // "What can a prototype use?" is answered by the catalog itself; only a how-to is answered from the recipe alone.
      if (question && /^\s*(how|why|como|porqu)/i.test(t)) return { recipe, question, run: [], notes };
      // "Are our prototype pages consistent?": every page against the others.
      if (/\b(consisten\w*|coeren\w*|match(es|ing)?|same as|alinhad\w*|iguais)\b/i.test(t) && (question || /\b(check|compare|verif\w*|compar\w*)\b/i.test(t))) return { recipe, question, run: [`${cmd} --prototype --consistency`], notes };
      return { recipe, question, run: [`${cmd} --prototype --catalog`], notes };
    }
    if (kind === 'figma') {
      notes.push('Nothing is ever changed in Figma by the skill, and it never offers to. Run the audit, then tell the person what to change in Figma.');
      return { recipe, question, run: [scoped], notes, kind };
    }
    if (kind === 'forbidden-green') {
      notes.push('Do not raise maxSnapshotAgeDays or edit ds-config.json to go green: that hides drift. Say so, and run the audit to show what really fails.');
      return { recipe, question: false, run: [cmd], notes, kind };
    }
    if (kind === 'only') {
      const part = onlyPart(t);
      notes.push(`Only ${part === 'accessibility' ? 'the accessibility check' : part === 'parity' ? 'the checks against Figma' : 'the gates asked for'} runs: report that part, and say the rest was not checked in this run.`);
      return { recipe: named.length ? 'audit-component' : 'full-audit', question: false, run: [`${scoped} --only ${/\s/.test(part) ? `'${part}'` : part}`], notes };
    }
    if (recipe === 'accept-debt') {
      // The difference the person named (the radius, not the rest): only the findings that name it are accepted.
      const match = debtWords(t);
      return { recipe, question, run: question ? [] : [`${scoped} --baseline --findings${match.length ? ` --match ${match.join(',')}` : ''}`], notes };
    }
    if (recipe === 'fix-a-difference') {
      notes.push('Fix exactly what was asked, in the code, at the file and line the audit names, and nothing else: list the other differences the audit shows and leave them as they are; then run the same audit again.');
      return { recipe, question, run: [scoped], notes };
    }
    if (recipe === 'burndown') return { recipe, question, run: [cmd], notes };
    if (recipe === 'ask-the-system') {
      const terms = [...named, ...(t.match(/(?:--[a-z][\w-]*|\b[a-z][\w-]*(?:\/[\w-]+)+)/gi) ?? [])];
      if (kind === 'build-ui') {
        notes.push('The person asks for new UI: build it, in the file they name, with the design system\'s own components, classes and CSS variables, their names exactly as the query prints them. Write no colour, size or variable the system does not have: the edit check hands back anything that is not the system\'s. When the system has no value for what is asked (a green where it has none), use the closest one it has and say so, or ask; never invent one.');
        const where = pagesNamed(t, pages, components);
        if (where.length === 1) notes.push(`The file the request names is ${where[0]}: build it there.`);
        else if (where.length) notes.push(`The request names one of these files: ${where.join(', ')}. Use the one that fits; ask only if none does.`);
        return { recipe, question: false, run: terms.length ? [`${cmd} --query ${terms.join(' ')}`] : [], notes };
      }
      if (!terms.length) notes.push('Ask which component or token, then run the query with it.');
      return { recipe, question, run: terms.length ? [`${cmd} --query ${terms.join(' ')}`] : [], notes };
    }
    if (recipe === 'first-setup') return { recipe, question, run: question ? [] : [`${cmd} --doctor`], notes };
    if (recipe === 'ci-and-hooks') return { recipe, question: true, run: [], notes };
    // A how-to question is answered from the recipe; a question about a named component's states needs the
    // audit's facts (the rule, file and line), so it runs the scoped audit too; anything else runs the audit.
    if (question && !(recipe === 'states-and-variants' && named.length)) return { recipe, question, run: [], notes };
    return { recipe, question, run: [scoped], notes };
  }
  return named.length ? { recipe: 'audit-component', question, run: [scoped], notes } : { recipe: 'full-audit', question, run: [cmd], notes };
}

function setupRun(t, cmd, notes) {
  const figma = t.match(FIGMA_URL)?.[0];
  const css = t.match(/[\w./-]+\.css\b/)?.[0];
  if (!figma) notes.push('Ask the person for the Figma file URL (and the token CSS file if the setup cannot find it), then run the command with it.');
  return [`${cmd} --init --figma-url='${figma ?? '<Figma file URL>'}'${css ? ` --theme-css='${css}'` : ''}`];
}

// A request for only part of the run → the --only value, or null. Accessibility asked for alone (or with "only"),
// the parity without accessibility, or some gates named with "only" (by name or number).
// Whole words, accents included (\b does not see "só" or "ícones" as words).
const word = (src) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`, 'iu');
const ONLY_WORD = word('only|just|solely|só|apenas|somente|unicamente');   // "só" with its accent: "so" is English
const A11Y_WORD = /\b(accessib\w*|acessib\w*|a11y)\b/i;
const NOTES_WORD = /\bnotes?\b|\bnotas?\b|annotat|anota|toggle|\brole\b|\baria\b|alt text|screen reader|leitor de ecr/i;
const HOW_TO = /^\s*(how|why|what does|what is|what's|como|porqu[eê]|porque|o que (é|e|significa))\b/i;
const NO_A11Y = word('(?:no|without|sem|except|exceto|menos)\\s+(?:the\\s+|a\\s+)?(?:accessib\\w*|acessib\\w*|a11y)');
const BOTH = word('parity|paridade|figma|tokens?|everything|tudo|whole|todo o|all gates|includ\\w*|inclu[ií]\\w*|as well|tamb[eé]m|also|too');
const GATE_WORDS = [
  [word('token values?|valores? d[oe]s? tokens?'), 'token values'],
  [word('states?|estados?'), 'states'],
  [word('props?|propriedades?'), 'props'],
  [word('structure|estrutura'), 'structure'],
  [word('icons?|[ií]cones?'), 'icons'],
  [word('markup'), 'markup'],
  [word('shadows?|sombras?'), 'shadows'],
  [word('motion|movimento'), 'motion'],
  [word('transitions?|transi[çc][õo]es?'), 'transitions'],
  [word('(?:dark|light) modes?|modes?|modos?'), 'mode'],
];
export function onlyPart(text) {
  const t = String(text ?? '');
  if (NOTES_WORD.test(t) || HOW_TO.test(t)) return null;   // a note to write, or how something works: the recipe, not a run
  if (NO_A11Y.test(t)) return 'parity';
  if (ONLY_WORD.test(t) && /\b(parity|paridade)\b/i.test(t) && !A11Y_WORD.test(t)) return 'parity';
  if (A11Y_WORD.test(t) && !NOTES_WORD.test(t) && !HOW_TO.test(t) && (ONLY_WORD.test(t) || !BOTH.test(t))) return 'accessibility';
  if (!ONLY_WORD.test(t)) return null;
  const nums = [...t.matchAll(/\bgates?\s*#?\s*(\d{1,2})\b/gi)].map((m) => m[1]);
  const named = GATE_WORDS.filter(([re]) => re.test(t)).map(([, w]) => w);
  return nums.length || named.length ? [...new Set([...nums, ...named])].join(',') : null;
}

// Words a person uses for a kind of difference → what the audit's lines say for it. Only these, so the engine,
// not the agent, decides what one named difference covers.
const DEBT_WORDS = [
  [/\b(radius|radii|corner|rounded|raio|cantos?|arredondad\w*)\b/i, 'radi'],
  [/\b(height|altura)\b/i, 'height'],
  [/\b(width|largura)\b/i, 'width'],
  [/\b(padding|preenchimento)\b/i, 'padding'],
  [/\b(gap|spacing|espa[cç]amento)\b/i, 'gap'],
  [/\b(colou?rs?|cor(es)?)\b/i, 'color'],
  [/\b(props?|propriedades?|prop names?)\b/i, 'props match'],
];
export function debtWords(text) {
  return DEBT_WORDS.filter(([re]) => re.test(String(text ?? ''))).map(([, w]) => w);
}

// What --route prints: the route, the commands, the notes, one NEXT line, and the recipe itself.
export function routeText(r, recipeText, cmd = 'rms-design-system-engine', { maxRecipe = null } = {}) {
  const lines = [`ROUTE: ${r.recipe}`];
  for (const c of r.run) lines.push(`RUN: ${c}`);
  for (const n of r.notes) lines.push(`NOTE: ${n}`);
  for (const s of r.say ?? []) lines.push(`SAY${r.sayIf ? ` (${r.sayIf})` : ''}: ${s}`);
  const say = r.say?.length ? ` Put the SAY line${r.say.length > 1 ? 's' : ''} in your final reply, word for word${r.sayIf ? `, ${r.sayIf}` : ''}.` : '';
  lines.push(r.run.length
    ? r.recipe === 'ask-the-system'
      ? `NEXT: run the command above and answer from what it prints, with the names exactly as written there.${say}`
      : `NEXT: run ${r.run.length > 1 ? 'these commands' : 'the command'} above, relay its SUMMARY as it is, and follow its NEXT line.${say}`
    : `NEXT: answer from the recipe below (and the reference it points to), quoting its exact words for settings and formats; run nothing.${say}`);
  const recipe = (recipeText ?? '').trimEnd();
  if (maxRecipe != null && recipe.length > maxRecipe) lines.push('', `--- recipe ${r.recipe}: read it with ${cmd} --recipe ${r.recipe} before you follow a step it has ---`);
  else lines.push('', `--- recipe ${r.recipe} (${cmd} --recipe ${r.recipe}) ---`, recipe);
  return lines.join('\n');
}
