# Usage: every command, option and output

Part of the rms-design-system-engine reference (`rms-design-system-engine --reference usage`). The rules that always apply are in the main guide.

## Usage

```
/rms-design-system-engine
```

**You do NOT have to audit the whole design system.** Scope the run to one or more chosen
components - the common case when you are working on, or checking, a single component:

```bash
rms-design-system-engine --component ButtonPrimary                # one component
rms-design-system-engine --component ButtonPrimary,Toast          # several (comma-separated)
rms-design-system-engine --component ButtonPrimary --component Toast   # or repeated
```

In a scoped run the gates report **only** findings that belong to the chosen components;
everything else is collapsed to a single "… N findings outside scope - not audited" line,
and a gate that failed only on out-of-scope items passes for that run. This is what keeps a
single-component check clean instead of drowning in the rest of the DS. Because a component
**contains** others (a button may hold an icon, a card a badge), the scope **auto-expands**
to the nested components used inside the chosen ones (found via their source files, so the
parent is never passed while a child it depends on is broken); the banner lists what was
pulled in. Only a component's own source counts: the file `componentFiles` names for it, or a
file whose name ends with its name (`HbIconButton.vue` is iconButton's, `Chip/index.tsx` is
chip's). A page that shows several components, the theme CSS, a native element (`<button>`,
`type="button"`) and a name inside a longer one (button inside iconButton) pull in nothing. A
finding that names a component belongs to that component; one that names none (a token, a
shared rule) belongs to the scope when its file mentions a component in scope. The burndown
of a scoped run counts only its components. Set a default in `ds-config.json → scopeComponents: ["ButtonPrimary"]` if a repo
should always run scoped. Omit the flag to audit the whole DS.

**Only part of the run.** `--only` runs the part asked for and nothing else; the report and the summary say what ran,
so a part never reads as the whole system passing:
```bash
rms-design-system-engine --only accessibility             # the accessibility check alone (from the code, and in the browser when it can)
rms-design-system-engine --only parity                    # every gate against Figma, without the accessibility check
rms-design-system-engine --only 3                         # one gate by number (1 to 25), or by name: --only "token values", --only states,props
rms-design-system-engine --component chip --only accessibility   # with a scope, as any run
```
A word it does not know prints the list of gates. `--baseline` needs the whole run, and the trend and the "since the
last run" comparison are kept for whole runs only. The router turns "check the accessibility of the button", "without
accessibility" or "only the token values gate" into the right `--only`.

**Utility flags (no full audit - run the terminal command directly):**
```bash
rms-design-system-engine --init                          # first-time setup only: scaffold config files, then exit
rms-design-system-engine --init --figma-url=<url> --theme-css=<path>   # non-interactive setup (for agents/CI; --figma-source-url=<url> optional)
rms-design-system-engine --version                       # am I on the latest? compares local vs remote (a normal run also nudges once/day)
rms-design-system-engine --update                        # update to the latest - no re-download
rms-design-system-engine --link-command                  # (re)point the /rms-design-system-engine command at the install via symlink
rms-design-system-engine --trend                         # show last 20 audit runs + pass/fail trend
rms-design-system-engine --exemption-debt                # list every exemption/escape-hatch (debt report + legibility: temporary/permanent/owner; totals show on every run)
rms-design-system-engine --code-drift                    # list props that exist in code but not in Figma (code→design "sync back" advisory; totals show on every run)
rms-design-system-engine --contract-completeness         # list components whose emitted contract has no description (agent-readiness gaps; totals show on every run)
rms-design-system-engine --query badge --hb-radius-control  # a component's props (names exactly as the code writes them, Figma's where they differ) or a token's variable, values per mode and, for a text colour, the surfaces it reads on
rms-design-system-engine --hygiene                       # list every Figma file hygiene finding: values with no variable or style, detached instances, no auto layout, no description (the first 15 show on every run)
rms-design-system-engine --prune                         # list prune candidates: deprecated tokens, single-option variants, single-use components (totals show on every run)
rms-design-system-engine --duplication                   # list DS names restated by hand-maintained surfaces (opt-in via ds-config duplication.surfaces; totals show on every run)
rms-design-system-engine --code-connect                  # list stale/invalid Figma Code Connect mappings vs the contract (auto-detected from committed *.figma.tsx; totals show on every run)
rms-design-system-engine --no-docs                       # skip the design-intent layer this run (emitted by default; local, gitignored)
rms-design-system-engine --refresh-figma                 # read Figma the best way there is: design.json, figma-cli, else says how
rms-design-system-engine --from-figma-cli [design.json]  # read figma-cli's design.json into the snapshots
rms-design-system-engine --styleguide                    # the style guide of what Figma and the code agree on, only
rms-design-system-engine --docs                          # ALSO build the styleguide HTML this run (design-intent itself is already automatic)
rms-design-system-engine --no-contracts                  # skip the standard contract + DTCG tokens this run (emitted by default; local, gitignored)
rms-design-system-engine --baseline                      # capture today's failing gates as accepted adoption debt (commit design-system-engine-baseline.json)
rms-design-system-engine --baseline --findings           # the same, each failing ❌ line accepted on its own
rms-design-system-engine --baseline --findings --match radi   # only the lines that name it (the radius, not the rest)
rms-design-system-engine --no-baseline                   # ignore any design-system-engine-baseline.json this run (enforce every gate)
rms-design-system-engine --summary                       # print the plain result of the last run again (relay it as is)
rms-design-system-engine --install-hooks                 # add the project's Claude Code hooks (done by --init); --remove-hooks takes them out
rms-design-system-engine --doctor                        # check the install (command link, hooks, Chrome, Node) with the one fix for each problem
rms-design-system-engine --route "<request>"             # the first step for any request: the recipe, the exact command, SAY and NEXT (the project's hook runs it for /rms-design-system-engine requests)
rms-design-system-engine --recipe [name]                 # print a task recipe from the skill's cookbook (no name lists them)
rms-design-system-engine --reference [name]              # print a reference file from the skill (no name lists them)
rms-design-system-engine --guide classic|current         # link the command to the guide as one file (as before the split), or back
node ~/.claude/skills/rms-design-system-engine/parity-check.mjs --fix                   # auto-fix sizing/typography divergences in theme.css
node ~/.claude/skills/rms-design-system-engine/setup-webhook.mjs --list                 # list registered Figma webhooks for this file
```

### Build mode

A project that has only Figma starts in **build mode** (`ds-config.json` → `"build": true`): setup chooses it when the
project has no CSS at all, or when it runs with `--build`. The engine still writes no code; it says what to build and
checks each piece once it exists.

- **What is left to build, in order.** The report ends with a `🧱 TO BUILD` line: the tokens first, then each component
  Figma has and the code does not yet, a component after the ones it nests. NEXT names the next item with its commands.
  Something still to build is never a failure; once it exists it is compared like everything else.
- **Tokens.** The token check writes every Figma variable the theme does not declare yet, exactly as the theme should
  declare it (name, value, the block for each mode and breakpoint), to `.design-system-engine-out/handback/tokens-to-build.css`,
  to copy into the theme file. A declared token with a wrong value still fails.
- **Components.** `--query <name>` prints a component's build sheet: its class, height, padding, gap, radius and colours
  with their variables, the text style, the selector of each state and variant (a modifier class such as `.chip--l`,
  a pseudo-class for a state: `:hover:not(:disabled)`, `:active`, `:focus-visible`, `:disabled`), its role and the
  components it nests. A variant gets a selector only when it changes a style (one that only shows a layer, such as an
  icon, is markup). A colour Figma paints with no variable is named with its value, to write as it is and report,
  never as an invented variable. An experimental component gets its sheet when asked for, though it stays off the
  build list. Every line is what the structure check compares once the component exists, so a component built from
  the sheet needs no `structure-contract.mjs` entry; an entry the project writes always wins.
- **Component stylesheets.** A component built into its own stylesheet (`src/components/button.css`) is found by its
  class and added to `paths.themeCSS` after the token file, said once in the report, so every gate reads it.
- **A token an edit invents.** In any project, a custom property an edit adds with a value of its own (a colour, a size) that Figma has no variable for is handed back, in the theme too; one that only points at the system's tokens, or that Figma has, is not.
- **A last check before the agent finishes.** The Stop hook runs the edit check once more over every UI file the session changed, against the last commit; a value the system does not have that an edit left in place goes back once, with the file and the line. Lines that were already in the commit do not count.
- **Never a secret in the chat.** Whatever the request, the Stop hook sends back once a final reply that asks the person for a token, key or password: the person puts it in the project's `.env` themselves. A design token named in a question is not a secret.
- **Measured differences fail.** In build mode a value the browser measures on the rendered component that differs from Figma (a height, a line height, a colour) fails Gate [13], and its direction is always back to Figma's value: the code was just written from it. A value the page could only read as the browser's default is shown, not failed. `renderedParityStrict: false` keeps them advisory.
- **The role, even with only states.** Figma's role annotation is read in the markup of every component that has one, also when all its props are states (a field whose only prop is `State` still has to be a real `<input>`).
- **The sentence owed.** Building a component Figma paints with a colour that has no variable, the route asks for one line in the reply saying so, and the Stop hook sends the agent back when the reply leaves it out: twice at most, so a first hand-back spent on something else does not lose it.
- **While building.** The edit check counts the tokens still to build as the system's own, so a component written
  before its tokens is still checked against them. Unused tokens are expected and do not fail.

### The design-intent layer (auto OUTPUT, never a gate)

The design-intent layer is an **output**, not a verification — the same category as the
contracts. It runs as a post-step *after* the gates, reusing the fresh snapshots, and **never
affects pass/fail**. Because this is an **agnostic** engine, the default **adapts to the
project** instead of forcing a private file on everyone: it **auto-generates once the project
has ADOPTED it** — an existing `design-intent.json`, a `docs.out` path, or `docs.auto: true` in
`ds-config.json` — or when the run passes `--docs`/`--intent`. A **zero-signal project gets no
surprise file**. Once adopted it stays fresh **every run** (like the contracts), so an AI agent
(and the styleguide) always read a **current** DS rather than a stale one. Force it off with
**`--no-docs`** or `ds-config.json → docs.auto: false`. To guarantee it on a fresh clone (the
file is gitignored, so absent after checkout), set `docs.auto: true`. It is deliberately NOT a
gate: a gate answers "does the code match Figma?", and generating documentation is neither a
check nor something that decides the verdict. The heavier **styleguide HTML stays opt-in** — it
builds with `--styleguide`, an explicit `--docs` (alias `--intent`) or `ds-config.json → styleguide.auto:
true`, from the engine's template unless the project names its own.

It writes **one** merge-aware file, `<theme-css dir>/design-intent.json` (override with
`ds-config.json → docs.out`) — a project's **intent layer**, organised as
`{ system, foundations, components, patterns, templates, pages, flows }`. It is a generated
**view over the canonical sources — nothing is hand-copied**:

- **Design intent** ← Figma component `description` + `annotations` (from the component-props snapshot).
- **Code intent** ← each component's `structure-contract.mjs` `_note` **and** the comment that
  precedes its rule in the token CSS.
- **Facts** ← the structure snapshot (height, padding/gap tokens, fill, variants, properties).
- **Usage** ← which plugin sources reference the component's class.
- **External guidelines** ← your own doc(s) listed in `ds-config.json → guidelines: { sources: [...] }`
  (Markdown or JSON, committed to the repo). A section whose heading matches a component name attaches
  to that component (`components[name].guidelines`); the rest becomes a global `guidelines` block. This
  is how prose from an external source (a Notion export, a house styleguide) reaches agents without
  being invented or duplicated. The generator hashes the file(s) so a change is detectable, and it only
  reads the **committed** file, never the live network. A live Notion/URL fetch, when you configure one,
  is a separate capture step (Phase 1) that writes that file first, then the generator folds it in. It
  never follows links inside a doc: list every page you want in `sources`. Advisory, never a gate.

**Wiring an external guidelines doc** (e.g. a Notion page). In `ds-config.json`:
```jsonc
"guidelines": {
  "sources": ["guidelines.md"],               // the committed file the generator reads (md or json)
  "source":  { "notion": "<page url or id>" }  // OPTIONAL: refresh guidelines.md from Notion each run
}
```
`sources` alone is enough: export the doc to Markdown, commit it, done. To make the refresh automatic
from Notion, the person does three one-time things: (1) create a Notion **internal integration** and
copy its secret; (2) **share the page** with that integration; (3) put the secret in the project's
`.env` as `NOTION_TOKEN` (gitignored, so it is per-person and never committed). The page **link** in
`ds-config.json` is not secret and is committed; the **token** stays in each person's `.env`. No token,
page not shared, or offline → the audit keeps the committed `guidelines.md` and never fails. A prototype's catalog refreshes a link whose file is missing or older than `guidelines.maxAgeHours` (24) the same way. The fetch
reads one page and does not follow links inside it.

**The easy way: paste the link into the chat.** The agent runs `rms-design-system-engine --guidelines <link>`,
which works for GitLab and Notion alike, one or several links: it adds the link below for you, reads the page
at once, and reports whether it worked. Notion also takes a list now (`"notion": ["<link>", …]`), each
page to its own `guidelines/notion-<page>.md`; the original single link keeps writing to `sources[0]`.

**From GitLab** (wiki pages or Markdown files, on gitlab.com or a company's own GitLab), list one or
several links; each is written to its own committed file and read automatically, so there is no need to
repeat it in `sources`:
```jsonc
"guidelines": {
  "source": {
    "gitlab": [
      "https://gitlab.com/acme/design/-/wikis/Buttons",                                   // → guidelines/gitlab-buttons.md
      { "url": "https://git.acme.io/ds/docs/-/blob/main/usage.md", "file": "guidelines/usage.md" }
    ]
  }
}
```
The kind of link is read from the URL: `/-/wikis/<page>` (project or `groups/…` wiki) or
`/-/blob/<branch>/<file>.md` / `/-/raw/…` (a branch name containing `/` is resolved automatically). The host
comes from the link. A public project needs nothing else. For a private one, each person puts a GitLab
personal access token with `read_api` in the project's `.env` as `GITLAB_TOKEN` (gitignored, never
committed); for a company server, also `GITLAB_HOST=git.acme.io`. The token is only ever sent to
`gitlab.com` or `GITLAB_HOST`, so a link to any other host is fetched without it. Like Notion: no access,
offline, or a wrong link → the committed file is kept and the audit never fails. The written pages reach the
intent layer the same way as any guidelines file: a section headed with a component's name lands in that
component's `guidelines` in `design-intent.json`, the rest in the global block, as written.

Because the file is regenerated every run, the generator is **merge-aware**: it reads the existing
file and **preserves everything you authored** — each layer's `authored` string, and every
component's `authored` field — refreshing only the derived parts. So you get one file that is
auto-derived where it can be and hand-authored where it must be (the `system`/`patterns`/… layers),
and regeneration never destroys your prose. Author higher-layer/system intent directly in the
`authored` fields (Markdown strings).

**It is project-specific and private.** The engine ships only the generic generator; the *content*
is 100% derived from **your** Figma + code, on your machine. Keep the output **gitignored** (add
`design-intent.json` to `.gitignore`) and back it up privately alongside the snapshots — never
commit it to a public repo, since it carries your Figma's internal annotations and DS rationale.
Any consumer (an optional styleguide) reads this **one** JSON — single source, no
re-derivation.

#### The living styleguide (opt-in: `--styleguide`, or `--docs`)

`--styleguide` builds the styleguide HTML on its own; `--docs` builds it right after the design-intent. It is a
**generated view** of what Figma and the code agree on, never hand-maintained. Every project fills **one
template, the engine's** (`templates/styleguide.template.html`), so an improvement made there reaches every design
system on its next run; `ds-config.json → styleguide.template` points a project at a template of its own instead.
The output goes to `styleguide.out`, else `.design-system-engine-out/styleguide/index.html`.

What the engine's template shows (`styleguide-data.mjs` decides it):

- **Foundations**: colours, typography, spacing, radii and other sizes, each the CSS variable itself, shown only
  when the token check (`parity-check.mjs --json` → `passVars`) finds it equal to Figma in every mode; icons from
  the icon sheet.
- **Components**: each drawn from the project's own markup (the contract's probe, else the first instance in its
  own pages, else what its React source returns, else the element its Figma role asks for) with its own CSS. Its controls are the props Gate [15]
  matched, labelled with Figma's names; an option applies what the contract's `propertyMap` says it adds (a class,
  an attribute; a live state such as `:hover` is offered but disabled); a switch shows or hides the part it names.
  Below it, the tokens behind what is drawn and its size; above it, the apps that use it and its documentation.
- **In use**: the approved pictures of `frames[]` (Gate [2]'s references in `visualRefs`), six at most.
- **Modes**: an axis per mode collection (colour from `figma.modes`, size from the sizing collection), for the page
  and, where the CSS nests, for one component.
- **Not agreed yet**: a prop on one side only, another default, a token that differs, a component not built yet:
  left out and counted in one line at the top, for the person to decide.

A project's own template is filled through markers:

- `{{AGREED}}` ← the agreed view above, as JSON.
- `{{ICON_SHEET}}` ← the DS icon `<symbol>` set, lifted from a built plugin `ui.html` (`styleguide.iconSource`).
- `{{USAGE}}` ← which plugins reference each component's class (scanned from plugin source).
- `{{DOCS}}` / `{{DOCS_CODE}}` ← Figma descriptions and code notes, from the design-intent JSON (hardcoded pixel dimensions are stripped — docs describe with tokens).
- `{{THEME_CSS}}` ← the token CSS inlined verbatim, with its `@media (prefers-color-scheme: dark)` guarded to `:root:not([data-color])` so the manual light/dark toggle wins; `{{COMPONENT_CSS}}` ← the component stylesheets outside the theme.

Config: `styleguide: { template?, out?, iconSource?, plugins? }`. `plugins` is `[{ key, match }]`, a short usage label per app and a fragment of its source path; without it each app in `paths.plugins` gets a short label made from its name (the initials of a name with two or more words, `order-history` → `OH`, the name itself for one word, and full names if two apps would share a label). Because it renders **only** what the
DS actually contains and agrees on, the styleguide can never invent or drift — the same guarantee Gate 20
(docs-truth) checks on the output.

#### The standard contract layer (emitted automatically each run)

**Every run** (after the gates, whenever a vars snapshot exists) **also emits a machine-readable
contract** in a standard, interoperable format (a per-component JSON contract + W3C DTCG tokens). On
by default so it never goes stale; opt out per-run with `--no-contracts` or per-project
with `ds-config.json → contracts.auto: false`. It splits captured from authored by file:

- **`contract.authored.json`** (project root, **committed**) — the AUTHORED hub: per component,
  `bindings` (Figma prop → `{ attribute: "codeName" }` for a rename, `{ slot: "slotName" }` for a slot),
  plus optional `semantics`, `notes`, `version`, `description`, `propDescriptions`, and optional
  **agent guidance** — `whenNotToUse` (string), `useInstead` (a name or a list) and `neverCombineWith`
  (a list) — so an AI knows when not to reach for a component and what pairings are invalid — and an
  optional **decision status** (I33): `status` (`current` | `deprecated` | `experimental`), `supersededBy`
  (the component that won), `since`, and `rationale` (the *why*), so an agent never finds two right
  answers with no note saying which one won. Decisions
  only, no captured values, so it is safe to commit and applies in CI. Scaffolded once (empty bindings),
  then hand-owned; the generator never rewrites it.
- **`contracts/`** (**local, gitignored**) — the generated CAPTURED views, refreshed every run:
  `tokens.json` (W3C DTCG: `$type`/`$value`, per-mode under `$extensions`, referenced by
  `{family.token}`), one **standard** `<name>.contract.json` each (`id`, `version`, `props[]` with
  `bindings.figma`/`bindings.code`, `anatomy`, `states`, `variants`, `semantics`, plus optional `whenNotToUse`/`useInstead` and
  `relationships` — `composesWith` derived from the composition snapshot, `neverCombineWith` authored,
  and a `status` block when the DS says something about the decision: authored fields win, and a Figma
  component description that already uses a tag convention fills the gaps — `@deprecated [why]`,
  `@experimental`, `@status <state>`, `@use-instead <Name>` (also `@superseded-by`/`@replaced-by`),
  `@since <x>`, `@why <text>`; the convention is read, never imposed, and no tags + nothing authored = no
  field. A deprecated **token** whose Figma description names its replacement or reason gets that
  explanation as its DTCG `$deprecated` string (`"Use radii/button instead. too sharp"`) instead of a bare `true`),
  `contract.schema.json`, and an `llms.txt` AI index (which opens by telling an agent to use these components,
  build nothing by hand that one covers and ask `--query` before guessing a name; it also lists each component's guidance and
  composition, tags a non-current component `[deprecated]`/`[experimental]`, and gives it a
  `status: deprecated · use X instead · since 2.0 · why: …` line). They carry the DS's real values, so a single
  `.gitignore` keeps them local. When these are present, a token divergence also **cites its source**:
  the token's verified value from `tokens.json` and the file that declares it, so a fix (by a person or
  an agent) is applied against the real fact, not a guess. Absent contracts, the citation degrades to
  naming the token and its convention var.

The generator reads `contract.authored.json` + the snapshots and merges them into the local views (the
authored decisions win). Nothing generates a surface from any of it. **Gate 14** reads the authored
`bindings` to resolve a prop rename or slot instead of guessing (a wrong binding never masks a real gap
— it still fails); no other gate reads the contract. A malformed `bindings` entry (a typo'd key) is
flagged in the run output, never silently ignored. Each run also reports **advisory** signals (never
pass/fail): breaking vs additive contract changes since the last run, newly-deprecated tokens and
components; **decision status** (I33: how many components are deprecated / experimental, and every decision
an agent would misread — guidance (`useInstead`) or composition that still sends it to a deprecated
component, a `supersededBy` that names no DS component or a component that is itself deprecated (the chain
is followed to the one that won), and a deprecation with neither a replacement nor a reason; first 12 each
run, all with `--status`); token
references that resolve to nothing (a silent-failure risk), and tokens used where a different `$type`
is expected; **contract completeness** (how many emitted contracts carry a description, semantics and
whenNotToUse/useInstead guidance, naming those with no description so agent-readiness gaps are visible;
full list with `--contract-completeness`); **exemption debt** (every escape-hatch surfaced for periodic review, tagged by legibility:
temporary vs permanent, owner, and review-by, so temporary bypasses get cleared and permanent ones stay
accountable; totals each run, full list with `--exemption-debt`); **code→design drift** (props that
exist in code but not in Figma, surfaced as a "sync back to the design" advisory so code-ahead-of-design
is visible; the engine only surfaces it, the designer decides; totals each run, full list with
`--code-drift`); and **token layering** (a structure-agnostic check: it imposes no
tier model, only measures the DS's own aliasing rate and, when references are the DS's norm, surfaces
the few tokens that hold a raw value instead); **token contrast** (computes WCAG contrast from the token
values, per mode, and flags pairs below AA; a no-browser complement to the render a11y gate. Pairs are
**derived** from the token-name convention — a component's `text`/`label`/`icon` token paired with the
background sharing its state/variant qualifier, on by default, opt out with `a11y.derivePairs: false` —
and/or **declared** in `ds-config.json → a11y.tokenPairs: [{text, bg, large?}]`; icon/stroke roles use the
3:1 non-text bar); **declared token tiers** (opt-in — only when
`ds-config.json → tiers: [{ name, match, mayReference? }]` is set: classifies each token by the
project's own regexes and flags a token that aliases a tier its `mayReference` disallows; never imposes
a tier model, zero config = does not run); and an **AI-readiness scorecard** (a running R/Y/G
measure across gate health, coverage, documentation and guidance, aggregated from the signals above,
never a grade and never blocking); and **prune candidates** (a leaner library is cheaper for an agent
to read and mis-picks less: surfaces deprecated tokens still present, variant axes that do not vary
(a "variant" prop with one option), and components used in exactly one place — each a QUESTION, never
a verdict; totals each run, full list with `--prune`). One more **opt-in, project-declared** advisory:
**list duplication** (`ds-config.json → duplication: { surfaces: ["AGENTS.md", ".cursorrules", …], minCluster? }`) —
a DS list copied by hand into an agent-instruction file, skill, or doc drifts into a stale parallel truth
(and a stale list is what makes an agent hallucinate). Flags a declared hand-maintained surface that restates
a cluster of DS component/token names (and calls out the same list duplicated across two or more surfaces),
so it can reference the generated `llms.txt`/contracts instead of keeping a copy; totals each run, names with
`--duplication`. Generated surfaces (the styleguide) are not listed here — showing every component is their job.
It also **validates Figma Code Connect** when present (auto-detected from committed `*.figma.tsx`/`*.figma.ts`,
or `ds-config.json → codeConnect.files`): Code Connect is a downstream artifact that can go stale, so the
audit diffs each mapping against the emitted contract — joined by Figma **node id** — and flags a mapping
that names a prop or enum option the contract no longer has (fix the mapping, not the contract; names with
`--code-connect`). Like every plan-gated capability it reads **only what is already committed locally and
never calls the Enterprise Code Connect API**, so any-plan projects are unaffected (no files = does not run).
Each emitted `<component>.contract.json` also carries a **usage
scaffold** (the element plus each prop with a concrete example value, derived from the contract itself
so an agent instantiates the component without guessing). Two more **opt-in, project-declared** advisories
(never imposed, never fail): **closed vocabulary** (`ds-config.json → closedVocab: { bannedTags, surfaces,
suggest? }` — counts raw container tags the project banned, in the declared surfaces) and **multi-brand
coverage** (flags a token defined in some brands but missing in others). Brands are resolved by
`resolveBrands`, plan-agnostically: **declared** `ds-config.json → brands: [snapshotKey, …]` wins; else a
captured **collections manifest** that marks a brand collection (the Enterprise / extended-collections
enhancement, read as data the any-plan capture wrote — never a plan-gated API call); else it **suggests**
candidate multi-mode collections but never assumes (modes may be theme/density/locale, not brands). Override paths with
`ds-config.json → contracts.{authored,out,tokensOut,schemaOut,llmsOut,propTypesOut}`; the engine ships only the generator.

**Figma prop types.** The same run writes `contracts/figma-props.d.ts`: per component, a `<Name>FigmaProps`
interface (one union per variant property, `boolean` for a True/False variant or a boolean property,
`string` for text, `unknown` for an instance slot) and a `<Name>FigmaDefaults` type. Names follow the props
check (an authored binding, then `componentPropAliases`, then camelCase); interaction states are left out,
as they are CSS. Type a component's props with it (`const check: ChipFigmaProps = {} as ChipProps`, or use
it as the props type) and `tsc` shows prop drift in the editor and in CI. `contracts/` stays local, so set
`contracts.propTypesOut` to a committed path when CI should check it.

#### The code capture (every run, and `--capture-code` on its own)

Figma is captured once per run into snapshots every gate reads. The code is now captured the same way:
each audit run writes `.design-system-engine-out/code.snapshot.json` (local, keep `.design-system-engine-out` gitignored; setup adds
it) before the gates start, and every fact in it says **where it came from** and **how sure the reading
is**. It is cached by content, so an unchanged project reuses it at once; after a code change the
browser part takes a few seconds per component. `rms-design-system-engine --capture-code` runs it on its
own. `ds-config.json → codeReading.capture: "off"` skips it in the audit (the gates then keep their own
readings, and Gate [17] says the capture did not run). Inside a git hook the capture is static only, so a
commit never waits for the browser: a pre-commit hook is detected on its own, any other hook passes
`--hook`, and `codeReading.hookBrowser: true` brings the browser back. The next normal run redoes the
capture with the browser.

- **Two readings of every token.** Chrome (via `cdp.mjs`) opens the theme and the built pages, switches
  into each mode the way its `cssSelector` says (media emulation, a class, a data attribute, a viewport
  width) and reads every custom property as the browser resolved it, including tokens a page injects at
  runtime. `css-source.mjs` reads the same CSS statically: a real block parser (`@media`, `@layer`,
  `@supports`, nesting, strings, `;` inside `url()`), local `@import` followed, `<style>` blocks read out
  of HTML, file and line kept, and each mode resolved by the actual cascade (importance, specificity,
  source order), so a later `:root` that silently overrides a dark block is seen as the browser sees it.
- **Components measured where they render.** Each component (found through `component-locator.mjs`) is
  measured in the generated styleguide or the built pages: a plain instance first, one that carries text
  next; a usage with extra classes or an id is copied into a neutral host without them (and the removed
  extras are recorded); a hidden one is measured as a copy; else a probe from `structure-contract.mjs`; else,
  for a React component, the markup its own JSX returns (`jsx-markup.mjs`: the element types, the classes
  that are always there, string attributes and default text, so a `<span>` or an `<input>` is measured as
  one); else a bare element built from the selector, its contract children and the parts the selector map
  names (lowest confidence, and never a height, since it has no content). When the rule already sets Figma's
  height and the drawn box is another, the fix names the cause: an inline element that ignores a height, or
  padding and border outside a content box. The parts the contract names
  (`fontSel`, `radiusSel`, `gapSel`, `beforeSel`) and the first element holding text (what Figma's font
  fields describe) are measured too. Numbers are repeatable: fixed viewport and pixel ratio, fonts loaded,
  transitions off.
- **Every value traced.** `CSS.getMatchedStylesForNode` names the declaration that won (importance, then
  cascade order, inline last), its `var()` token, its rule and its source `file:line` (the built page's
  line is kept as `renderedAt`). Inherited values name the ancestor rule; values no author rule sets are
  labelled browser defaults and are not code facts. When another rule beats the component's own base rule,
  the override is recorded (`overrides: { baseRule, baseValue, baseAt }`).
- **States produced for real.** From each component's `propertyMap`: `:hover`/`:focus`/`:active` forced,
  classes, attributes, `:disabled`/`:checked` applied, a BEM modifier swapped in; a state that cannot be put
  on the instance is looked for, on every page, on an element already in it. Anything still not produced
  is listed with the reason.
- **Confidence on every fact.** `verified` (the browser and the source agree on the rule that won),
  `single-source`, `uncertain` (the readings disagree: reported as a reading problem, never as a design
  difference), `not-read` with the reason, or `default`. Known browser rules are applied, not flagged:
  border widths drawn in whole pixels (the declared `1.5px` stays the code's fact, `drawn: 1px` beside it),
  a unitless line-height is a multiple of the font size, a `min-height` larger than `height` wins.
- **Cached by content.** A hash of every input; an unchanged project reuses the snapshot instantly
  (`--force` recaptures). `ds-config.json → codeReading: { browser: "auto" | "off", pages: [...], out }`.
  Without Chrome every fact is `single-source` from the static reading and says why.
- **Component APIs (props).** Read from the best source the project already has, never a new dependency:
  a Custom Elements Manifest (`custom-elements.json`), react-docgen or vue-docgen JSON
  (`codeReading.docgen`), the project's own TypeScript compiler when installed (the `Props` type read by
  syntax: allowed values, booleans, defaults, Vue `defineProps`/`withDefaults`), then text patterns. A
  Storybook index (`storybook-static/index.json`, or `codeReading.storybookIndex`) and committed Figma
  Code Connect files (`*.figma.tsx`, joined to the Figma component by node id) only say which file is
  which component and which code prop a Figma property maps to; they never supply values. Each prop is
  `verified` when two sources agree, `uncertain` when they disagree. With `frameworkComponents: false` no
  props are read (the components are markup and CSS).
- **Icons.** Every sprite `<symbol>` with its file and line, `viewBox`, path data and fill/stroke flags,
  and every literal use (`file:line`).
- **Markup.** Each app's fingerprint, the same one Gate [12] compares.
- **Nesting.** Which DS components sit inside which, read in the rendered page (so markup built by
  JavaScript counts) and in the component's source file. Both readings agree: `verified`.

**The gates read the same way.** The props, nesting, icon and markup gates use the capture's readers
(`component-api.mjs`, `component-source.mjs`, `icon-source.mjs`, `markup-source.mjs`), and Gate [3]
reads the theme with the capture's cascade-aware reader: every `:root` block, local `@import`, and each
mode resolved as the browser resolves it (a `:root` written after a dark block wins in dark mode too, and
Gate [3] now reports that). Where a gate needs a fact only the capture has, it reads the snapshot, and
only while the snapshot still matches the code:
- Gate [3]: a token the browser and the CSS text disagree on is listed as "could not read reliably"
  (not verified, so the gate stays red) instead of blaming the design.
- Gate [11c]: a sub-component the rendered page shows inside its parent counts as used, so JavaScript-built
  nesting passes, and a parent with no source file is judged by what renders.
- Gate [17]: one `CODE CAPTURE` line with what was read (tokens, components measured, states, props,
  icons, nesting) and how, or that the capture is missing or out of date.

**`--capture-code --compare`** lays the capture beside the Figma snapshots, field by field, and writes
`.design-system-engine-out/code-vs-figma.json`. Tokens resolve exactly as Gate 3 resolves them (the trailing `/color`
dropped, then `design-system-engine-map` `EXPLICIT` / `EXPLICIT_SIZING`, then the naming convention; `SKIP_TOKENS`,
`NULL_TOKENS` and an explicit `null` skipped). Component fields: a height only where the code fixes one (a
`height` rule compared as the drawn box, a `min-height` by its value), padding, gap and radius by token or
value, font against the first text element, background as "paints or not" (Figma often paints on a child
layer, code on the element). On a project whose parity is green this is a calibration: every difference is
either a capture bug to fix or a real fact about the code that no gate looks at yet.

#### The component catalog and `--check-ui` (for UI generators)

A generator (an AI agent, a small model in the browser, a template tool) composes real design-system UI
only when it is told exactly what exists, and its output is checked every time. Every run writes
`contracts/catalog.json` beside the contracts: each component with its props (allowed values, defaults,
and the code prop name when known), the components it may contain (from Figma's composition and the
nesting the code capture saw), what it must never contain, and its status. `llms.txt` gets the same
catalog as an aligned table (`Badge  Tone=info|warn  Text=text`), because small models read aligned
tables far better than JSON Schema. Interaction states (hover, focus) are not props a generator sets:
the component owns them. When the code capture is fresh, each entry also has `rendered`: its size on a
real page, `targetSize` for a control (with `atLeast24`, WCAG 2.5.8), and what each state changes, by
token where the code uses one (`"State=Hover": { "backgroundColor": "var(--btn-bg-hover)" }`).

`rms-design-system-engine --check-ui <generated.json>` checks one generated UI against that catalog. It
accepts a flat A2UI-style list (`{ root, components: [{ id, component, children: [ids], …props }] }`) or a
nested `{ component, props, children }` tree. The check is deterministic and prompt-blind: it never
repairs the UI and never adds anything, so it can be run on every generation. Its rules are written
down once (only catalog components; only listed props and values; booleans are true or false; unique
ids, one root, existing children, one parent each, no cycles; nothing inside a component it must never
combine with), and every finding names the rule it breaks. A deprecated component, a node not attached
to the tree, or a child the design system never nests there is a warning. Findings are also written to
`.design-system-engine-out/ui-check.json`, so a generation log can keep them beside the raw output; the error count is
the generation's quality score. Exit 1 on any error.

#### Prototypes

`rms-design-system-engine --prototype --catalog` prints everything a prototype may use, in this order: what it was read
from (each Figma snapshot with its age, the code, the authored contract, each guidelines file with the Notion or GitLab
link it came from, and a link not fetched yet); for this request, what applies to it; the catalog's components with
their options (a component the code does not have is marked: it is drawn as a labelled box); what each component is for;
the team's rules for the product; the rules the check holds every prototype to; the templates in Figma; how the
product's pages are arranged; the engine's layout pieces with the spacing tokens, text styles and screen widths they
take; the format; and the prototypes already in `prototypes/`.

- **What each component is for** comes from everything the team wrote, read as the design intent reads it
  (`intent-gen.mjs`, nothing written): the Figma description and annotations (a `Role:` annotation is shown as its
  role), each option's description, the code's notes and the comment above its CSS rule, the authored contract
  (`whenNotToUse`, `useInstead`, status, notes) and the guidelines section named after it.
- **The team's rules** are every other guidelines section, each with its file (`guidelines.sources`, and the files the
  Notion and GitLab links are fetched into), and the authored layers of `design-intent.json` (system, foundations,
  patterns, templates, pages, flows). A link whose file is missing or older than `guidelines.maxAgeHours` (24) is
  fetched again first, as the audit does (`DESIGN_SYSTEM_ENGINE_NO_FETCH=1` skips it); with no token or no network the
  committed file is kept, and a link never fetched is listed with ⚠️.
- **For this request.** The request is the one made with the command in the last hour (the prompt hook keeps it in
  `.design-system-engine-out/prototypes/request.json`), or `--for "<text>"`. Against it: the guidelines' opening text
  and the sections its words touch, in full; the components its words point to (by name, description, options, notes
  or guidelines); and the closest page to start from, made already or designed in Figma.
- **Rules the check holds.** A plain sentence in the guidelines, "one button per screen", "at most two fields on a
  page", is a limit: a prototype with more is not drawn, and the error quotes the sentence and its section.
- **What the request asks for.** A component the request names (every word of its name is in it: "an empty state"
  → emptyState) that the prototype does not use is a warning the reply owes: add it, or say why. A component the
  documentation rules out for the request's words ("a message confirming…" and a tag that is never a message that comes
  and goes), used anyway, is an error, unless the node says what else it is for in `"purpose"` (a note, like
  `standInFor`, that the check reads and the drawing ignores).
- **Uses the documentation rules out.** A sentence with never, not for, do not or avoid in a component's guidelines,
  notes or `whenNotToUse` rules out the words after it, up to the end of its clause ("it never submits anything" rules
  out submitting, not the rest of the sentence). A request word it names lists that component as ruled out, not as one
  the request points to; a stand-in it names is an error (show the need as a Missing box), and a label it names is a
  warning.
- **Templates in Figma** are `figma-templates.snapshot.json` (`templates` in `ds-config.json`): the components each
  template composes, in order. **Screen widths** are the Figma breakpoints; a `Page.width` that is none of them is a
  warning.
- **Designed screens.** The screen capture (`paths.screenLayout`, or `figma-screen-layout.snapshot.json` beside the
  Figma snapshots) is read even before `--from-screens` brings it into `prototypes/`: its screens count as the product's
  pages and as places to start from.

`rms-design-system-engine --prototype prototypes/<name>.json` checks a composition (the format `--check-ui` reads, nested
or flat) and, when it holds, draws it as one page under `.design-system-engine-out/prototypes/<name>.html`: each
component from its own markup (the contract's probe, a page instance, or its React source) with the project's CSS, in
every mode the system has, with a switch for the colour modes and one that outlines the engine's pieces and stand-ins.
The rules are `--check-ui`'s, plus:
- **The engine's pieces** (Page, Stack, Row, Columns, Text) exist only where the system has no component of that name.
  They carry no colour, border or font of their own: `gap` and `padding` take a spacing token, `Text.style` a text
  style, `Page.width` the screen's width in px; `grow` takes the room a parent leaves. The page takes the system's own
  page surface, text colour and font family. Each piece used is a layout gap.
- **A need nothing fits** is `{ "component": "Missing", "props": { "need": "…", "kind": "…", "closest": "…" } }`, drawn
  as a labelled box. A component used for a need it does not quite meet carries `"standInFor": "<the need>"`.
- **An option Figma and the code do not share by name** is drawn on the part its name points to: a text option
  (`TitleContent`) writes the element whose class says title, or the one holding Figma's default text, or the
  component's own text for a label; an on/off option (`Show Description`) set off removes the part it names. A page
  instance's own state (a `hidden` class, a position on its page) is taken off. An option with no such part is drawn
  without it, with a warning once per component.
- **Gaps.** Missing boxes, stand-ins, the engine's pieces and components the code does not have go on the gaps list:
  `.design-system-engine-out/prototypes/gaps.json` keeps every prototype's (`byPrototype`) and the merged list, the most
  needed first. The Stop hook holds the reply to the gaps of the prototype just drawn.
- **A retired component** (status deprecated) is an error that names its replacement.
- **What the documentation says.** After drawing, each system component the prototype uses is listed beside what it
  uses it for (its labels and stand-ins) and what the documentation says it is for, so a use it is not for stands out:
  that use gets `standInFor`, or a Missing box, and the prototype is drawn again.
- **The product's other pages.** A prototype is compared with the other prototypes in `prototypes/`: page padding, the
  space between sections, the screen width, the page heading's text style, where the actions sit and how they line up,
  the frame (the containers at the top of the layout, a component holding other parts or named as a bar, panel, header,
  window or nav, like an action bar and a side panel), and the answer given to each need the system lacks (a chip as a stand-in on one page and a Missing box on another is
  a difference). A decision counts when two pages share it, or one screen a designer made in Figma (in the screen
  capture, or a starting point from `--from-screens`), and no other value weighs as much; `prototypes/conventions.json` (`{ "page": { "padding":
  … }, "heading": { "style": … }, "actions": { "at": "end", "justify": "end" }, "needs": { "<need>": "<answer>" } }`),
  written by the team, wins. Each difference is listed with the pages it differs from, and the Stop hook holds the
  reply to it like a gap. `rms-design-system-engine --prototype --consistency` compares every page with the others.
- A composition with an error is not drawn (exit 1). A file `{ "prototype": …, "gaps": [...] }` adds the gaps written
  beside it.

`rms-design-system-engine --prototype --from-screens <capture.json>` turns designed screens into starting points:
`prototypes/<screen>.json`, each drawn at once. The capture is `SCREEN_CAPTURE_JS` in `screen-layout.mjs`, a read-only
Plugin API script run with the Figma MCP (`use_figma`) or figma-cli on the screens' node ids. Each screen keeps its
arrangement (auto layout direction, gap and padding as spacing tokens, Fill as `grow`, alignment), the system's
components with their options and what their slots hold; a local component that holds others (a whole screen made a
component) is read as layout and listed as a template or component the system could own; a frame with its own fill,
border or corner, a typed number, a text with no style, a shape and a component the catalog lacks are gaps. It ends with
the spacing habits across the screens and the structures that repeat (template candidates). A starting point already
in `prototypes/` is kept unless `--force`.

#### Adoption baseline / ratchet (opt-in, gate-level)

A real codebase is rarely 100% green on day one. Rather than a wall of red (ignored) or turning gates
off (drift hides), run `--baseline` once to record **today's failing gates as accepted debt** in a
committed `design-system-engine-baseline.json`. After that, a normal run **tolerates** those baselined gates (shown
as `⚠️ Debt`, verdict `NO REGRESSIONS ✅`) but **fails on any gate not in the baseline that goes red** —
a real regression. Debt only ratchets **down**: a baselined gate that goes green is surfaced as "ready
to ratchet" so you can re-run `--baseline` to lock it in (it can no longer regress silently); stale
entries (a renamed/removed gate) are flagged for pruning. It is gate-level on purpose — it uses only
the pass/fail the audit already has for all 25 gates, so it is fully deterministic and imposes no
structure. Off by default (no file = no baseline); ignore a file for one run with `--no-baseline`, or
per-project with `ds-config.json → baseline.enabled: false` (path via `baseline.path`).

**Per finding.** `--baseline --findings` records each failing gate's `❌` lines instead of the gate, so one
known difference can be accepted while everything else in the same gate keeps blocking. A failing gate whose
`❌` lines are all accepted is debt; any other `❌` line is a regression, including an accepted one whose value
changed (it is new text). The run lists the new lines, and the accepted lines that no longer appear as fixed,
to drop with the next `--baseline --findings`. A failing gate with no `❌` line to accept is recorded as a gate.
`--match <words>` (comma-separated) accepts only the lines that contain one of them, with their gate's count
line, and adds them to the file (nothing accepted before is dropped): `--component chip --baseline --findings
--match radi` accepts the chip's radius and keeps its prop names failing. The router adds it when the person
names the kind of difference (radius, height, width, padding, gap, colour, props).

#### Accessibility check (I18, advisory, from the render)

A mechanical, agnostic accessibility pass (`a11y-check.mjs`) that reuses the Gate 22 CDP/headless-Chrome
flow. It reports **WCAG AA contrast** per theme (computed `color` vs the effective composited background),
**accessible name + role** (interactive nodes from the accessibility tree — a component that never exposes
aria), **visible focus** (a computed style change when focused **and** that change actually visible — the focus ring's colour has ≥ 3:1 contrast against its background, WCAG 1.4.11), **state exposure** (an element whose state
is shown only by a CSS class — `.selected` / `.checked` / `.disabled` / `.invalid` / … — with no matching
`aria-*` or native state, so assistive tech never hears it; the state-class→aria map is common-English by
default, extend via `a11y.stateClasses`), and **keyboard reachability** (an interactive control that cannot
be reached by keyboard — an interactive role on a non-focusable element, or a native control with
`tabindex=-1`). Findings come from measured pixels and the a11y tree, no assumed DS shape (No-imposed-structure).

**Advisory by default**, and the report is written in **plain language, no jargon** — each issue says what is
wrong, why it matters to a real person, and what to do about it. Three audiences, one set of findings:
the default is the plain human summary; **`--a11y`** adds the exact elements (still plain); **`--json`** emits
the same findings as a machine-readable record (selector, contrast ratio, theme, role, and the fix) for an
agent or CI. When it runs against anything other than the styleguide it ends with a one-line tip on how to
get the deepest, per-state result. `ds-config.json → a11yStrict: true` promotes findings to a hard fail. It
runs inside the audit and standalone: `node a11y-check.mjs [--component A,B|.selector] [--url <page>] [--a11y|--json] [--axe] [--states]`
(`--component` scopes the sweep and accepts a raw CSS selector too). **Skips cleanly** (exit 0) with no
browser, never a false fail. Deps: Node >= 22 (built-in WebSocket), Chrome/Chromium (or `CHROME_PATH`), and
a render target.

**Render targets are agnostic — it does not assume a Figma plugin, and aims for zero questions.** It checks
whatever surface the project serves, in this order:
1. **Configured / built** — `--url <route>` (repeatable/comma; runs with **no `ds-config.json`** at all),
   or `ds-config.json → a11y.urls`.
2. **The generated styleguide** (the preferred default when it exists) — `ds-config.json → styleguide.out`
   (default `apps/styleguide/index.html`), opened via `file://`. It renders **every component × every
   state on one static page**, so the sweep is deterministic, complete and needs **no dev server**, and —
   because each state is its own instance in the resting DOM — the existing checks get **per-state coverage
   for free** (a disabled/checked/error instance is measured directly). `a11y.styleguide:false` opts out;
   `a11y.regenerateStyleguide:true` rebuilds it first (via `styleguide-gen.mjs`) so a11y never audits a
   stale one. Falls through to the built plugin UIs (`apps/*/ui.html`) when there is no styleguide.
3. **Auto-discovery (the default when nothing is configured)** — it reads `package.json`, **starts the
   project's dev server** (`storybook` / `dev` / `serve` / `start` / `preview`, or `a11y.serve`), reads the
   URL it prints, and **enumerates the pages itself**: Storybook stories → else static router routes → else
   the base page. Override the base with `a11y.baseUrl`, delay the sweep for SPA hydration with
   `a11y.waitFor`, or turn the whole thing off with `a11y.discover: false`.
4. **Ask (last resort)** — only when auto-discovery finds nothing does the skill ask the user for the one
   render URL. It **never fabricates a config or crawls the repo**; with no target it skips cleanly and says
   how to provide one.

So a Storybook or router-based DS runs fully automatically the first time — no config, no questions; a
bespoke app that exposes no page index is the only case that needs a `--url` / `a11y.urls` hint (set once).

**Broader coverage via `--axe`:** opt in and it also runs **axe-core** (fetched from a CDN, no npm dependency) against the same rendered page, adding the rules the five native checks do not cover — **non-text / component contrast** (WCAG 1.4.11 for borders, icons, graphics), **target size**, **duplicate ids**, **ARIA validity**, **heading order**, **form labels**, and **reading order / skip-links / landmarks** (`region`, `landmark-*`, `bypass`, `tabindex`) — reported as an extra plain-language advisory section (and under `axe` in `--json`). The **focus-ring** part of 1.4.11 is already covered natively (check 3 above).

**Live hover contrast via `--states`:** opt in (or `a11y.interactionStates:true`) and it forces `:hover` (CDP `CSS.forcePseudoState`) on the interactive elements and re-measures, flagging text that reads fine at rest but drops below AA while hovered — the one interaction-state case axe cannot see (it reads the resting DOM).

**Deeper checks (every run, every page).** Each is isolated: a check that cannot run on a page is skipped
there, never a failure.
- **Every colour mode, switched properly** — media emulation, a class or a data attribute on the root, or
  high contrast, the same way the code capture switches them — and contrast, focus and the focus ring are
  checked in every mode (a finding in several modes is reported once, with its modes).
- **Real keyboard focus** — a Tab key press first, so `:focus-visible` styles show as a keyboard user sees
  them. A focus style drawn with a background change, an underline or on `::before`/`::after` counts; a ring
  drawn outside the element is measured against the parent's background.
- **Target size (2.5.8)** — a control under 24×24 with another control inside its 24px circle. Links in
  running text, and inputs whose label is the target, are exempt.
- **Keyboard walk** — a real Tab walk: a focus trap, any positive `tabindex` (visits out of order), and a
  focused control completely covered by other content such as a sticky header (2.4.11; on real pages,
  not on the styleguide, whose sticky header is its own chrome).
- **Keyboard activation** — a control built from a plain element (`role="button"`, `checkbox`, `switch`,
  `tab`, `link`…) that does nothing on Enter (and Space for buttons, checkboxes and switches). The click is
  caught before the element's own handler, so the check never navigates or submits.
- **Arrow keys** — a radio group, tab list, menu or list box whose items do not move with the arrow keys.
- **Dialogs and Escape** — an open dialog that does not close on Escape. Each control that opens a dialog, a
  menu or a list (`aria-haspopup`, or `aria-expanded` with `aria-controls`; up to 8 a page) is opened, Escape
  is pressed, and what it opened must close and give the focus back to that control. A link does not navigate
  and a form does not submit while it runs.
- **One main heading** — an app page (a `--url` page or a route found on its own, not the styleguide or a
  story) has one `h1`, which a screen reader jumps to. The code part flags a page file with text and no `h1`,
  or several.
- **Zoom to 200% (1.4.4)** — text that becomes cut off when the page is shown at twice its size.
- **Focus ring thickness (2.4.13, AAA, advisory)** — a focus ring thinner than 2 CSS pixels. The browser's
  own ring is not counted.
- **Figma accessibility annotations** — a note that states a role, a name, a heading level or alt text is
  checked against what the component renders (see *Writing accessibility notes in Figma* below). Other notes
  stay notes.

**Writing accessibility notes in Figma.** Use Figma's annotation tool on the component (the component set or
a standalone component). A category such as "Accessibility" helps people find them; the skill reads the text.
One fact per line, or per sentence ending in `. ` or `;`. The keywords are English; the value can be in any
language.

| Note | Checked against the rendered component |
|---|---|
| `Role: button` | The role a screen reader announces (an ARIA role) |
| `Role: togglebutton` | A button that also exposes `aria-pressed`. Also `textinput` (a text box), `searchinput` (a search box), `iconbutton` (a button) |
| `aria-label: Close dialog` | The accessible name, ignoring case (also `Accessible name:`, `Screen reader label:`) |
| `Heading level 2` · `H2` | A heading, at that level |
| `Alt: Sales chart` | An image whose text alternative is that text |

Example of one note: `Role: button. aria-label: Close dialog`.

- **On an inner layer.** A note on a layer inside the component's default variant (the first one) is checked on
  the part the contract names the same way: `CONTRACT[component].children` with that `name` and a
  `cssSelector`. A layer with no such part is listed as not checked, with what to add.
- **No Gate [10g] entry needed.** A note the accessibility check can verify passes Gate [10g] on its own; only
  prose notes still need `CONTRACT.annotations`.
- **Where the notes come from.** The component-props snapshot, refreshed with `FIGMA_TOKEN` or the Plugin API
  capture below (both record `annotations` on the component and `layerAnnotations` on its inner layers).
- **A name that changes with content** ("3 items") is compared as written, so it is reported as a difference.
  Describe such names in prose instead.
- **Reduced motion (2.3.3)** — under `prefers-reduced-motion: reduce`, anything that still transitions or
  animates.
- **Forced colours** — under `forced-colors: active` (Windows high contrast), a focus indicator that
  disappears because it was only a shadow or a background.
- **Text spacing (1.4.12)** — the spacing a reader may set (line height 1.5, letter spacing 0.12em, word
  spacing 0.16em); text that becomes cut off.
- **Semantics** — each component's rendered role (accessibility tree) against the contract's authored
  `semantics` (`contract.authored.json`).
- **What a role requires** — for each component with a role (the contract's `semantics`, or a Figma note,
  which wins), up to 20 rendered instances are checked for what that role needs:
  - a toggle button has `aria-pressed`, and clicking changes it (clicked back afterwards)
  - a checkbox, radio or switch has a real control (a native input, or the role with `aria-checked`) and a
    label; a switch exposes `role="switch"`
  - a text field has a label; in its error state it has `aria-invalid="true"` and `aria-describedby` to its
    message; `aria-describedby` points to an element that exists
  - a tab is `role="tab"` inside a `role="tablist"`, and the selected one has `aria-selected="true"`
  - anything that looks disabled is `disabled` or `aria-disabled`
  A state is read from the instance's classes or `data-state` (error or invalid, selected, active or
  current, disabled). Nothing is checked for a component without a declared role.
- **Reflow at 320px (1.4.10)** — opt in with `a11y.reflow: true` for real screens (a component catalog is
  not meant to reflow).
- **State contrast, no browser needed** — from the code capture: each component's text against its own
  background in every mode and every state the capture produced (hover, selected, error…). Disabled states
  are exempt. A see-through background (a tint made with opacity or `color-mix()`) is blended over what
  the capture saw behind it. Each finding names the two colour tokens, the rule's file and line, and
  links the component in Figma. Printed with the token contrast in the audit.
- **Token contrast** — see-through text is blended over its background; a see-through background (no
  known surface under it) is skipped; disabled pairs are exempt; pairs come from every mode's token names.
  A text token with the same colour as its background token is reported as not comparable: the component
  applies that background as a tint, which only the rendered state contrast can measure.
  Border, outline and focus-ring tokens are paired at 3:1 with `a11y.nonTextPairs: true` (opt-in: a border is
  often decorative); dividers never are.
- **On the styleguide, only the design system's components are checked** (their selectors), not the page's
  own navigation and notes. The styleguide pins its own `data-color` mode; the check (and the code capture)
  sets it to each mode it measures, so dark is really measured in dark.
- **One element failing the same way in many places is one finding**, with the number of places and a few
  of its texts, and each element names the design-system component it sits in.
- **axe-core** must match a pinned SHA-384 hash before it is ever injected into a page (from the CDN, or
  from the npm registry's package when a CDN is blocked). With `a11yStrict`, its serious and critical
  findings count toward failing the check.
- **axe-core** is cached in `~/.cache/rms-design-system-engine` after the first download (or `a11y.axePath`
  points at a local copy), runs the WCAG 2.0/2.1/2.2 A and AA rules explicitly, and is scoped to the
  checked components.

**Not yet:** forcing `:active`.

#### Evals (I7, a separate entry point — measures agent OUTPUT, never gates the repo)

`eval-run.mjs` points the DS-conformance core at an agent's GENERATED output instead of the repo, so you
can measure whether agents actually follow the DS. Configure in `ds-config.json → evals`:
```jsonc
"evals": {
  "cases": [ { "id": "login", "prompt": "build a login screen with the DS", "component": "input" } ],
  "outDir": "evals", "ext": "html",   // candidates at evals/<id>.<ext>
  "strict": false,                     // true → exit 1 when any candidate has a violation
  "runs": 1,                           // with generate.cmd, run each case N times (3–5 signal, 10+ definitive)
  "generate": { "cmd": "your-agent-cli" },  // OPTIONAL: produce the candidate from the prompt
  "judge":    { "cmd": "your-judge-cli" }   // OPTIONAL: advisory LLM-judge
}
```
Run: `node eval-run.mjs`. For each case it reads the candidate `outDir/<id>.<ext>` and flags the same
mechanical failures the gates catch — raw color/dimension literals that should be tokens, `var(--x)` not
in the DS var universe (invented) — and reports per-case + aggregate metrics (produced?, zero-fix rate,
violations, **inline-style count**, and, when generating, **avg generation time**), appending to
`evals-history.json`. With `evals.runs > 1` (and a `generate.cmd`) each case is generated and checked
**N times** and reported as a reliability fraction (`k/N runs clean`), since agent output is
non-deterministic. **Advisory** (exit 0 unless `evals.strict`), and it **never gates the repo audit**.

**Generation and the judge are pluggable commands** (any agent/CLI, no provider lock-in):
- `evals.generate.cmd` — run with `--generate` (or when a candidate is missing): the prompt is piped on
  stdin, the DS context (`llms.txt`) path is in `$EVAL_CONTEXT`, `$EVAL_ID`/`$EVAL_COMPONENT` are set, and
  the command's **stdout** becomes the candidate (written to `evals/<id>.<ext>`). The prompt is the case's
  `prompt` alone: the expected `component` is for the scoring, so do not pass `$EVAL_COMPONENT` to the agent.
- A case's `component` is what it expects: a candidate that does not use it (its class, or a tag of its name)
  avoided the system and fails (`avoided-component`), and the summary counts `N avoided the system`. A prompt
  that names a component is flagged before the run, since its score would measure reading the prompt.
- `evals.judge.cmd` — advisory only: gets `{id,prompt,component,guidance,candidate}` as JSON on stdin (where
  `guidance` is the component's own description + whenNotToUse/useInstead from its contract, so the judge
  assesses "right component / correct usage" against the DS's rules, not blind) and must print
  a JSON verdict `{ok, notes}` (right component for the intent, empty/error states). It never gates.
- `evals.levels` (or `--levels bare,steering,parity`) — does the team's guidance help? The same cases run per
  level: `bare` (no context), `steering` (the project's own instruction files, AGENTS.md, CLAUDE.md, rules,
  joined into `evals/.context/steering.md`) and `parity` (`contracts/llms.txt`). The command gets the level in
  `$EVAL_LEVEL` and the file in `$EVAL_CONTEXT`. Each level is scored by the same checks, the accessibility read
  from the code included (a clean case has no violation and no accessibility finding), and compared with bare.
  A level with nothing to give says why and is not run. A command that does not read its stdin is fine.
Both **degrade safely** (a missing/failing command just leaves the committed candidates and skips the judge).
Spec: `plans/PARITY-evals-spec.md`.
