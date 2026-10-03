# Case study. Design system work with Claude, with and without rms-design-system-engine

**The question.** A team already has Claude, its repository and the Figma MCP. What does adding the skill change in what gets built?

**The answer, measured.** Work made with the skill matches the design system far more often, on every model. Nothing is invented. Every colour mode is right, and the team gets a list of what its system is missing. A small, cheap model with the skill beats the most capable model without it.

## How it was measured

- **Same request, same data, two sides.** Each task is asked in the same words. Both sides get the same project and the same Figma MCP output. One side has Claude alone (Figma MCP plus the repository). The other has Claude with the skill (its guide, its engine and its hooks).
- **Scored by code, not by eye.** Builds are rendered in Chrome and measured against Figma (sizes, spacing, radius, colours in light and dark, hover, disabled, the HTML element and its role). Prototypes are read for anything invented, any change to the system, and whether the reply names what the system lacks. The scorer does not use the engine, so it judges both sides the same way.
- **Three models.** Opus (the most capable), Sonnet and Haiku (the smallest and cheapest). 3 to 13 runs per task.
- **A fictional design system.** Tidepool, a real Figma file with two colour modes, button, chip, field, tag and a Settings screen. Every run is kept in `test/skill-evals/records/`, and the full log of every measurement is in `test/skill-evals/RESULTS.md`.

## Results

### 1. Building components and screens from Figma

Six tasks. Build the tokens, the button, the chip, the field, the tag, then the Settings screen.

| Model | Claude alone | With the skill |
|---|---|---|
| Opus | 8 of 18 | 18 of 18 |
| Sonnet | 16 of 30 | 30 of 30 |
| Haiku | 4 of 18 | 18 of 18 |

- **Dark mode.** No run without the skill got the dark colours right, on any model (0 of 11). The MCP returns one mode, so every dark value was guessed. The skill reads every mode.
- **What Figma knows and the code missed.** The chip's toggle role and the field's real text input come from Figma annotations. Variables replace literal colours, and the tag keeps its exact height. Without the skill these were missed or guessed.
- **Every miss with the skill becomes a check.** Opus with the skill first passed 16 of 18. Both misses overwrote an accessible name passed in by the caller. The engine now catches that pattern in every edit, and the next run passed 18 of 18. Haiku then missed two builds, a field with no text colour and a second way of losing the accessible name. Both became checks, and Haiku passed 18 of 18.

### 2. Prototyping with the design system

The designer asks for a screen. The rule is to use only the system's components, change nothing in the system, and say what is missing.

| Model | Claude alone | With the skill |
|---|---|---|
| Opus, six tasks | 13 of 18 | 18 of 18 |
| Haiku, six tasks | 2 of 18 | 17 of 18 |
| Sonnet, three tasks | 2 of 15 | 6 of 6 |

- **Without the skill, every failure was an invention.** Opus built its own Switch component, drew its own illustration, and wrote colours and sizes the system does not have. Two Sonnet runs changed the system's own tokens file.
- **With the skill nothing is invented.** A need the system cannot meet becomes a labelled box on the page and a line on the gap list for the design team, for example "on/off switch, closest in the system is the chip".
- **Documentation and consistency.** Two of the six tasks follow the team's written guidelines (one button per screen, a tag is never a confirmation, including guidelines fetched from GitLab and Notion). One keeps a new page consistent with the designed Settings screen. Opus alone passed these when the documentation sat in plain view in the repository. The skill also makes them checks. A prototype that breaks a written limit is not drawn, and a component the documentation rules out cannot stand in.

### 3. The skill's own efficiency

The same 20 everyday tasks (audit a component, fix a difference, refresh from Figma, accept known debt, build a new screen) were measured across the skill's versions.

| | First version | Today |
|---|---|---|
| Sonnet, cost per request | $0.68 | $0.13 to $0.14 |
| Haiku, held-out tasks passed | 76% | 100% |
| Rule violations, both models | 5 | 0 |

A rule violation is changing code nobody asked for, committing unasked, writing files nobody wanted, or asking for a secret in the chat. Each new version is adopted only when it passes as often and breaks no rule.

## What this means for a team

1. **What gets built matches the design system.** Every component is measured against Figma in the browser and fixed until it matches. In light and dark, in every state.
2. **Nothing is invented, and gaps become visible.** Claude uses only what exists. Everything it needed and could not find goes on one list, counted across screens, so the design team sees the most needed missing pieces first.
3. **The team's knowledge is used every time.** Figma descriptions and annotations, code notes, recorded decisions, and guidelines from Notion, GitLab or the repository are put in front of Claude for each request. The rules that can be checked are checked.
4. **Pages of one product stay consistent.** A new page is compared with the designed screens and the pages already made.
5. **A cheaper model does the job.** Haiku with the skill beat Opus alone at building from Figma (18 of 18 against 8 of 18, for $1.93 against $2.49) and at prototyping (17 of 18 against 13 of 18, for $1.27 against $3.64).
6. **It is safe to hand to anyone.** The system's files are never changed unasked. A commit, an accepted difference or a silenced check asks a person first. A secret is never asked for in the chat.
7. **Every claim is checked.** The same scorers run on every version. Every run is saved, and a result can be summarized again from the records at any time.

## What it costs

Building from Figma costs more with the skill, because Claude checks its work and fixes it until it passes.

| Builds | Claude alone | With the skill | Per passing build, alone | Per passing build, with the skill |
|---|---|---|---|---|
| Sonnet, 30 builds | $6.42 | $9.86 | $0.40 | $0.33 |
| Opus, 18 builds | $2.49 | $5.65 | $0.31 | $0.31 |
| Haiku, 18 builds | $0.86 | $1.93 | $0.22 | $0.11 |

Prototyping costs about the same or less with the skill, because Claude does not explore and build components of its own ($3.61 against $3.64 for 18 Opus prototypes, $1.27 against $1.57 for 18 on Haiku). The cheapest way to a build that matches is Haiku with the skill, at about $0.11 for each one that passes.

## Limits

- **One small system.** Tidepool has four components and one screen, so Claude alone can read all of it in a few steps. The skill should matter more on a real system with many components, documentation spread across tools and many screens. Tests on a real, private system are kept out of this repository.
- **Opus alone is strong when the task is simple and the documentation is easy to find.** Most of the skill's measured gain on Opus is enforcement. It does not invent, it checks every mode, and it does not stop until the checks pass.
- **Not every run passes.** Haiku with the skill missed one prototype (it used the chip for a switch and did not say the system has no switch) and one of 67 everyday task runs (its first answer asked for a GitLab token in the chat, which the engine sent back). Each is recorded with its run, and each is the next check to add.

## Reproduce

- `node test/skill-evals/run.mjs --variant mcp|cookbook --model <model> --set build|prototype|all --runs <n>` runs a measurement.
- `node test/skill-evals/summarize.mjs test/skill-evals/records/<folder>` prints its tables.
