# Project configuration, snapshot files and naming

Part of the rms-design-system-engine reference (`rms-design-system-engine --reference config`). The rules that always apply are in the main guide.

---


## Project Config

At the start of every run, read `./ds-config.json` from the project root.

**If it doesn't exist** (or `--init` flag is passed), the **engine runs its own setup
interview** - you do not conduct it or write `ds-config.json` by hand. It needs these
inputs (auto-detecting what it can):

1. **Main Design System Figma file** - the full browser URL of the DS file. The engine extracts the file key (path segment after `/design/` or `/file/`). Pass the URL, never a raw key.
2. **Theme CSS path** - relative path to the token CSS file(s). Auto-scanned; a single detected file becomes the default.
3. **Figma personal access token** *(optional)* - needed for collection auto-detection and Gates [2], [14] (visual regression + icon freshness). Read from `.env` if present. Never stored in `ds-config.json`.
4. **DS source file for cross-checking** *(optional)* - if the project's snapshot is taken from a downstream file (e.g. a branded fork), the upstream DS Figma URL parses `figmaSourceKey`. Enables `⏳ PENDING FIGMA SYNC` in Gate [3] - mismatches where code matches the upstream source are flagged as pending rather than failures.

Because the interview reads stdin, **drive it non-interactively with flags** (an agent turn
or CI cannot answer live prompts). Ask the user only for what you don't have (the Figma URL,
and the theme CSS path if none is auto-detected), then run:

```bash
node <install-dir>/audit.mjs --init \
  --figma-url='<DS file URL>' \
  --theme-css='src/styles/theme.css'          # omit if one file is auto-detected
  # --figma-source-url='<upstream DS URL>'     # optional consumer-file cross-check
```

If no theme CSS is given and none is auto-detected, setup exits with a clear error instead of
writing a broken config - that is the signal the DS declares no static token CSS (runtime-injected
values); report it rather than forcing a run. In that case setup also **scans the source for
runtime-loaded stylesheets** - a dynamic `<link>` whose href is set in code, or a remote
`…/theme.css` URL built in JS - and lists them (the likely token loader ranked above known CDN
noise). Those are where the values actually live: download the theme stylesheet(s) locally and
re-run with `--theme-css` pointing at them. A `FIGMA_TOKEN` in the environment is picked up
silently; it is never prompted for and never required.

**Do not ask for frame node IDs, collection names, or primitive prefixes** - these are either auto-detected or added later.

Then auto-detect and write `ds-config.json`:
- `snapshotVars` / `snapshotStructure` → sibling files next to theme CSS
- `pluginCSS` → scan `apps/*/ui.src.html` and `src/ui.src.html`
- `plugins` → derived from pluginCSS paths
- `figma.colorCollection` / `sizingCollection` / `primitivePrefix` → the DS variable collections parity reads. Set them in `ds-config.json`: the collection holding your colour tokens, the one holding your sizing tokens, and the path prefix of primitive variables. Defaults: `"Color"` / `null` / `"primitives/"`.
- `figma.modes` → Light (`:root`) + Dark (`dark-media`) (default - edit if your DS has more modes)
- `frames` → `[]` (add frame node IDs manually after setup)

Also:
- Scaffold `design-system-engine-map.mjs` from `design-system-engine-map.example.mjs` if not present
- Scaffold `structure-contract.mjs` from `structure-contract.example.mjs` if not present
- Append `ds-config.json`, `design-system-engine-map.mjs`, `structure-contract.mjs`, `.env` to `.gitignore`
- Print a **next-steps checklist** (frame IDs, primitive scale, component contracts)

With `--init`: stop after setup (print checklist, exit). Without `--init` and when called because `ds-config.json` was missing: continue the audit immediately.

Once `ds-config.json` exists, extract:
- `figmaFileKey` - Figma DS file key (the file whose tokens are being audited against the code)
- `figmaSourceKey` *(optional)* - upstream DS source file key for cross-checking. When set, Phase 1 queries both files. Mismatches where code matches the upstream source → `⏳ PENDING FIGMA SYNC` (not a gate failure). Absent = no cross-check.
- `frames` - array of `{ name, nodeId }` - the DS frame(s) to audit
- `figma.colorCollection` - name of the color variable collection (e.g. `"Color"`)
- `figma.sizingCollection` - name of the sizing collection, if any (e.g. `"Sizing"`)
- `figma.modes` - array of `{ name, snapshotKey, cssSelector }` defining the DS **colour** modes
  - OR legacy: `figma.darkMode` / `figma.lightMode` (two-mode shorthand)
- `figma.collections` *(optional)* - OTHER typed collections whose values change across their OWN mode axis, independent of colour (a sizing collection that changes per breakpoint, a string collection per locale). Each: `{ name, kind, modes: [{ name, snapshotKey, cssSelector }], explicit?, skip? }`.
  - `kind` - `"color"` | `"scalar"` (px/number) | `"string"`. Decides how a resolved value is compared (hex vs literal).
  - `modes` - this collection's own modes, each with its own `cssSelector`. Use `"media:(min-width: 768px)"` for breakpoint layers (`root` for the base/smallest, media overrides for the rest - mobile-first).
  - `explicit` *(optional)* - `{ token: "--css-var" | null }` overrides for tokens whose var name isn't the default `--token/path→--token-path` (null = documented no-CSS-var skip).
  - `skip` *(optional)* - array of tokens with no CSS var (documented).
  - Declaring this lets Gate [5] verify per-breakpoint / per-locale overrides exist in CSS. A DS that omits it is unaffected (colour-only check, byte-identical).
- `figma.motion` *(optional)* - opt-in motion-token parity (easing + duration variables → CSS). `{ explicit?: { token: "--css-var" }, skip?: [token] }`. Tokens default to `--token-path`. No-op unless the snapshot has a `motion` map AND this is set.
- `figma.effects` *(optional)* - opt-in effect-style parity (Figma shadow styles → CSS `box-shadow`). `{ explicit?: { styleName: "--css-var" }, skip?: [styleName] }`. Requires the shadow to be tokenised as a CSS var. No-op unless the snapshot has an `effects` map AND this is set.
- `docs.surfaces` *(optional)* - array of documentation files (relative paths, e.g. `["apps/styleguide/index.html"]`) that Gate [20] checks for invented/stale DS references. Local files only (a URL-hosted stylesheet is skipped, never a false failure). Unset = the gate is a no-op PASS. Point it at any living styleguide or DS doc that should reference only real DS tokens and vars.
- `reimplementationSurfaces` *(optional)* - array of code surfaces (relative paths; one trailing-`*` glob supported, e.g. `["apps/*/ui.src.html", "src/views/*.vue"]`) that Gate [20b] scans for a DS component **rebuilt by hand** - an interactive element of a DS-owned role, locally styled to look like the component but not using its class. Unset = a no-op PASS. `reimplementationRoles` *(optional, default `["button"]`)* widens the roles checked; a role is only checked when the DS defines a component for it. `reimplementationStrict` *(optional, default `false`)* promotes a finding from advisory to a hard fail. Exempt a deliberate look-alike via `knownReimplementations` (`["ui.html#.save-btn"]`).
- `figma.primitivePrefix` - token path prefix to exclude from component token walks (e.g. `"primitives/"`)
- `figma.componentsPage` *(optional)* - node id of the DS components page (e.g. `"1:439"`). Enables Gate [1]'s **component inventory** check: the live component list on that page is diffed against the structure snapshot so an added/removed DS component always surfaces by name. Without it, the check is skipped (a new component can slip through unaudited).
- `figma.namingConvention` *(optional)* - overrides for how Figma token paths are converted to CSS var names:
  - `dropSegments` - array of path segments to strip from the end of a token path before deriving the var name. Default: `["color", "default"]`. Set to `[]` to preserve all segments (e.g. when CSS vars end in `-color`).
  - `preset: "tailwind"` - Tailwind v4 `@theme` names: colour tokens under `--color-` (`surface/base/color` → `--color-surface-base`) and the first segment renamed `space` → `spacing`, `radii` → `radius` (`space/2` → `--spacing-2`). A theme variable used through its utility (`bg-action-primary`, `rounded-control`, `p-2`) counts as used. The same by hand: `colorNamespace` (the segment colour tokens go under) and `namespaces` (`{ "space": "spacing" }`, first segment renames for every token).
  - `iconTextAlias` - when `true` (default), `/iconText/` in a token path is normalised to `/text/`. Set to `false` when the codebase keeps `iconText` as-is.
  - `aliases` - per-segment renames (`{ figmaSegment: cssSegment }`). `iconTextAlias` is shorthand for `{ iconText: "text" }`; use `aliases` for any other rename the DS needs.
  - `separator` - what joins the path segments in the CSS var. Default `"-"` (e.g. `--node-border-selected`); set to `"_"` if the DS uses underscores.
  - `prefix` - the CSS custom-property prefix. Default `"--"`.
  - `case` - per-segment case transform. `"preserve"` (default) keeps the Figma casing; `"kebab"` splits camelCase, so a Figma token `node/border/selectedHover/color` maps to `--node-border-selected-hover` (use this when the code flattens combined states with a hyphen).

  Every gate reads this one block through a single shared helper (`naming-convention.mjs`); there is no per-gate hardcoded convention. The engine imposes no naming - each DS declares its own.
- `paths.themeCSS` - path to the token CSS file, **or an array of paths** for projects that split tokens across multiple files (e.g. `["src/tokens/base.css", "src/tokens/components.css"]`). All files are merged before any gate runs. Auto-detection finds any `.css`/`.scss` file containing `:root {` and `--` - note this locates only the **token** file; it does not produce component CSS.
- `paths.pluginCSS` *(optional)* - the **compiled** component CSS the structure and markup gates read. Each entry is a local path **or an http(s) URL** - compiled CSS is frequently a build artifact served from a CDN the repo only links to, so a URL entry is fetched. These gates match literal compiled selectors like `.button-primary.m`, which exist **only after a build**: in any pre-processor / single-file-component source that selector is written nested (`.button-primary { &.m { … } }`) and mixins never expand - so **never point `pluginCSS` at `.vue`/`.scss`/`.sass` source**. Build the design system to compiled CSS (any tool) and list the output, or list the URL that serves it; if the component rules already live in `themeCSS`, `pluginCSS` can stay empty. **Compiled CSS inlined inside an HTML file is fine** - the plugins here ship it in a `<style>` block inside `ui.(src.)html`, and the source-vs-compiled test scans only the `<style>` contents (never the surrounding markup or a `<script>`), so an inline `<style>` tag, a bitwise `&` in JS, or a `<style` string in code no longer misreads the file as pre-processor source. Only real preprocessor markers - a `.scss`/`.sass`/`.vue`/… extension, `@include`/`@mixin`/`@use`, or nested `&.`/`&:` **inside the CSS** - count as un-compiled. When there is no compiled CSS to check against (empty/token-only, genuinely still-source, or an unreachable URL), the structure gate exits with a distinct **cannot-verify** status (exit `2`, surfaced as a setup block - not a parity failure) and prints exactly how to fix it, instead of silently reporting every component as missing. Auto-detection only picks up `apps/*/ui.src.html`; a folder of `.css` dropped into the repo but not listed here is **ignored**, except in build mode (`build: true`), where a stylesheet holding a component's rules is added to `themeCSS`.
- `screens` *(optional)* - reference SCREENS for the Markup gate (screen element completeness): an array of `{ name, nodeId, plugin }` for detail views and modals whose DS controls must each have a code counterpart. Distinct from `frames[]` (whole-plugin screenshots for Gate [2]): `screens[]` are the finer views where a designer adds a control the code may not have built. Phase 1 (`refreshScreenElements`) captures each screen's interactive-control inventory into `figma-screens.snapshot.json`; falls back to `frames[]` when unset. `screenElementStrict` *(optional, default `false`)* promotes a missing control from an advisory to a hard fail. `knownScreenElementExemptions` *(optional)* - array of `"<plugin>/<label>"` strings recording a deliberate different realization (e.g. `"my-app/Export"` when Export is built as inline sections rather than a button+modal), which silences that control.
- `templates` *(optional)* - reference TEMPLATE / PAGE frames for Gate [11d] (template composition), one level above the sub-component gate: an array of `{ name, nodeId, file? }` for the DS's composed views (a Consult view, an Operation screen). Phase 1 (`refreshTemplateComposition`, REST `/nodes`, any plan) records the ordered top-level DS component instances each frame composes into `figma-templates.snapshot.json`; the gate then requires the template's code to use each. Unset = a no-op PASS (a DS without templates is unaffected); inert until the snapshot exists. `file` pins the template's code file (else it is resolved by name/basename/selector under `templateSrcDirs`, falling back to `componentSrcDirs`). `templateCompositionStrict` *(optional, default `false`)* promotes a **MISSING** composed component from advisory to a hard fail (a **NO FILE** always fails). Exempt a pair via `knownTemplateExceptions` (`["Consult/Filters"]`) or a whole template via `knownUnimplementedComponents`.
- `visualRefs` - directory for stored reference screenshots (default: `.design-system-engine-refs`)
- `visualRefScale` *(optional)* - PNG export scale for Gate [2] screenshots (default: `2`). Set to `3` for higher-fidelity references. Changing this value invalidates all stored refs - accept the new `.new.png` files with `mv *.new.png *.png` after the first run at the new scale.
- `knownUnimplementedComponents` - array of component names (matching keys in `structure-contract.mjs`) to exclude from Gate [10] and Gate [4] checks. Use this only as a temporary hold for DS components not yet built in code. Remove a component from this list as soon as its CSS and propertyMap are implemented. An empty array is the target state.
- **Work in progress is not drift.** A component on one side only that is in `knownUnimplementedComponents`, or whose decision status is `experimental` (`contract.authored.json`, or `@experimental` in its Figma description), is listed by Gate [17] as `IN PROGRESS` and never fails a gate. An experimental component is compared as usual once it is in Figma and in code. A `knownUnimplementedComponents` entry that is in both is reported as `READY TO COMPARE`, so you can take it off the list; the list itself is never edited for you.
- `knownStateExemptions` *(optional)* - array of `{ var, selector, _note }` objects exempting a specific `var`+`selector` pair from Gate [11]. Use when a state-suffix var is intentionally used outside its state selector - component mirrors (one component reusing another's token), semantic reuse (hover bg repurposed as neutral tint), or non-obvious class naming (`:checked` = selected for radio buttons). Always include a `_note` explaining the intent.
- `frameworkComponents` *(optional, default `true`)* - set to `false` when the code implements DS components as **CSS classes + markup** rather than as prop-based framework components (a plain-HTML/CSS DS consumer - a Figma plugin UI, an email-template repo). Gates [12] (component props match Figma) and [13] (sub-components match Figma) only make sense for a Vue/React-style codebase with declared props and instance nesting; with no such code they would report "no code file" for every DS component and hard-fail a codebase they don't apply to. `frameworkComponents: false` makes both gates **SKIP** (neutral, like the opt-in motion/effect gates) instead of failing. The value/structure/state/markup/icon/rendered gates are unaffected - the components are still fully audited as CSS. (Leave it `true`, the default, for a real component library.)
  - **`htmlRealization`** *(optional, default off)* - opt in and Gate [12] stops skipping for a `frameworkComponents:false` project and instead runs in **HTML-realization mode**: each Figma component property must map to a concrete code artifact, so the property is *realized* in the plain-HTML/CSS build rather than silently unverified. Drive it with `ds-config.json → htmlRealizations[Component][property] = '.class' | '#id' | 'tag' | 'state:'` - a `.class`/`#id`/element that must be present in the plugin source, or the `state:` sentinel for an interaction state that Gate [11] already covers (interaction-state properties are auto-classified as `state:` even without a map entry). A mapped artifact **absent** from the source is a **fail**; a property with **no** map entry is an advisory TODO by default, or a fail under **`htmlRealizationStrict: true`**. This is how a plain-HTML consumer verifies "every Figma property has a home in the markup" without pretending to be a prop-based framework. **The same `htmlRealization` flag also switches Gate [13] (sub-components) into an HTML mode**: each sub-component Figma nests must be realized as a **class** in the plugin source. Only parents actually built here are checked (an unbuilt DS component's composition is moot); icons are excluded (Gate [15]/[16] cover them). A missing sub-component is advisory by default, or a fail under **`htmlCompositionStrict: true`**. Capture the data it needs - `component-composition.snapshot.json` - in **every** Phase 1 when the DS has nested components (the Plugin API snippet in `rms-design-system-engine --reference gates` works on any plan, no token); it is not optional bookkeeping.
- `maxSnapshotAgeDays` **(recommended - this is the switch that stops a skipped/partial refresh)** - a hard age ceiling for the snapshots, in days. Day-to-day, a plan without a REST refresh downgrades staleness to a non-failing advisory (so the audit still runs) - but that lets a snapshot drift indefinitely, which is how real DS drift (retuned tokens, a resized component, a slot gap) hides behind all-green gates. **This is the engine's answer to "how do I stop myself cutting the Phase 1 corner?":** set it (e.g. `2`-`14`) and Gate [1] **hard-fails** the moment ANY snapshot is older than the ceiling, **even when plan-limited** - the Plugin-API capture works on any plan, so "we never refreshed" is a real problem, not a plan excuse. Because the pre-commit / pre-push hooks run the audit, a stale snapshot then **blocks the commit** - so refreshing only the vars while skipping the structure/bound/state walks fails closed (structure stays old → Gate [1] red → commit blocked), instead of quietly passing green. A green report is only trustworthy when Phase 1 actually ran this session; this ceiling is what makes that mechanical rather than a discipline you can forget. Below the ceiling, behaviour is unchanged.
- `versionLockStrict` **(recommended - "the file changed → Gate [1] MUST re-run" enforcement)** - promote Gate [1]'s whole-file `_figmaVersion` mismatch from an advisory to a **hard fail**. `maxSnapshotAgeDays` catches *time* (a snapshot nobody refreshed); this catches *change* (the designer edited the file **since** your last capture, even minutes ago). When the live file `version` differs from the snapshot's stamped `_figmaVersion`, Gate [1] **fails** and the pre-commit hook blocks the commit until you re-run Phase 1 — so "I refreshed a moment ago, nothing can have changed" stops being an assumption you're allowed to make: if the version moved, you re-capture, full stop. Off by default only because Figma versions the *whole* file, so a bump can be an unrelated edit elsewhere; turn it on for a DS you actively work against (any bump warrants a Phase 1 re-run) — the only cost is re-running the cheap Plugin-API walk. **Because a Plugin-API capture itself bumps the version (`setCurrentPageAsync`), stamp `_figmaVersion` as the LAST step of Phase 1, via REST, after all page navigations** — otherwise the gate fails on the bump your own capture caused. Clearing the fail is exactly the work the gate wants: re-run Phase 1, reconcile any drift, stamp the fresh version.
- `webhook.port` / `webhook.secret` - webhook server config

Use these throughout all Figma queries. Never hardcode collection or mode names.

---

### More settings (all optional)

- `gateTimeoutSec` (default 180) - a gate that runs longer is stopped and reported as a failure ("timed out, not verified"), so one stuck gate never freezes the audit or a pre-commit hook.
- `codeReading.timeoutSec` (default 120) - the time limit for the code capture inside the audit; past it the gates keep their own readings. `codeReading.hookBrowser: true` lets the capture use the browser inside git hooks too.
- `codeReading.visual: true` - the visual diff under MEASURED (see *Each component against its Figma image* in `rms-design-system-engine --recipe refresh-figma`). `codeReading.visualTolerance` (default 10, per colour channel) and `codeReading.visualThreshold` (default 2, the percentage of pixels outside text that marks a component ⚠️).
- `scanExcludeDirs`, `scanExcludeFilenames` - folders and file names (with `*` wildcards) the hardcoded-value and clean-CSS scans skip, such as demo pages. The styleguide template and output are always skipped (they are generated surfaces).
- `gate6ExcludeDirs` - folders the hardcoded-value scan skips, to scope it to the design system package (the layout checks still cover every file).
- `knownHardcodedExceptions` (older name `knownFontSizeExceptions`) - literal values or patterns the hardcoded-value scan accepts. An entry that no longer excuses anything is listed so it can be removed.
- `knownUnusedVars` - CSS variables that are kept on purpose although nothing uses them.
- `knownPropExceptions` - `"Component/prop"` pairs the props gate does not compare.
- `knownPhantomBorderExceptions` - selectors allowed to draw a border Figma does not have.
- `knownPluginOverrides` - theme variables an app may redeclare on purpose; `knownPluginSelectors` - app selectors that need no contract entry.
- `exemptionCheck.alwaysNative` - extra element names treated as native controls by the exemption check.
- `pluginDirs` - `{ "<app>": "path/from/root" }` when an app does not live in `apps/<app>`.
- `scopeMaxNestPerFile` (default 8) - how many nested selectors per file the token-scope check reads.
- `states` - which Figma prop and value is each interaction concept, when the names do not say it: `{ "hover": { "prop": "State", "value": "Hover" }, "active": { "prop": "State", "value": "Pressed" }, "disabled": { "prop": "isDisabled" } }` (a prop without a value is a boolean, true meaning the state). Used for the disabled exemption in contrast checks, to find the disabled state for the disabled-wins check, and by the props check (a declared axis with a value, such as `State`, is a state axis and not a missing code prop). An undeclared concept is read from the names (a boolean only when true).
- `hooks: false` - the project's Claude Code hooks (see *The project's hooks* in the main guide) pass everything, the final check of the reply included (the Stop hook: a line the route asked the person to hear, missing from the last reply, sends the agent back, twice at most).
- `editCheck: false` - turns off the check after each UI edit (the PostToolUse hook in `edit-check.mjs`): after an Edit, MultiEdit or Write on a style, markup or component file it reads only what the edit added and hands back a colour written by hand (with the token that has that value), a CSS variable declared nowhere, a prop value or prop name a design-system component tag does not take, a padding, margin, gap, corner radius or font size in px or rem (with the token that has the value, or the nearest ones; only for a kind of size the theme has tokens for, and never 0, a 1px hairline, a negative or a `calc()`), what the static accessibility check finds on the lines it added (a button or link with only an icon and no name, an image with no alt, a click handler on a div, an `aria-label` written after a `{...props}` spread (it replaces the name the caller passes), a focus outline removed and never put back, an `aria-*` that does not exist, each with its fix; `a11yStatic: false` leaves this part out), and a comment that switches a check off (`eslint-disable`, `stylelint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `oxlint-disable`, with the rules it names). Token definitions, a colour or size Figma has written in the theme file (one Figma has nowhere is flagged there too), comments, link fragments, data tables, canvas painting, the HTML element's own attributes and files built from a `.src` beside them are never flagged.
- `rtl: true` - lists the declarations that would not mirror in a right-to-left language (one-sided or asymmetric `padding-left`, `margin-right`, `border-left`, `left`/`right` offsets, `text-align` and `float` left or right), each with its file and line and the logical property to use. Symmetric values are not listed.
- `renderedParityStrict: true` - the measured differences (Gate [13] `MEASURED`) fail the gate instead of being advisory. In build mode they fail by default; `false` keeps them advisory there too.
- `workarounds: false` - turns off the `🧩 Built around a component` block (a screen's own control laid over a design-system component or a text field, reported to the design-system side as a missing slot or prop).
- `primitives` - the library owner's table from styling to a primitive component, never inferred: `[{ "component": "Text", "props": { "size": "medium", "color": "secondary" }, "when": { "font": "var(--body-medium)", "color": "var(--text-secondary)" } }]`. `when` lists CSS properties with their value (a variable matches with or without a fallback), and `"class": [...]` for utility classes. A plain element (`div`, `span`, `p` and the like) whose own style, JSX style object or class rules meet every condition is that component written by hand: the `🧩 Primitives written by hand` block lists each with its file and line and the tag to write, the edit check hands it back when an edit adds one, and `llms.txt` carries the table so generators compose the component. The entry with the most conditions wins. Components' own sources (`componentFiles`) and `scanExcludeDirs` are skipped.
- `tailwind: false` - turns off the `🎯 Tailwind arbitrary values` block and its part of the edit check (a class with a value in brackets, `rounded-[4px]`, compared with the project's `@theme`: the utility to write when a theme value is the same, or "not a design-system value"). `--tailwind` lists every one.
- `figmaCli.designJson` *(optional, default `design.json`)* - where figma-cli's `figma-cli snapshot` writes the file `--refresh-figma` and `--from-figma-cli` read. A design.json newer than the vars snapshot is read at the start of an audit; what it does not hold (text styles, other variants, descriptions, annotations) is kept. `FIGMA_PORT` (default 9222) is the port figma-cli reaches Figma Desktop on, as figma-cli reads it.
- `build: true` - build mode, for a project that starts from Figma: what Figma has and the code does not yet is listed as to build, never as a failure (`rms-design-system-engine --reference usage`, *Build mode*). Setup sets it when the project has no CSS at all, or with `--build`. Each audit adds a stylesheet that holds a Figma component's rules to `paths.themeCSS`, after the token file, so a component built into its own file is checked.
- `figmaHygiene: false` - turns off the `🎨 Figma file hygiene` block (values with no variable or style, detached instances, variants with no auto layout, components with no description, read from `component-values.snapshot.json`). `--hygiene` lists every finding.

## Key Architecture Assumptions

- **CSS mode mapping:** each mode's `cssSelector` in `ds-config.json` defines how it maps to CSS:
  - `"root"` → `:root { }` (base/light)
  - `"dark-media"` → `@media (prefers-color-scheme: dark) { :root { } }`
  - `"high-contrast-media"` → `@media (prefers-contrast: more) { :root { } }`
  - `"class:<name>"` → `:root.<name> { }` (or `html.<name>`, or `.<name>` on the root element)
  - `"data:<attr>=<val>"` → `:root[data-theme="dark"] { }`
  - The older forms `.<name> :root { }` and `[data-theme="dark"] :root { }` are still read, but no browser applies them (`:root` has no ancestor, so the mode never switches on screen). Gate [3] lists each one as `NEVER APPLIED` with the form to write instead.
- **Token naming convention:** by default, `token/path/default` → `--token-path` (drop `/default`, `/color`; `/` → `-`). Override with `figma.namingConvention` in `ds-config.json` when the project uses a different convention (e.g. keeping `/color` as `-color` suffix). Any additional shortenings are documented in `design-system-engine-map.mjs`.
- **Primitive scale:** document your DS's primitive tokens in `design-system-engine-map.mjs` under `NEUTRAL_LIGHT` / `NEUTRAL_DARK` (two modes) or `NEUTRAL_MAPS` (three or more modes) so the resolver can follow alias chains automatically.
- **Snapshot files** at paths defined in `ds-config.json`.

---


## Snapshot Files

| File | Contents | Path (from ds-config.json) |
|---|---|---|
| `figma-vars.snapshot.json` | color (all modes), sizing, typography, `modeVariants` (per-collection, per-mode non-colour maps) | `paths.snapshotVars` |
| `figma-structure.snapshot.json` | per-component State=Default structure | `paths.snapshotStructure` |
| `component-values.snapshot.json` | per component: every raw number and colour its nodes use (scopes the literal check), and its Figma file hygiene | project root |
| `figma-templates.snapshot.json` | per template frame (`templates`): the components it composes, in order; prototypes list them | `paths.snapshotTemplates`, else project root or beside the structure snapshot |
| `figma-screen-layout.snapshot.json` | designed screens read with `SCREEN_CAPTURE_JS` (read only): prototypes take the product's page arrangement and a starting point from them | `paths.screenLayout`, else beside the structure snapshot |

Both are machine-generated - never hand-edit. `component-state-tokens.json` and `bound-tokens.json` are produced by the Phase 1 Plugin API walks (which work on any plan) and **committed** - each carries an `_updated` stamp, Gate [1] tracks their freshness, and the consuming gates ([4], [10]) always run at full strength against the committed data.

**A 403 has two very different causes and Gate [1] separates them.** If Figma's response
says the token is invalid or expired, Gate [1] fails with `FIGMA_TOKEN rejected by Figma`
- reissue the token; the stale snapshots underneath are a symptom, not the problem. Any
other 403 is a genuine plan/scope limitation, and the stale snapshots are expected until
you run the Plugin API capture. Treating an expired credential as a plan limitation is
the dangerous confusion: every REST-backed refresh quietly stops while the audit reports
a condition you cannot fix.

**Every Figma REST call has a hard timeout.** Node's global `fetch` has none, so before this
guard a single stalled or rate-limited Figma response would hang the whole audit — and, via the
pre-commit hook, the commit — forever (typically after running the audit several times in quick
succession, when the API starts throttling and one request hangs open). All REST calls now go
through `figmaFetch` (`figma-fetch.mjs`), which aborts after `FIGMA_FETCH_TIMEOUT_MS` (default
20s, overridable via the env var) and throws; each caller already catches and falls back to the
committed snapshot, so a slow API degrades to "refresh skipped, using cache" instead of a hang. If
Phase 1 warns `Figma API did not respond within Ns`, the audit still runs at full strength against
the committed snapshots — re-run later (or raise `FIGMA_FETCH_TIMEOUT_MS` for a genuinely large file).

**A Figma call budget.** A seat has a daily or monthly quota of API calls, so a refresh spends as few as it
can and says how many: the same request is asked once per run, the refresh prints `Figma refresh: N API calls`,
and it is skipped (one call, for the file's version) when the file's version, the config and the engine are the
same as at the last complete refresh and its snapshots are all there (`.design-system-engine-out/figma-refresh.json`;
`FIGMA_REFRESH=force` refreshes anyway). A 429 whose `Retry-After` is longer than `FIGMA_LONG_LIMIT_S`
(default 120) is a daily or monthly limit: the refresh stops at once, names the plan and the wait Figma gives,
and keeps the snapshots as they were, instead of spending more calls on retries.

**The component-values sweep is CPU-bounded too.** A network timeout can't rescue a *synchronous*
runaway: Figma's `/nodes` endpoint expands instance subtrees inline, so a component set with nested
instances can return a document tree with millions of nodes, and walking it pins the CPU at 100% —
which also blocks the event loop, so no timer fires (this, not a slow network, was the real cause of
the audit "hanging" mid–Phase 1). The value walk (`collect-raw-values.mjs`) therefore carries a
node-visit budget (`DESIGN_SYSTEM_ENGINE_VALUE_NODE_BUDGET`, default 300k): once spent it stops descending and the
sweep finishes with a representative sample, logging `walk capped at N nodes`. Normal component sets
are far under the cap and are collected in full.

**Audit history** is appended to `design-system-engine-history.json` at project root after every run. View trend: `rms-design-system-engine --trend`.

**Which side moved.** Every run records, for each compared fact that matches (a token in each mode, a
padding, gap, radius, colour, height, visible layer…), the value on each side in `design-system-engine-agreed.json` at
the project root. Commit it. When a fact later differs, the measured difference says which side changed
since they last agreed: `[Figma moved, code is behind]`, `[code moved, Figma is behind]` or `[both moved
since they agreed]`. A fact that never agreed is just a difference, as before. A difference never
overwrites the record; only a new agreement does. The report ends with a count (`Agreed values: … Of the
N that differ: … Figma moved · … code moved · … both moved · … with no earlier agreement`). Inside a git
hook the file is read but never written, so a commit never changes a file it did not stage.

**Changes that keep bouncing, and who leads.** The same file keeps, per fact, both values at the last run
and its last 10 moves (which side changed, and whether that change broke an agreement, meaning that side
moved first). A fact whose moving side switched 3 or more times in its last 10 moves is listed as
`No clear owner`: the team has not decided which side owns it. When there were moves in the last 30 days,
one line says per area (tokens, spacing, colour, typography, size and shape, layers, states and variants)
which side moved first, as a share. It only describes; it never sets who wins.

**Sending it back.** Each measured difference says which way it goes, and Gate [13] writes both hand-backs
under `.design-system-engine-out/handback/`. Nothing is applied:
- **Code is behind** (Figma moved, or no earlier agreement): `code-changes.diff`, a patch that changes the
  declaration at the rule's `file:line` to the Figma token (or the project's text-style variable from
  `design-system-engine-map.mjs` TYPO, or the value). Review it, then `git apply .design-system-engine-out/handback/code-changes.diff`.
  Only single-value declarations and two-value `padding` are patched; the report counts the rest as by hand.
- **Figma is behind** (code moved): `figma-changes.md`, per component with a link to it in Figma, the
  property and the value to set there. When both sides moved, it lists the decision to make.

**A gate that could not run** (its snapshot or input is missing, exit 2) shows `⏭ not verified` with the
gate's own reason, and `Not run` in the summary. It never fails the run and is never a pass: the verdict
says `EVERY GATE THAT RAN PASSES ✅ (N not verified)` instead of `ALL GATES PASS`.

**Since the last run.** The report ends with what changed since the previous run with the same scope:
findings that are new, findings that are gone, and findings whose count or value moved. Accessibility
findings are compared element by element (the check also writes `.design-system-engine-out/a11y.json`). The findings
are kept in `.design-system-engine-out/last-findings.json`. A long report still says at a glance what this change did.

**Burndown.** One `📉` line then counts the open findings per component, most first, each with what the last
run with the same scope had (`chip 2 (was 3)`), plus the components cleared since then and a `next up` line.
A finding belongs to the most specific component its text names (a file name counts: `HbIconButton.vue` names
`iconButton`). A count (`❌ FAIL  1`), the fix printed under a finding, and a line that names several components
apart belong to none. Work the library down one component at a time: `--component <name>`, fix, run again.

**Reading a finding.** A measured difference names the component and field, the Figma value, the
rendered value and its token, the winning rule with its `file:line`, and what to write there
(`→ set var(--gap-xl)`). A value read from one source only (the browser or the stylesheet, not both)
says `[read from one source]`. Each component with a finding gets a `🔗` line that opens its node in
Figma (from `figmaFileKey` and the node ids in the snapshots). Lines that report nothing, such as
`❌ FAIL 0`, are left out.

**Why it changed.** In a git repository, a finding with a `file:line` (measured differences, state and
token contrast) gets a `↳` line: who last changed that line, when, and the commit's subject, or that it is
not committed yet. With `FIGMA_TOKEN`, the report also names the Figma file's latest named version, its
description, author and date. Figma keeps versions per file, so this is one line per run, not per finding.

---


## Naming Convention

| Rule | Notes |
|---|---|
| Token path → CSS var | `component/property/state` → `--component-property-state` |
| Drop `/default` state | Base token has no state suffix |
| Drop `/color` suffix | Always omit |
| `/` → `-` | Path separator becomes hyphen |
| Preserve camelCase | Component names stay as-is |
| State names verbatim | `active`, `selected`, `hover`, `disabled` - never substitute |

Any DS-specific shortenings are documented in `design-system-engine-map.mjs` under `EXPLICIT`.

---


## Alias Chain Rule

If Figma aliases `component/background → primitives/SomeToken`, CSS must use `var(--some-token)` - never a hardcoded literal. The alias chain must be fully traceable through CSS `var()` references.

Document your primitive → CSS var mapping in `design-system-engine-map.mjs` under `NEUTRAL_LIGHT` / `NEUTRAL_DARK` (two modes) or `NEUTRAL_MAPS` (three or more modes) so the resolver can follow chains automatically.
