# Skill evaluation results

## 2026-10: prototyping with the design system, and the guide that adds it (prototype evaluation and continuous evaluation)

What changed since the adopted version (engine b8145b9): `--prototype` checks a composition made only of the system's
components and the engine's neutral layout pieces, draws it with the components' own markup and CSS in every mode, and
lists what the system lacks; it can be asked for in words (the router and the `prototype` recipe), starts from the
screens designed in Figma (`--from-screens`), and puts everything the engine knows in front of Claude (Figma
descriptions and annotations, code notes, recorded decisions, guidelines from Notion, GitLab or the repository, the
templates, the designed screens), with what applies to the request. The check holds the guidelines' limits ("one button
per screen"), a use the documentation rules out, a component the request names and the prototype leaves out, and the
product's conventions across pages. The misses of the first measurements became checks: an `aria-label` written after a
props spread, a colour Figma has nowhere written in the theme file, a text colour set on a component's text part. The
guide changed in `rms-design-system-engine.md`, `cookbook/prototype.md` and `reference/usage.md`.

Guide set measured: `ad79498aa649` · Project measured: `13d811a9d668`

### Prototypes, Claude alone against Claude with the skill

Six requests on Tidepool, each asked in the same words on both sides: a notification settings page (a switch the
system lacks), a search page, an empty state, a profile page that must match the designed Settings screen, a dialog
whose guidelines allow one button, and a page whose guidelines come from GitLab and Notion links (a tag is never a
confirmation). The scorer does not use the engine: it reads what the run made for anything invented (a component, a
look, a colour or a size the system does not have), any change to the system's files, the system's components it was
asked to use, and whether the reply names what the system lacks. Claude alone has the Figma MCP output and the
repository, the guidelines included.

| Prototypes that pass | Claude alone | With the skill |
|---|---|---|
| Opus, 6 tasks × 3 runs | 13/18 · $3.64 · 5.4 turns a run | 18/18 · $3.61 · 3.8 turns a run |
| Haiku, 6 tasks × 3 runs | 2/18 · $1.57 · 19.4 turns a run | 17/18 · $1.27 · 5.6 turns a run |
| Sonnet, the first 3 tasks (engine a425870) | 2/15 · $5.92 | 6/6 · $0.92 |

| Task | Opus alone | Opus with the skill | Haiku alone | Haiku with the skill |
|---|---|---|---|---|
| Settings page (no switch in the system) | 0/3 | 3/3 | 0/3 | 2/3 |
| Search page | 3/3 | 3/3 | 0/3 | 3/3 |
| Empty state | 1/3 | 3/3 | 0/3 | 3/3 |
| Profile, like the designed Settings screen | 3/3 | 3/3 | 2/3 | 3/3 |
| Dialog, one button by the guidelines | 3/3 | 3/3 | 0/3 | 3/3 |
| Guidelines from GitLab and Notion links | 3/3 | 3/3 | 0/3 | 3/3 |

**Reading.** Without the skill every failure was an invention: Opus built its own Switch, drew an illustration, wrote
colours and sizes the system does not have (5 of its 18 runs); Haiku did so in 16 of 18, and twice changed the system's
own tokens file. With the skill nothing was invented on either model; what the system lacks is a labelled box on the
page and a line on the gaps list. Opus alone followed the written guidelines when they sat in the repository; the skill
makes them checks. The one miss with the skill: a Haiku run used the chip for the switches, which the catalog had
pointed to because its description says people "switch it on and off", and the reply did not say the system has no
switch. The skill side cost the same on Opus and less on Haiku, in far fewer turns.

### Builds and the guide tasks on the same engine

| | Earlier on this branch | This version |
|---|---|---|
| Builds, Opus with the skill (6 tasks × 3) | 18/18 (acb7808) | 18/18 · $5.65 (48bdb04) |
| Builds, Haiku with the skill (6 tasks × 3) | 16/18 (acb7808) | 18/18 · $1.93 (48bdb04) |
| Haiku, all 20 guide tasks (`new-ui-saved` at 10 runs) | 66/67 (acb7808) | 66/67 (baeeefe) |
| Haiku, held-out (3 runs each) | 18/18 · 89k | 18/18 · 95k |
| Haiku, mean cost a run | $0.057 | $0.057 |
| Rule violations | 0 | 1 (`guidelines-link`) |

The adopted version measured 67/67 and held-out 18/18 at 83k on Haiku (the entry below).

**Reading.** Every build passes on both models: the two Haiku misses before (a field with no text colour, an accessible
name lost a second way) became checks, and the field's text colour was missing from the Tidepool capture itself
(restored in `figma-structure.snapshot.json`). On the guide tasks the one miss moved: `new-ui-saved` now passes 10 of
10 (a green the system does not have is caught in the theme file), and one `guidelines-link` run asked the person for
the GitLab token in its first answer; the Stop hook sent it back and the final answer pointed to `.env`, but the person
would have read the first one, so it counts. Held-out input rose from 89k to 95k a run: one `change-figma` run took 7
turns (190k against 49k for the other two) and two `pasted-steps` runs took a third turn. By the adoption rule this is
not adopted on its own (a development task lower, held-out input higher); the decision is the owner's.

**Disclosed.** The prototype runs with the skill and the guide runs are on engine baeeefe; the builds were run again on
48bdb04, whose only engine change is the structure check accepting a text colour set on a component's text part (a
false failure of the reference field on baeeefe stopped two Haiku builds before they started). The runs without the
skill do not use the engine and are the recorded ones (acb7808, e1c068f, 8261d39, 6eb7baa). The build scorer accepts a
field named through its own `label` prop as well as `aria-label`; no run without the skill changed verdict. Records:
`records/2026-10-03-misses-made-checks`.

## 2026-10: every build from Figma checked as it renders, one style guide template, the old name gone (continuous evaluation)

What changed since the adopted version (engine f475251): in build mode a difference measured in the browser fails
and its fix always goes back to Figma; Figma's role annotation is read even when every prop is a state (a field whose
only prop is `State` still has to be an `<input>`); a component the pages do not show is drawn as the JSX it returns
(`jsx-markup.mjs`), so a `<span>` or an `<input>` is measured as one; when the rule already sets Figma's height and
the drawn box is another, the fix names the cause (an inline element, padding outside a content box); a path that
holds "figma" (`figma-mcp/`) is no longer read as "in Figma"; the Stop hook can send an owed line back a second time
when the first hand-back went to something else; `--styleguide` builds one style guide from the engine's template for
every project, showing only what Figma and the code agree on; the engine no longer recognises its old name. The
guide changed in `reference/usage.md` and `reference/config.md`. Engine b8145b9, the same 20 tasks on the same
project, compared with the adopted version; both scored by the current scorers.

Guide set measured: `8f7981d52194` · Project measured: `13d811a9d668`

| | Adopted (f475251) | This version |
|---|---|---|
| Sonnet, held-out (5 runs each) | 30/30 · 152k | 30/30 · 154k |
| Sonnet, all 20 tasks (`fix-first` at 10 runs) | 105/105 | 105/105 |
| Sonnet, mean cost / input per request | $0.140 / 33k | $0.137 / 33k |
| Haiku, held-out (3 runs each) | 18/18 · 89k | 18/18 · 83k |
| Haiku, all 20 tasks (`new-ui-saved` at 10 runs) | 67/67 | 67/67 |
| Haiku, mean cost / input per request | $0.056 / 26k | $0.055 / 26k |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Sonnet / Haiku) | 3.01 / 2.78 | 2.64 / 2.73 |

**Reading.** Every task passes on both models, as on the adopted version, and no rule is broken. On Haiku the rule
adopts it (held-out input 83k a run against 89k). On Sonnet the one count against it is input on the held-out set,
154k a run against 152k (1.3% more, most of it `refresh-no-figma`, 128k against 119k); it costs less a run and the
agent made fewer choices of its own. The rule says do not adopt on Sonnet; the guide change is two reference files,
and 2k is less than one guide moves from one hour to the next (g9 read 136k, then 144k when run again, in an earlier
entry). Adopted by the owner on these numbers.

**Disclosed.** Four Sonnet runs (`toggle-note` twice, `change-figma`, `forbidden-green`) timed out after 15 minutes
without a turn, the API not answering; they were run again and passed. The engine moved on after the guide runs (build mode's next steps, the build scorer, and a
variant written as its modifier class alone); none of it can turn a pass into a fail, and every guide run passed.

## 2026-10: building from Figma, Claude with the Figma MCP alone against Claude with the Figma MCP and the skill (build evaluation)

A project that has only Figma: the Tidepool design system as a real Figma file (two colour modes, a sizing
collection, two text styles, button, chip, field, tag, a Settings screen), no code. Six tasks, each asked in the same
words on both sides: build the tokens, the button, the chip, the field, the tag, then the Settings screen from the
components. Both sides get what the Figma MCP returns for the task (`get_design_context`, `get_variable_defs` and a
screenshot, captured once from the file and handed to both, so both see the same design). The MCP side has nothing
else: no skill, no engine, no snapshots, no hooks. The skill side has the skill, its hooks and the engine in build
mode. The scorer is the same for both and does not use the engine: it renders each component in Chrome with React,
measures every case (sizes, spacing, radius, colours in light and dark, hover, disabled, the element and its role)
against Figma, reads the CSS for values and variables the system does not have, and reads the final reply where a
task asks for a sentence.

Skill side: engine d8fc435, Claude Code 2.1.288. MCP side: Claude Code 2.1.287 (no engine). Scored by
`build-score.mjs` and `build-tasks.mjs`, every row rescored twice with no verdict changed.

| Builds that pass | Figma MCP alone | Figma MCP and the skill |
|---|---|---|
| Sonnet, 6 tasks × 5 runs | 16/30 · $6.42 · 16 turns a run | 30/30 · $9.86 · 18 turns a run |
| Haiku, 6 tasks × 3 runs | 4/18 · $0.86 · 10 turns a run | 18/18 · $2.02 · 14 turns a run |

| Task | Sonnet, MCP alone | Sonnet, with the skill | Haiku, MCP alone | Haiku, with the skill |
|---|---|---|---|---|
| Tokens, light and dark | 0/5 | 5/5 | 0/3 | 3/3 |
| Button (hover, disabled, dark) | 5/5 | 5/5 | 1/3 | 3/3 |
| Chip (sizes, icon, toggle role) | 1/5 | 5/5 | 0/3 | 3/3 |
| Field (error state, a real labelled input) | 3/5 | 5/5 | 0/3 | 3/3 |
| Tag (a colour Figma has no variable for) | 2/5 | 5/5 | 0/3 | 3/3 |
| Settings screen from the components | 5/5 | 5/5 | 3/3 | 3/3 |

**Reading.** Without the skill no run built the dark mode right: the MCP's design-to-code tools return the light
values only, so every dark colour was guessed. The skill's token list carries every mode. The other gaps are facts
Figma holds and the MCP's code does not pass on: the chip's toggle role and the field's text box (annotations), the
variables to use instead of literal colours, the tag's height. The skill side costs more and takes more turns: it
reads the build sheet, builds, and runs the engine's check until it passes. With the skill every build passed on
both models; the 30 Sonnet builds cost $9.86 against $6.42, the 18 Haiku builds $2.02 against $0.86.

**Disclosed.** The field's Figma component had no role annotation, so nothing asked for a real `<input>`; "Role:
textbox" was added to it in the Figma file and the fixture before the last round, the way the chip and the button
already carried theirs. Both sides see the same Figma; the MCP's outputs carry no annotations either way.

**Found by this evaluation and fixed** (each round measured from the start, every row rescored after each scorer fix):
- The engine never read a component's own stylesheet: build mode now records each stylesheet that holds a
  component's rules as a theme file.
- The edit check flagged a colour Figma paints with no variable as invented; it is now Figma's own value.
- The React prop reader lost every prop after a plain one, and a name recorded in `contract.authored.json` never
  counted.
- Engine f475251, Haiku 12/18: measured heights and line heights were advisory in build mode (now they fail, and the
  fix goes back to Figma); the role check skipped a component whose only prop is a state (two fields with no input);
  the router read the path `figma-mcp/` as "in Figma"; the owed sentence about the tag's colour was lost when the one
  Stop hand-back went to leftover values.
- Engine c3c4682, Haiku 16/18: the rendered check drew a component the pages do not show as a bare `<div>`, so a
  `<span>` tag that ignores its height and a field `<input>` with line-height 1 passed; and the fix line repeated
  "set 36px" while the rule already said 36px (one run tried four times, then reported the failure). Replayed on all
  48 builds, the fixed engine fails exactly the builds the scorer fails.
- Engine b8145b9, Haiku 15/18: two token runs went on to build every component and ran out of turns (the next step
  now builds a component only when the person asks); the scorer measured the field's wrapper or label instead of its
  input (fixed, both sides rescored).
- Engine a802c65, Haiku 17/18: a tag build reported the failing check instead of fixing it; in build mode the next
  step now says to fix each failing line and run again until it passes.
- Engine 38e9aad, Haiku 17/18: the variant check wanted the selector exactly as the build sheet wrote it
  (`.tag.tag--positive`) and failed `.tag--positive`, which selects the same element and which the browser measured
  right; the run looped, wrote a demo page so the engine would see the class, and stopped with the check failing.
  The modifier alone now counts, and a missing variant says how to add it.
- Scorer: the chip's icon was missed next to plain text and when the component kept Figma's text values; a 0.2 s
  colour transition was read mid-way.

**Limits.** One fictional design system, six tasks, five and three runs. The Figma file is small and the tasks are
built one at a time; a real system with many components and screens is the next test (a private run on the owner's
file, its results kept out of this repository). The two sides ran on consecutive Claude Code releases.

## 2026-10: building from Figma, the misses made deterministic, a smaller main guide (continuous evaluation)

What changed since g9 (engine 40906c4): build mode for a project that has only Figma, with its recipe
(`build-from-figma`) and build sheets; the router names the file a request means ("the gallery page"); the summary
says what to fix first, a tie included; the props check reads every destructured React prop, counts a name recorded
in `contract.authored.json`, and checks the markup a Figma role annotation asks for (a toggle is a `<button>` with
`aria-pressed`); the edit check hands back a token an edit invents and accepts a colour Figma itself paints with no
variable; the Stop hook holds the reply to the sentence it owes (a colour with no variable), sends back a reply that
asks for a secret, and runs the edit check once more over the files the session changed; the main guide file drops
three paragraphs only one recipe each needs (25.4 KB, from 27.9 KB). Engine f475251, the same 20 tasks on the same
project, compared with g9; both scored by the current scorers.

Guide set measured: `c5b201920acc` · Project measured: `13d811a9d668`

| | g9 (adopted) | This version |
|---|---|---|
| Sonnet, held-out (5 runs each) | 30/30 · 136k | 30/30 · 152k |
| Sonnet, all 20 tasks (`fix-first` at 10 runs) | 105/105 | 105/105 |
| Sonnet, mean cost / input per request | $0.140 / 34k | $0.140 / 33k |
| Haiku, held-out (3 runs each) | 17/18 · 98k | 18/18 · 89k |
| Haiku, all 20 tasks (`new-ui-saved` at 10 runs) | 65/67 | 67/67 |
| Haiku, mean cost / input per request | $0.057 / 26k | $0.056 / 25k |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Sonnet / Haiku) | 2.56 / 2.69 | 3.01 / 2.78 |

g9 run again on Sonnet's held-out set at the hour this version was measured: 30/30, 144k a run, 35k a request,
$0.168 a run; this version 30/30, 152k, 34k, $0.168.

**Reading.** Every task passes as often or more often on both models, and no rule is broken. On Haiku the rule
adopts it (held-out 18/18 against 17/18, less input). On Sonnet every task passes and the one count against it is
input on the held-out set: 152k a run against 136k. g9, run again at the same hour, read 144k, so about half of that
is the hour (as the rename's entry recorded for `pasted-steps`); the rest is two tasks where Sonnet ran one
exploratory command more (`no-cli-on-path`, `pasted-steps`). It reads less per request and costs the same per run.
Adopted by the owner on these numbers.

**Found by this evaluation and fixed** (four rounds, each measured from the start):
- Engine 0ce7b3d: Sonnet `fix-first` 9/10 (the burndown was a tie and the summary named no first); Haiku
  `new-ui-saved` 8/10 (one run asked which file the gallery page is, one declared `--success-background` in the theme,
  which the edit check did not read).
- Engine 82d11ec: the new check for an invented token mapped sizing tokens with the colour convention, so a copied
  `--stroke-default` looked invented and every build-tokens run deleted it; the scorer read "a hex/token to use" as a
  request for a secret (both Sonnet `new-ui-saved` misses); one Haiku run asked the person to provide a GitLab token.
- Engine da8f07c: a Haiku run got the edit check's warning about a green the system lacks, asked which colour to use,
  and left the green in the page: the Stop hook now checks the changed files once more.
- The eval transcripts do not record hook feedback; a short run confirmed the edit check reaches the model.

## 2026-10: primitives, --only, the agent kept from making a check pass, each edit read for accessibility and sizes, the final check of the reply (continuous evaluation)

What changed since the rename (engine 28aa8ba): a primitive written by hand (I42); `--only` runs the
accessibility check, the Figma checks or some gates, and the router sends "only the accessibility of the button"
there; the hooks ask before the agent accepts a difference, adds an exception or replaces an approved picture, and
hand back a comment that switches a check off (I73); each UI edit is also read for accessibility (I74) and for
sizes written by hand (I75); the browser check opens dialogs and menus from their trigger and checks that Escape
gives the focus back (I78), and an app page has one main heading (I79); a Stop hook sends the agent back once when
its last reply leaves out a line the route asked the person to hear (I81, first part). The guide changed in the
hooks paragraph of the main file, `reference/usage.md`, `reference/config.md`, `reference/maintainers.md` and
`cookbook/ci-and-hooks.md`. Engine 98e474b, the same 22 tasks on the same project, compared with the rename's
measurement; both scored by the current scorers.

Guide set measured: `281780c63cb3` · Project measured: `13d811a9d668`

| | Rename (adopted) | This version |
|---|---|---|
| Sonnet, held-out (5 runs each) | 40/40 · 131k | 40/40 · 135k |
| Sonnet, all 22 tasks | 110/110 | 110/110 |
| Sonnet, mean cost / input per request, 22 tasks | $0.142 / 130k | $0.142 / 131k |
| Haiku, held-out (3 runs each) | 24/24 · 81k | 24/24 · 89k |
| Haiku, all 22 tasks | 66/66 | 66/66 |
| Haiku, mean cost / input per request, 22 tasks | $0.053 / 78k | $0.054 / 81k |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Sonnet / Haiku) | 2.67 / 1.86 | 2.70 / 1.91 |

Every task that read more, on both models, was run to 13 runs on both versions (mean input per request):

| Task (13 runs each) | Rename | This version |
|---|---|---|
| Haiku `refresh-no-figma` (held-out) | 13/13 · 76k | 13/13 · 62k |
| Haiku `pasted-steps` (held-out) | 13/13 · 110k | 13/13 · 62k |
| Haiku `forbidden-green` (held-out) | 12/13 · 72k | 13/13 · 100k |
| Haiku `private-badge-pt` (held-out) | 13/13 · 87k | 13/13 · 90k |
| Haiku `audit-all`, `first-setup` | 13/13, 13/13 · 51k, 96k | 13/13, 13/13 · 57k, 97k |
| Sonnet `pasted-steps` (held-out) | 13/13 · 122k | 13/13 · 154k |
| Sonnet `forbidden-green` (held-out) | 13/13 · 102k | 13/13 · 102k |
| Sonnet `private-statusbar` (held-out) | 13/13 · 98k | 13/13 · 117k |
| Sonnet `toggle-note` | 10/13 · 65k | 13/13 · 91k |
| Sonnet `visual-howto`, `disabled-hover` | 13/13, 13/13 · 31k, 111k | 13/13, 13/13 · 36k, 125k |

**Reading.** Every task passes on both models, no rule is broken, and over the repeats no task passes less often
(`toggle-note` on Sonnet and `forbidden-green` on Haiku pass more often). On the held-out set over all runs Haiku
reads 4% less; Sonnet reads 2% more, all of it from `pasted-steps`. That task moves with the hour: the rename,
unchanged, read 122k on 13 runs in the morning and 140k on 13 more in the evening, against 143k and 144k for this
version in the evening (with its own guide, and with the rename's main file in place of its own). What remains is
that on this engine Sonnet sometimes loads the skill again at its first step of that task (4 to 8 runs in 13,
none on the rename); nothing it reads before that step differs. Adopted by the owner on these numbers, the 2% on
Sonnet's held-out input noted.

**Found by this evaluation and fixed.**
- A first measurement (engine dd847e2) ran on another project: the I42 commit had added its example to the demo
  every run works on, next to the page the UI tasks edit. The demo is back to the rename's project, the example is
  laid over it only by the tests that need it, and every run and this file record the project's hash.
- The guard read the person's message wrong in the most common session. A request made as
  `/rms-design-system-engine <words>` reaches the transcript followed by the whole guide Claude Code expands it into,
  and the guard took the guide for the message: it holds every word the rules listen for, so a code edit and
  `--baseline` passed without asking. It now reads the command's words and skips what Claude Code adds.
- In the second measurement (engine 1e906e5) two Haiku `refresh-no-figma` runs out of 13 never said the snapshots
  were not refreshed. The Stop hook now checks the last reply says it, and sends the agent back once with the line.

## 2026-10: the skill renamed to rms-design-system-engine (continuous evaluation)

A fresh run of the adopted guide after the rename: the command, the terminal command, the install folder, the
guide's file name and the files the engine keeps in a project have the new name (`rms-design-system-engine`,
`design-system-engine-*`); the guide's text changed only in those names and its title. Engine 28aa8ba. The same 22
tasks, each run as `/rms-design-system-engine <task>`. Compared with the I69 measurement below (engine 51d0466), its
first runs of each task up to the same count; both scored by the current scorers.

Guide set measured: `eab10f44308d` · Project measured: `13d811a9d668` (recorded later, when the project's hash was added)

| | I69 (adopted) | Renamed |
|---|---|---|
| Sonnet, held-out (5 runs each) | 40/40 · 133k | 40/40 · 131k |
| Sonnet, all 22 tasks | 110/110 | 110/110 |
| Sonnet, mean cost / input per request, 22 tasks | $0.141 / 127k | $0.142 / 130k |
| Haiku, held-out (3 runs each) | 24/24 · 96k | 24/24 · 81k |
| Haiku, all 22 tasks | 66/66 | 66/66 |
| Haiku, mean cost / input per request, 22 tasks | $0.057 / 87k | $0.053 / 78k |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Haiku) | 2.0 | 1.9 |

**Reading.** Every task passes on both models under the new name and no rule is broken. The adoption rule passes
on the held-out set for both models, with less input. Over all 22 tasks Sonnet read 2% more, from `new-ui-saved`
(380k to 470k per request): its five runs range from 199k to 521k on I69 and from 402k to 601k now, the longest a run
that stopped to ask which way to go, so the difference is within what single runs of this task vary by. No run used
the old command or failed to find the new one: the engine was called as `rms-design-system-engine` or through
`~/.claude/skills/rms-design-system-engine/audit.mjs`, in the same proportions as under the old name.

**Found by this evaluation and fixed (in the scorers, not the skill).**
- The scorers' list of files the engine writes on every run still named the agreed record and the
  history by their old names, so in every `props-question` run and two `toggle-note` runs (7 on Sonnet, 3 on Haiku) the
  engine's own `design-system-engine-agreed.json` and `-history.json` first counted as files the agent changed. The
  list now has both names, and a run saved before the rename is read with its files and command under their new
  names: scored again with these scorers, the 236 runs of the I69 measurement keep every verdict.
- One Sonnet `new-ui-saved` reply, which suggested asking the designer to "give it an actual fill/color token", was
  read as asking for a secret. A design token (a colour, fill or spacing token) is not one; the case is in the
  scorer's test.

## 2026-09: renamed instances in the Figma hygiene record (idea I69)

A fresh run of the adopted guide (the `cookbook` variant, the checkout) after the full-audit recipe's hygiene
snippet learned to record an instance whose layer spells its component's name another way. Engine 51d0466. 22
tasks: `new-ui-saved` (build a new screen with the design system, the router sending it to `ask-the-system`) is
new. Compared with the adopted measurement above (engine 2365d8a), its first runs of each task up to the same count.

Guide set measured: `8b6372801eb8`

| | Adopted | This guide |
|---|---|---|
| Sonnet, held-out (5 runs each) | 40/40 | 40/40 |
| Sonnet, the 21 common tasks | 104/105 | 105/105 |
| Sonnet, mean cost / input per request, 21 tasks | $0.138 / 118k | $0.138 / 115k |
| Haiku, held-out (3 runs each) | 24/24 | 24/24 |
| Haiku, the 21 common tasks | 63/63 | 63/63 |
| Haiku, mean cost / input per request, 21 tasks | $0.052 / 69k | $0.055 / 74k |
| `new-ui-saved` (new) | | Sonnet 5/5 · Haiku 3/3 |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Haiku) | 1.5 | 1.6 |

**Reading.** Every task passes on both models and no rule is broken. On Sonnet the adoption rule passes (input
118k to 115k, held-out 136k to 133k). On Haiku input was higher at 3 runs (held-out 81k to 96k), in six tasks
where some runs read the full-audit recipe before running the command the router gave, or listed the project
first. The recipe grew by 545 bytes, so those six were run to 13 runs on both versions, the protocol I56 used:

| Haiku, 13 runs each | Adopted | This guide |
|---|---|---|
| refresh-no-figma, pasted-steps, forbidden-green, private-statusbar, audit-all, visual-howto | 77/78 | 78/78 |
| Mean input / cost per request on these six | 69k / $0.051 | 65k / $0.052 |

With 13 runs the input is lower, not higher: the 3-run difference was which runs chose to read the recipe. The
adopted guide's one miss, read by hand: on refresh-no-figma the reply said the audit used today's committed
snapshots but never said the Figma data could not be refreshed here.

## 2026-09: change only what was asked, one named difference, and the guide for I62 to I68 (continuous evaluation)

A fresh run of the adopted guide (the `cookbook` variant, the checkout) after guide changes: an Audit Rule to
change only what was asked, the `ask-the-system` recipe, `--match` in the accept-debt recipe (never narrow
the accepted-debt file by hand), and the reference for the edit check (I62), the Figma call budget (I67), the
llms.txt mandate (I63), the hidden expected component and prompt check in evals (I64, I68) and Tailwind (I65).
Engine 2365d8a: the hooks every run installs include the edit check. 21 tasks: `props-question` is new. Both
this guide and the adopted one (engine c3fd998) are scored by the current scorers: the `accept-radius` scorer
now also requires everything else to stay strict, and every saved run of both was scored again.

Guide set measured: `59ea4c33daac`

| | Adopted (rescored) | This guide |
|---|---|---|
| Sonnet, held-out (5 runs each) | 40/40 | 40/40 |
| Sonnet, the 20 common tasks | 95/100 | 100/100 |
| Sonnet, mean cost / input per request, 20 tasks | $0.143 / 124k | $0.139 / 118k |
| Haiku, held-out (3 runs each) | 24/24 | 24/24 |
| Haiku, the 20 common tasks | 54/60 | 60/60 |
| Haiku, mean cost / input per request, 20 tasks | $0.055 / 75k | $0.052 / 67k |
| `props-question` (new) | | Sonnet 4/5 · Haiku 3/3 |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Haiku) | 1.6 | 1.4 |

**Reading.** Every common task passes on both models where the adopted guide missed 5 on Sonnet and 6 on
Haiku, and no rule is broken. Input is lower over the 20 tasks on both models, and on the held-out set for
Haiku (95k to 81k). On the Sonnet held-out set it was 3% higher at 5 runs (132k to 136k), so the held-out tasks
whose input grew were run to 13 runs on both versions, and so were the four Sonnet tasks that grew in the
previous measurement, the protocol I56 used:

| Sonnet, 13 runs each | Adopted (rescored) | This guide |
|---|---|---|
| two-turns-pt, forbidden-green, change-figma (held-out) | 39/39 · 183k / $0.202 | 39/39 · 190k / $0.206 |
| audit-all, accept-radius, private-badge-pt, fix-first | 42/52 · 112k / $0.138 | 52/52 · 112k / $0.136 |
| Haiku, two-turns-pt | 33/33 | 13/13 |

With 13 runs the held-out difference is about 4% more input per request, the same as in the previous
measurement: mostly noise, the rest the longer report. accept-radius, which the adopted guide got right 3 times
in 13, is right every time and cheaper (98k to 69k): one routed command instead of a hand edit.

**The misses the adopted guide had.** Asked to accept only the chip's radius and keep everything else strict,
most runs of the adopted guide accepted every failing line of the chip, its prop names too: `accept-radius`
2/5 and `accept-radius-pt` 3/5 on Sonnet, 0/3 and 0/3 on Haiku. The old scorer passed them (it checked only
that the radius was accepted). `--baseline --findings --match radi`, which the router adds when the person
names the kind of difference, accepts that line alone: 5/5, 5/5, 3/3, 3/3.

**Found by this evaluation and fixed.**
- Two intermediate guides were measured and not recorded. The first (the `ask-the-system` recipe alone) had
  2 of 33 Haiku runs of `two-turns-pt` rename the chip's props when asked only for its height, against 0 of 33
  on the adopted guide: the rule to change only what was asked lived only in the fix recipe, which those runs
  never opened. It is now an Audit Rule, and the routed fix note says it too (33/33 after). The second showed
  the `accept-radius` narrowing by hand (7 of 13 Sonnet runs), the reason for `--match`.
- One Sonnet `props-question` run stopped to ask whether it could run the audit, because `--query` said there was
  no catalog yet. `--query` now runs the audit itself the first time (94ee399).

## 2026-09: the guide after I57, I58, I34, I23, I44 and exact prop names (continuous evaluation)

A fresh run of the adopted guide (the `cookbook` variant, the checkout) after guide changes: the flex-shrink
rule made advisory, the focus-ring note on literals, the Figma hygiene record in the value sweep, and the
props gate's NAME difference. Same tasks, runs and scorers as I56; engine c3fd998. Compared with the adopted
I56 measurement, its first runs of each task up to the same count.

Guide set measured: `8fe89ab23319`

| | I56 (adopted) | This guide |
|---|---|---|
| Sonnet, all 20 tasks (5 runs each) | 100/100 | 100/100 |
| Sonnet, mean cost / input per request | $0.130 / 121k | $0.143 / 124k |
| Haiku, all 20 tasks (3 runs each) | 60/60 | 60/60 |
| Haiku, mean cost / input per request | $0.047 / 65k | $0.055 / 75k |
| Rule violations (both models) | 0 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Haiku) | 1.3 | 1.6 |

**Reading.** Every task passes on both models and no rule is broken. The adoption rule passes for Sonnet and
not for Haiku, on input tokens alone: a request that ran the audit once costs the same (49k) as before; the
difference is in runs where Haiku took extra steps (opening the skill through the Skill tool before the
command, reading the recipe and the config first, splitting the audit output with head and tail). Three runs
per task cannot tell that from noise, so the six tasks whose input grew were run to 13 runs on both versions,
the protocol I56 used for a lower pass rate:

| Haiku, 13 runs each | I56 (adopted) | This guide |
|---|---|---|
| forbidden-green, pasted-steps, fix-first, first-setup, refresh-no-figma, audit-all | 76/78 | 78/78 |
| Mean input / cost per request on these six | 71k / $0.048 | 74k / $0.052 |

With 13 runs the difference is about 4% more input per request, not 21%: mostly noise, the rest the longer
report (the new checks print more). The two I56 misses, read by hand: on refresh-no-figma the reply called
the snapshots current and never said the refresh had not happened (one only implied it). This guide's
no-refresh SAY line names how to give Figma access, and it had no miss. Two of this guide's forbidden-green
replies first scored as misses were scorer false negatives ("the snapshots aren't actually stale", "are
actually current"); the scorer was fixed and every saved run scored again.

**Found by this evaluation and fixed.** One Sonnet run, in a first pass on the previous guide, ended by
offering to take "Figma access (MCP tool or token)", which the never-ask-for-a-token rule counts as a
violation. The no-refresh SAY line now says how to give access: the Figma MCP server, or FIGMA_TOKEN in the
project's .env file, never in the chat. No violation in this run.

## 2026-09: a bare guide, the engine's router and nothing else (idea I61)

The `bare` variant (`variants.mjs`, 449 bytes) only says to run `--route` and do what it prints. Same tasks, runs and
engine as the adopted I56 measurement (158802e; the harness file carrying the variant marks it +dirty).

| | Adopted guide (I56) | Bare |
|---|---|---|
| Sonnet, all 20 tasks | 100/100 | 100/100 |
| Sonnet, mean cost / input per request | $0.130 / 121k | $0.118 / 122k |
| Haiku, all 20 tasks | 60/60 | 59/60 |
| Haiku, mean cost / input per request | $0.047 / 65k | $0.046 / 76k |
| Rule violations | 0 | 1 |

**Decision.** Not adopted: a new rule violation, and almost no saving (the adopted guide is about 7k tokens of the
120k a request reads; the audit's output is the rest). The violation: without the guide, Haiku on refresh-no-figma ran
an internal script by hand, edited `src/theme.css` unasked and tried to commit (the hook refused the commit). The edit
got through because the hook read "the design changed yesterday" as a request to change something; the hook now counts
only the asking forms of a change verb (fixed after this measurement).

## 2026-09: deterministic core, thin agent layer (idea I56)

Same harness, tasks and scorers as the cookbook measurement below; every saved run of all variants scored again with
the final scorers. I56 is the cookbook guide plus decisions moved from the model into the engine: `--route` picks the
recipe and the exact command; the project's hook routes each `/rms-design-system-engine` request before the agent reads
it; `SAY:` lines give the exact words for what the skill cannot do (change Figma, refresh without a Figma tool); the
SUMMARY says whether the Figma data was refreshed; the hooks read the person's latest message before a code edit or
the hand-back apply; accepting debt is scoped to a named component, and a scoped `--baseline` keeps the rest of the
file. Engine 158802e.

Guide set measured: `60eff78d1beb`

| | Baseline | Cookbook | I56 |
|---|---|---|---|
| Sonnet, all 20 tasks (5 runs each) | 100/100 | 100/100 | 100/100 |
| Sonnet, mean cost per request | $0.68 | $0.19 | $0.13 |
| Sonnet, mean input tokens per request | 730k | 224k | 121k |
| Haiku, held-out tasks | 26/34 (76%) | 22/24 (92%) | 34/34 (100%) |
| Haiku, all tasks | 96/110 | 62/67 | 110/110 |
| Haiku, mean cost per request | $0.23 | $0.06 | $0.04 |
| Haiku, mean input tokens per request | 368k | 95k | 55k |
| Rule violations (both models) | 5 | 2 | 0 |
| Choices the agent made that no `NEXT:` line gave, per request (Haiku) | 2.4 | 2.3 | 1.1 |

Haiku ran 13 times on the five tasks the earlier variants had re-run, so each comparison has the same counts
(against the cookbook, the first runs of each task up to its count).

**Decision.** Adopted: the adoption rule passes against the baseline and against the cookbook, on both models.

**Found by the evaluation and fixed along the way.** A scoped `--baseline` rewrote the accepted-debt file with only
that component's findings, dropping every other accepted line; an accessibility check the browser was slow to answer
disappeared from the report instead of being reported as not checked (seen as an intermittent demo failure under
load). Five scorer misreads, each fixed with a case in `test/skill-evals.test.mjs`.

## 2026-09: the guide split into a main file, recipes and reference (idea I55)

Isolated headless runs (`claude -p "/rms-design-system-engine <task>"`), scored by code, every run scored again with
the final scorers (`rescore.mjs`). Baseline is the one-file guide (tag `guide-monolith`); cookbook is the split guide
after the fixes the first measurement asked for (commit 3318dd8). Same engine for both (6707623 for the engine code).
Private held-out tasks run on a real library and are named A and B here.

| | Baseline | Cookbook |
|---|---|---|
| Sonnet, all 20 tasks (5 runs each) | 100/100 | 100/100 |
| Sonnet, mean cost per request | $0.68 | $0.19 |
| Sonnet, mean input tokens per request | 730k | about 260k |
| Haiku, held-out tasks | 76% | 92% |
| Haiku, all tasks | 96/110 | 62/67 |
| Haiku, mean cost per request | $0.23 | $0.06 |
| Haiku, rule violations | 4 | 1 |

Haiku per task (baseline against cookbook; tasks that dropped on the first measurement were run 10 more times on the
baseline): toggle-note 13/13 against 9/10, the one task lower on the cookbook; pasted-steps 0/3 against 2/3,
refresh-no-figma 0/3 against 2/3, forbidden-green 2/3 against 3/3, first-setup 2/3 against 3/3, no-cli-on-path 12/13
against 3/3, audit-all 12/13 against 3/3; the rest equal.

The baseline's Haiku violations: source code changed without a request (three runs) and an HTML report file written;
the cookbook's one violation is an HTML report file on the pasted step list that asked for one.

**Decision.** Adopted (the owner's call). On the strict rule the cookbook passes on Sonnet and falls one run short on
Haiku's toggle-note, a routing miss that idea I56 moves into the engine.

**Found by the evaluation and fixed along the way.** `--init` wrote every dark mode as a media query (the
theme's data attribute was ignored); the guide pointed the no-CLI fallback at the wrong folder; questions were
answered from the index without the recipe; audits and refreshes were claimed without output. Open: the hook asks
again before a hand-back apply the person already asked for (I56).

**What a native Skill (`SKILL.md`) measured.** Sonnet 99/100 at $0.19; Haiku 42/60, with Haiku opening the skill
instead of running the engine and asking instead of running a pasted request. Not adopted.
