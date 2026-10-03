# Evaluation records

The runs behind the measurements in `RESULTS.md`, kept as they were scored, so each number can be checked and
summarized again. One folder per measurement; each `.jsonl` file is one side on one model:

- `mcp`: Claude with the Figma MCP alone (no skill, no engine, no hooks).
- `cookbook`: Claude with the Figma MCP and the skill (the guide set measured, the engine, its hooks).
- `g9`: the skill's guide set adopted as g9.

Every row holds the task, the run, whether it passed, each check with its detail, the rules every run keeps, what the
run cost and read, the files it changed and their text. Saved with `record.mjs`, which leaves out private tasks,
packages a run installed and anything past 40 KB in one file; transcripts stay out of the repository.

| Folder | What it measured | In RESULTS.md |
|---|---|---|
| `2026-10-02-guide-g9` | The skill's 20 guide tasks on the demo project, Sonnet and Haiku (engine 40906c4) | the g9 column of "building from Figma, the misses made deterministic" |
| `2026-10-03-build-sonnet-haiku` | Building from Figma, six tasks: Claude alone against Claude with the skill, Sonnet and Haiku (engine d8fc435) | "building from Figma, Claude with the Figma MCP alone against Claude with the Figma MCP and the skill" |
| `2026-10-03-prototype-sonnet` | Prototyping with the design system, three tasks, Sonnet (engine a425870; the skill side stopped at 6 runs) | "prototyping with the design system, and the guide that adds it" |
| `2026-10-03-opus-haiku-first` | Prototyping (three tasks) and building from Figma on Opus and Haiku, with and without the skill (engines ad08e42, e1c068f) | "prototyping with the design system, and the guide that adds it" |
| `2026-10-03-final-opus-haiku` | The engine at acb7808: six prototype tasks and the six builds on Opus and Haiku, with and without the skill (the builds without it copied from the earlier runs, which do not use the engine), and the 20 guide tasks on Haiku | "prototyping with the design system, and the guide that adds it" |
| `2026-10-03-misses-made-checks` | The misses made checks: six prototype tasks on Opus and Haiku with the skill (engine baeeefe), the six builds again (48bdb04), the 20 guide tasks on Haiku (baeeefe), beside the runs without the skill recorded before | "prototyping with the design system, and the guide that adds it" |

Summarize a folder: `node test/skill-evals/summarize.mjs test/skill-evals/records/<folder>`.
