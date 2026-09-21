# rms-figma-code-parity

Checks that your code matches your Figma design system, and tells you exactly what is out of sync and where to fix it.

## Install (once per computer)

In your terminal (the Terminal app on Mac, or Windows Terminal), paste this and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/rafaelmatosdasilva/rms-figma-code-parity/main/install.sh | bash
```

## Update

```bash
rms-figma-code-parity --update
```

`rms-figma-code-parity --version` tells you if you are behind, and every run gives a quiet once-a-day heads-up when a new version is out. You never re-download.

## Run it

First time in a project, set it up once (it asks a couple of quick questions):

```bash
cd my-project
rms-figma-code-parity --init
```

Then the easy way is to just ask, in plain language, inside Claude Code:

- *"run the parity on the whole DS"* — checks everything
- *"run the parity on input"* — checks the `input` component (and its sub-parts) and reports only that

Or from the terminal:

```bash
rms-figma-code-parity                       # the whole design system
rms-figma-code-parity --component input     # one component (or a few: input,button)
```

## Run just one check

Each check is its own script, so you can run only one. Accessibility, for example, on the whole system or on one component:

```bash
node ~/.claude/skills/rms-figma-code-parity/a11y-check.mjs                    # whole system
node ~/.claude/skills/rms-figma-code-parity/a11y-check.mjs --component input   # one component
```

Add `--a11y` to list every finding. (Inside Claude Code you can also just ask: *"run only the accessibility check on input"*.)

## What it checks

Every run compares the code against Figma. In plain terms:

- **Data is up to date** — you are comparing against today's Figma, not an old copy.
- **Figma frame unchanged** — the design still looks like the version you approved.
- **Token values** — colors, sizes and fonts match Figma, in every mode (light, dark).
- **Tokens used in screens exist in CSS** — nothing a screen uses is missing from the code.
- **Every mode is covered** — things that should change between light and dark actually do.
- **Exception lists are valid** — your "ignore this" notes still point at real things.
- **No invented CSS variables** — every variable really comes from Figma.
- **Docs tell the truth** — your docs mention only tokens and variables that exist.
- **No invented text casing** — no forced UPPERCASE the design never asked for.
- **Clean CSS** — no unused variables, and nothing that contradicts Figma.
- **Nested components keep their own styles** — one component's styles do not leak into another.
- **Structure** — the right height, spacing and corners, from tokens.
- **All states are built** — hover, disabled, selected and the rest each exist and use the right values.
- **Component props match Figma** — the same names, defaults and options as Figma.
- **Sub-components match Figma** — the parts Figma nests are the ones the code uses.
- **Templates compose the right components** — each template/page uses the components Figma composes (opt-in via `templates[]`).
- **Markup** — ids, classes and icons match, and every control the design shows is actually built.
- **Required pieces are in place** — icon slots, component slots and form controls.
- **Icons** — come from the shared set and match Figma.
- **Transitions** — use the durations and easings from the design.
- **Motion** — motion values match Figma (only when your DS defines them).
- **Shadows** — shadows match Figma (only when your DS defines them).
- **Renders correctly in a browser** — the real rendered result matches, not just the code on paper.
- **What this audit actually checked** — shows what was and was not covered, so nothing slips through.

It also runs an advisory **accessibility** pass (contrast, accessible names, visible focus) and writes a machine-readable **contract** locally for AI tools. Neither ever blocks the audit.

## That's it

Commit the files it creates (the `*.snapshot.json`) so your whole team and CI run against the same design. Deeper setup and options live in the skill's own doc.
