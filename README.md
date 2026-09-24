# rms-figma-code-parity

Checks that your code actually matches your design system: the real colours, sizes, fonts and component rules from Figma, not just whether it looks about right. It tells you exactly what is out of sync and where to fix it. It works the same on code you wrote and on code an AI wrote.

## How it works

It is not a "does this look like Figma?" screenshot comparison. It reads what your design system really defines in Figma (the tokens, and each component's parts, states and options) and checks your code against that, precisely. It also writes those facts out in a simple form, so AI tools build with the real design system instead of guessing.

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

- *"run the parity on the whole design system"*: checks everything
- *"run the parity on input"*: checks the `input` component (and its parts) and reports only that

Or from the terminal:

```bash
rms-figma-code-parity                       # the whole design system
rms-figma-code-parity --component input     # one component (or a few: input,button)
```

## What it checks

Every run compares your code against Figma and reports it in plain words:

- **Data is up to date:** you are checking against today's Figma, not an old copy.
- **Figma frame unchanged:** the design still looks like the version you approved.
- **Token values** match: colours, sizes and fonts, in every mode (light and dark).
- **Tokens used in** screens exist in the code: nothing a screen uses is missing.
- **Every mode is** covered: things that should change between light and dark really do.
- **Exception lists are** valid: your "ignore this" notes still point at real things.
- **No invented CSS** variables: every variable traces back to a real Figma token.
- **Docs tell the** truth: they mention only things that actually exist.
- **No invented text** casing: no forced UPPERCASE the design never asked for.
- **No hand-built DS** components: a screen uses the real component, not a hand-styled copy.
- **Clean CSS:** nothing unused, nothing that contradicts Figma.
- **Nested components keep** their own styles: one component's look does not leak into another.
- **Structure:** the right height, spacing and corners, from the design.
- **All states are** built: hover, disabled, selected and the rest, each with the right values.
- **Component props match** Figma: the same names, defaults and choices.
- **Sub-components match Figma:** the parts Figma nests are the ones the code uses.
- **Templates compose the** right components: each page uses the components Figma composes.
- **Markup:** ids, classes and icons match, and every control the design shows is built.
- **Required pieces are** in place: icon slots, component slots and form controls.
- **Icons:** from the shared set, drawn the same as Figma.
- **Transitions:** the durations and easings from the design.
- **Motion:** movement values match Figma, when your design defines them.
- **Shadows and blurs:** match Figma, when your design defines them.
- **Renders correctly in** a browser: checked on the real result, not just the code on paper.
- **What this audit** covered: so you can see nothing slipped through.

It also does an **accessibility** check: it flags anything that would make the design hard to use (text that is hard to read, a button with no label, something you cannot reach with the keyboard) and tells you, in plain words, how to fix it.

Everything is advice with a clear fix. It points at the problem, it does not silently change your code.

## That's it

Commit the files it creates so your whole team and CI check against the same design. The deeper setup and every option live in the full guide.

## License

[MIT](LICENSE) © Rafael Matos da Silva. Free to use, change and share. Just keep the copyright line.
