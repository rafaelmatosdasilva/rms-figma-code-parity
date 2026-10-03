# /rms-design-system-engine - the engine of a design system

**In one line:** given a Figma design system and its codebase, decide whether the code
matches the design, and emit machine-readable facts (real token names, values, selectors
and component relationships) that other tools and AI agents can consume without guessing.

**The model — four layers:**
- **Facts** — what Figma has: the captured snapshot + the DTCG `tokens.json`.
- **Contracts** — what the code must satisfy: `<component>.contract.json`.
- **Intent** — why it exists and how it should be used: `design-intent.json`.
- **Evaluation** — whether generated code satisfies those constraints: the evals (feed
  `evals-history.json`, an advisory trend — never the source of truth).

Two deterministic checks stand on the Facts: **parity** (the repo's OWN code vs Facts — is the DS
right?) and **evaluation** (an agent's GENERATED code vs Contracts + Intent — does the agent use the
DS right?). The mechanical checks are the authority; an LLM judge is optional and secondary, never
the primary validator.

**What it does:** Verifies that the code matches Figma. Every gate compares what Figma
defines against what the code implements - nothing more. It does not lint style or judge
the design; it only answers "does the code agree with Figma?". The gates cover:

| What it checks | What passing means |
|---|---|
| **Code matches Figma** | Token values, alias chains per mode, structure, tokens used in screens, icons, states all agree with Figma |
| **Data is up to date** | The Figma snapshots and build output are current, so you are never auditing a stale picture of the DS |
| **Clean CSS** | No unused variables, no values that contradict Figma, no parent rule overriding a child component |
| **What the audit covered** | Which DS components and states the audit actually reached - so gaps are visible, not silent |

**Why this matters for AI:** an agent never has to infer the design system from a Figma
file and invent component names, token values or selectors. It reads the verified facts
this skill emits (the contract and `llms.txt`), so what it builds is grounded, not guessed.

> ## ⛔ INVARIANT — parity runs on ANY Figma plan (non-negotiable)
>
> **No gate or refresh may call a plan-gated Figma endpoint.** Every snapshot the audit needs is
> produced by the **Plugin-API capture (Phase 1, Step 1c)** — which works on every plan and needs no
> special access — and committed to the repo. The Node audit only reads those committed snapshots and
> refreshes the few it can via endpoints that work on any plan; it never depends on a plan-specific
> API. A run that finds a stale snapshot must refresh it with the Plugin-API capture and **still go
> green**; if it cannot, that is a capture bug to fix — not a plan to blame.
>
> **Forbidden "fixes" (they re-introduce a plan dependency this rule exists to kill):** raising or
> removing `maxSnapshotAgeDays` to get past a stale snapshot; skipping/downgrading a gate because a
> refresh could not run; or committing with a bypass. If you ever feel the need to do one of these,
> the correct action is to run the Plugin-API capture instead.
> Do not weaken this rule in a later edit — it is the whole reason the engine is plan-agnostic.

**Report in the chat, in plain English.** The audit prints a gate summary to the
console; relay those results to the user directly in the conversation, in plain language -
which gates passed, which failed, and what each failure means. The parity output is
**always the conversation** - the skill never produces a file, document, or HTML report as
its result. Never declare parity while anything is red. **An audit request is a request to report, not to
fix:** report what is red and what the fix is, and change code, config or snapshots only when the person asks
for that fix.

## Recipes and reference (read the one that fits before acting)

**Start every request with the router.** When the request already came with a `ROUTE:` block (the project's
hook routed it), follow that block. Otherwise run the router, passing the request exactly as the person wrote it:
`rms-design-system-engine --route "<the request>"` (not on PATH: `node ~/.claude/skills/rms-design-system-engine/audit.mjs
--route "<the request>"`). It prints the recipe that fits, the exact command to run (`RUN:`), any rule that applies
(`NOTE:`), the sentences to say (`SAY:`), one `NEXT:` line, and the recipe itself. Do what it prints: run the `RUN:`
command and relay its SUMMARY, or, when it says to run nothing, answer from the recipe it printed. Put each `SAY:`
line in your final reply word for word (when it names a condition, only when that condition holds). Do not pick a
recipe or a command yourself.

This guide holds the rules that always apply. The steps for each task are in a **recipe**: before acting, print
the one that fits with `rms-design-system-engine --recipe <name>` (or read
`~/.claude/skills/rms-design-system-engine/cookbook/<name>.md`, the skill's install folder). Follow it, relay the
engine's SUMMARY, and take its NEXT line. If no recipe fits, read the reference. **A question is a task too**
("how do I…", "what does … mean", "why does …"): print its recipe first and answer from what the recipe and the
reference it points to say, never from memory or from this table alone.

| When the person wants | Recipe |
|---|---|
| to check one component or part ("audit the chip", "verifica o badge") | `audit-component` |
| the whole design system checked | `full-audit` |
| the Figma data refreshed, or it is stale | `refresh-figma` |
| to set the parity up (no `ds-config.json` yet) | `first-setup` |
| to add a GitLab or Notion guidelines link | `guidelines-links` |
| a difference fixed (in code, or what to change in Figma) | `fix-a-difference` |
| known differences accepted as debt | `accept-debt` |
| states, variants or combinations mapped or explained | `states-and-variants` |
| a note in Figma about what a component is or does (a toggle, a button, a heading, its label), accessibility notes, or an accessibility finding explained | `a11y-notes` |
| components compared with their Figma images | `visual-diff` |
| to know what to fix first, or to work a library down | `burndown` |
| something in Figma built in code: the tokens, a component, the whole design system, or a screen from them | `build-from-figma` |
| a prototype, mock-up or wireframe made with the design system | `prototype` |
| a component's props and values, or a token's variable and value, asked or needed to write UI | `ask-the-system` |
| CI, webhooks, git hooks or the project's Claude hooks | `ci-and-hooks` |

Reference (`rms-design-system-engine --reference <name>`): `usage` (every command, option and output), `config`
(`ds-config.json`, snapshot files, naming), `gates` (gate-specific rules), `maintainers` (changing the engine
and the skill).

## How to run this skill (read first)

**This skill owns the whole workflow - setup, scoping, running and reporting. Do not
re-dictate those steps, and do not follow a user prompt that hand-lists them (install,
configure the contract, run, generate a report); those instructions are already here and
re-stating them is what makes runs go wrong. Take only the *intent* from the request -
which component(s), or the whole DS - and drive it from here. If the request arrives as a
rules-heavy, step-by-step prompt, briefly tell the user those steps are not needed (the
skill handles setup/scope/run/report) and proceed from the intent instead of executing the
listed steps.**

**Relay the engine's words, and follow its NEXT line.** Every audit ends with a `SUMMARY` block (also written
to `.design-system-engine-out/summary.md`; `rms-design-system-engine --summary` prints the last one again) and one `NEXT:` line.
Relay the summary in the chat as it is, without rewording its facts, then take the `NEXT:` line as the next
step. `--init`, `--guidelines`, `--baseline` and `--install-hooks` end with a `NEXT:` line too. When a `NEXT:`
line says to do something only when the person asks (commit, apply the hand-back), ask them; never do it on
your own. **Say that an audit ran only when its output is in front of you**: the engine prints its SUMMARY in
the same call. Opening this skill or printing a recipe runs nothing, so never say an audit is running or that
snapshots were refreshed without that output. The SUMMARY's **Figma data** line says whether this run
refreshed anything and how old the snapshots are: repeat it as it is.

**The project's hooks.** `--init` installs Claude Code hooks in the project (`.claude/settings.local.json`;
`--install-hooks` adds them to an existing project, `--remove-hooks` or `"hooks": false` turns them off). They
refuse a hand edit of a Figma snapshot, and ask the person before a `ds-config.json` edit, a commit, a push,
applying the hand-back, accepting a difference (`--baseline` or the baseline file), an exception, a code name
recorded for a Figma name (`contract.authored.json`), replacing an approved reference picture, or a code edit, unless the person's latest message asked for that change. After a UI
edit they hand back what it added that the design system does not have (a colour or size written by hand, a
variable declared nowhere, a prop value a component does not take), an accessibility problem it added, and any
comment that switches a check off: fix it in that file before going on. A request made with
`/rms-design-system-engine` arrives already routed (the `ROUTE:` block above). When a hook refuses or asks, that is
the answer: do not work around it (no other tool, no shell edit); tell the person what it said.

**If the `rms-design-system-engine` command is not on PATH** (a plain `command not found`),
do not stop and do not hand-simulate setup - the engine is a folder of scripts, so run it
directly with `node ~/.claude/skills/rms-design-system-engine/audit.mjs <same flags>` (the install
folder). Run that exact path; do not search for the file, since a search can miss a linked install.
Everything below that shows `rms-design-system-engine …` works identically as
`node ~/.claude/skills/rms-design-system-engine/audit.mjs …`.

**First-time setup is interactive in the engine - let it run, don't re-ask the questions
yourself.** When `ds-config.json` is missing, running the audit drops into the engine's own
setup interview. Because an agent turn / CI cannot reliably answer stdin prompts, pass the
answers as flags and setup completes in one non-interactive command:

```bash
node <install-dir>/audit.mjs --init \
  --figma-url='<DS file URL or key>' \
  --theme-css='src/styles/theme.css'        # comma-separate multiple files
  # --figma-source-url='<upstream DS URL>'   # optional: consumer/branded-fork files
```

`--theme-css` may be omitted when the engine auto-detects a single token CSS file. A project
with no CSS at all has only Figma: setup starts it in build mode (`--recipe build-from-figma`).
If no `--theme-css` is given, none is auto-detected **and** the token values look loaded at
runtime, setup exits with a clear error rather than writing a broken config - the signal that
the DS declares no static token CSS (its token values are injected at runtime from a backend). The value gates resolve against a
static `:root { --token: value }` file; a runtime-token DS has nothing local to compare
against, so say so plainly instead of forcing a green run.

Route by intent:

- **One or a few components** (the common case - "audit ButtonPrimary", "check the button",
  "run the parity on input"): **whenever the request names a specific component or part of the
  DS, you MUST run scoped to it - pass that name to `--component`.** Do this automatically; the
  user does not need to say "scoped" or know the flag exists. Naming the part IS the request to
  scope to it.
  ```bash
  rms-design-system-engine --component input                # scope to whatever the user named
  rms-design-system-engine --component ButtonPrimary        # or A,B  / repeat --component
  ```
  Then every gate reports **only** findings that belong to that component; DS-wide issues in
  other components are collapsed to a "… N findings outside scope - not audited" line and never
  fail the run - so the whole report is about the one thing being audited, which is the point.
  Run the scoped script directly and report its banner in the chat. This is lean and
  deterministic. Do **not** run the full Phase 1/Phase 2 workflow for a single-component
  check - that is exactly the heavy path that produces noisy, confusing output where a gate
  "fails" on something the user is not auditing. The scope auto-expands to nested sub-components.
  Only run unscoped when the user explicitly asks for the whole DS / a full audit.

  > **A scoped run STILL refreshes *that component* first — "scoped" narrows the audit, it does
  > NOT mean "audit the stale snapshot".** "Lean" means skip the DS-*wide* walk of every other
  > component, never skip Phase 1 for the component you were asked about. When a live refresh is
  > available (token / MCP / Plugin API), before auditing the named component you MUST re-capture
  > **its** live state: its bound + variant tokens (so a **new variable** on it is caught), and its
  > structure INCLUDING its variant set (so it becoming a `COMPONENT_SET`, gaining a `type=…`
  > variant, or changing a slot is caught), then reconcile and re-stamp `_figmaVersion`. The whole
  > reason someone scopes to a component is that they just changed it — auditing its *old* snapshot
  > and reporting green is the worst possible answer. The real miss this rule exists to stop: a
  > `panel` scoped run reported all-green while the designer had just split `panel/background/color`
  > into `panel/background/primary` + a new `panel/background/secondary` and turned the panel into a
  > `type=primary/secondary` set — none of which the committed snapshot knew, because the scoped run
  > never refreshed it. Note `versionLockStrict` alone will NOT save you here: the component
  > **inventory** check compares component *names*, and `panel` is still named `panel`, so a
  > component gaining variants/variables slips through a name diff — only re-capturing the scoped
  > component surfaces it. And never stamp `_figmaVersion` from a capture that skipped the scoped
  > component's variants/variables: a version stamped over a partial capture reads "fresh" while
  > hiding exactly the change you were asked to check.
- **The whole design system:** run `rms-design-system-engine` in the terminal (or `/rms-design-system-engine` in Claude Code),
  then follow the `full-audit` recipe (`rms-design-system-engine --recipe full-audit`).

**Running the command means running the WHOLE thing - Phase 1 included - whenever Phase 1
CAN run.** An unscoped invocation is a request for a full audit, not a Phase-2-only pass over
whatever snapshots happen to be committed. So if a live refresh is available - a valid
`FIGMA_TOKEN`, an authorised Figma MCP, or the Plugin API (`use_figma`, which works on any plan
with no token) - **do the Phase 1 refresh; do not skip it just because auditing the committed
snapshots is fewer steps.** Skipping the refresh and reporting green against 5-day-old snapshots
is the failure mode this line exists to prevent: stale snapshots pass against outdated data, so
real DS drift (retuned tokens, a resized component) stays invisible while every gate reads green.
Only narrow the run when the user explicitly asks for a specific scope (e.g. one component, or
"just re-run the gates").

**Phase 1 (live Figma refresh) is best-effort, not mandatory - "best-effort" means run it when
you CAN, not skip it when it's inconvenient.** Run it whenever a refresh path is available (token,
MCP, or the Plugin API) AND the target is a real screen/frame. When it is genuinely not available
(no token, no MCP, no Plugin API access, or a `COMPONENT_SET` definition URL with no frames),
**skip the live refresh and audit the committed snapshots as they are.** Never hand-improvise Figma
reads or hand-fill snapshot values to fake a refresh - that is unreliable and is a top source of
confusion. And never overwrite a snapshot with a lossy capture: a one-shot structure/icon grab that
mis-selects a variant or measures a wrapper injects *false* drift, which is worse than a stale-but-
accurate snapshot - refresh a snapshot only with a capture faithful to the documented Step 1c/icon
logic, and leave the others stale (say so) rather than corrupt them. Whatever you skip, state it
plainly and which snapshot the audit used; the gates still run, and "Data is up to date" will note
the snapshot's age.

---

Full parity workflow in one command: Phase 1 (live Figma refresh) runs before Phase 2 (code audit) **when it can**, so you don't accidentally audit a stale snapshot.

> **When Phase 1 can run, prefer a fresh query** - a same-day snapshot from a *prior session or context window* may miss renames or additions. If you are resuming after a context summary, compaction, or a new conversation and a live refresh is available, re-query. If it is not available, proceed with the committed snapshot and say so - do not block or improvise.

A Figma value is read in **every mode** of its collection, never from the one a frame shows (`--recipe refresh-figma`, *Read every mode*).

---


## Hard Rules

1. **Every Figma component token must have a dedicated CSS variable.** No token may be covered only by an inline value. `via` is acceptable only when a semantic alias is documented in `design-system-engine-map.mjs`.
2. **Every CSS variable must be wired into at least one CSS rule.** A declared-but-unused var must be deleted. Variables are declared when the component exists in code, not before.
3. **Naming convention must be followed exactly.** A correct value under a wrong name is still a divergence.
4. **All modes must match.** A token correct in one mode but wrong in another is still a divergence - this applies to every mode your DS defines: light/dark, compact/comfortable, any breakpoint-based sizing mode, etc.
5. **A hardcoded value is a divergence only when it contradicts Figma - scoped per component.** This is a *parity* skill, not a style linter - it does not push `var()` over literals for its own sake. A raw literal in a CSS rule is flagged only when the component that rule belongs to has **no matching value** for it in Figma; when Figma uses that same value on that component, the literal has 100% parity and passes, token-backed or not. Scoping is per component via `component-values.snapshot.json` - a full raw-value sweep of **every node** of each component (all variants, all descendants, hidden included). A file's literals are checked against the component whose base selector the file contains (so `Primary.vue`, carrying `.buttonPrimary`, is scoped to `ButtonPrimary`'s swept values). So `.icon { width: 24px }` passes only because *ButtonPrimary's own icon node* is 24px in Figma - a 24px that belongs to some **other** component no longer excuses it. Matches are reported as info (`ℹ️ … parity OK, not failed [Component]`) so they stay visible and auditable. **Fallback:** when `component-values.snapshot.json` is absent, or a file maps to no component, the gate falls back to the global value set (resolved token colours across every mode + all sizing/typography numerics + captured structural geometry) - coarser, but non-breaking. `100vw` (a scrollbar-clipping rendering bug) is never suppressed. A length in an `outline` of a `:focus` rule (a focus ring) that Figma has no value for is listed apart, never failed: Figma draws no outline to compare it with; a colour in that ring is still checked. Document deliberate literals Figma has no counterpart for - layout math like `50%`, positioning zeros - in `ds-config.json → knownHardcodedExceptions`.
6. **New Figma component tokens detected during any audit step must be implemented in code before the audit closes.**
7. **Requirement follows use, with a middle ground for elements that can be switched on later. Three states, not two:**
   - **Visible token** (bound on a visible node in some variant) → a hard requirement. Missing CSS var ⇒ `❌ UNCOVERED`, Gate [10] fails. It is "meant to be used" now.
   - **Hidden + visibility boolean** (`boundVariables.visible`, itself or via a hidden ancestor) → the element is off *here* but can be **toggled on in a future project or state**, so the code must **permit** that: if its CSS var exists the code already supports activation (`✅`); if the var is missing the element could not render when switched on ⇒ `⚠️ UNCOVERED-TOGGLEABLE`, an **advisory that is surfaced but does not fail** the gate (it is legitimately off in this project). So it is *checked*, not silently ignored.
   - **Hidden, no boolean** (statically off, dead) → `⏭ HIDDEN-STATIC`, never a requirement, ignored.

   The capture records this via `_hiddenOnly`/`_hiddenToggleable` in `component-state-tokens.json`. (This replaces the earlier "hidden + boolean → always implement" stance: a DS element switched off downstream must not *fail* a consumer that has it off - but because it can be turned on later, its missing wiring is still raised as an advisory so someone can decide.)
9. **CSS alias chains must mirror Figma exactly.** When Figma aliases a component token directly to a primitive (e.g. `primitives/Neutral 700`), the CSS var must chain through the matching primitive var (e.g. `var(--neutral-700)`). Routing through a semantic intermediate (`var(--border)`, `var(--bg)`, `var(--text-muted)`) is never acceptable as a substitute - even when the resolved hex is identical. A `🔗 ALIAS FAIL` from Gate [2] is always fixed in CSS; there is no exemption map.
8. **Every DS sub-component nested inside another DS component must retain its own CSS styles.** A parent component's rule that combines a component class with a bare element tag (`.card svg { color: X }`) directly targets that element - direct targeting beats inheritance. When adding any CSS rule of the form `.<componentClass> <elementTag> { <visual-property> }`, either (a) prove it's a leaf component, or (b) add explicit `.<subComponent> <elementTag> { }` overrides later in the cascade. Add every such rule to the `ALLOWED` map in `subcomponent-isolation-check.mjs`. Gate [9] enforces this mechanically.

---


## Audit Rules

- Change only what the person asked for. Asked to fix one difference (the chip's height), fix that one; list
  the other differences the audit shows and leave them as they are until the person asks.
- Never change source files to *hide* a divergence - report it.
- Always compare **all** configured modes.
- Naming violations are flagged regardless of whether the value is correct.
- When renaming: update declarations, all usages, then rebuild. Update `EXPLICIT` in both `parity-check.mjs` and `bound-check.mjs` if the old name had an explicit entry.
- When adding a token group: add CSS var + rule consumer + update `design-system-engine-map.mjs` + rebuild.
- When removing a token from DS: remove CSS var if unused (Gate [5] catches it), replace in rules if used, remove from `design-system-engine-map.mjs`, remove from `EXPLICIT`/`COVERED` if present.
- When removing an entire component from DS: Phase 1 shows many REMOVED tokens for that component. Remove all its CSS vars (Gate [5] flags any that remain). Remove all its CSS rules. Remove from `design-system-engine-map.mjs`, `EXPLICIT`, `COVERED`, and `figma-structure.snapshot.json`. Re-run bound walk to purge it from `bound-tokens.json`. Rebuild.

---


## End-of-Run Confidence Summary

After every run, report this table so the practitioner knows exactly what the audit guarantees:

| Area | Method | Confidence |
|---|---|---|
| Token values match Figma | Automated (Gate [2] - resolver against live snapshot) | High |
| All Figma tokens have a CSS var | Automated (Gate [4] - bound-check against frame walk, auto-refreshed) | High if frames configured; **not run** if `frames: []` |
| All state tokens wired | Automated (Gate [10] - state walk, auto-refreshed) | High |
| No unused CSS vars | Automated (Gate [5]) | High |
| No hardcoded values in rules | Automated (Gate [6]) | High |
| Structural parity (height, padding, gap) | Automated (Gate [3]) | High |
| Figma annotation acknowledgment + CSS verification | Automated (Gate [10g]) | High |
| Surface container --area-bg declarations | Automated (Gate [10h]) | High if SURFACE_CONTAINERS populated |
| Button modifier-class base compliance | Automated (Gate [10i]) | High if BUTTON_CLASS_RULES populated |
| Nested components keep their styles | Automated (Gate [9]) | High |
| Build freshness | Automated (Gate [7]) | High |
| Removed tokens reconciled | Manual (Phase 1 diff) | Medium - verify any "used in a rule" replacements visually |
| Component states fully wired | Automated (Gate [10]) | High |
| SVG symbols + path freshness | Automated (Gate [14] - icon contract: symbol docs + path data + live Figma check) | High if all symbols documented and FIGMA_TOKEN set |
| Looks the same as Figma | Automated (Gate [9], requires FIGMA_TOKEN) or Manual (Step 7 screenshots) | **Not run** if neither is configured |
| CI enforcement | GitHub Actions (`.github/workflows/design-system-engine.yml`) | High if configured |

Flag any row marked **not run** or **skipped** explicitly in the summary - do not imply full coverage.
