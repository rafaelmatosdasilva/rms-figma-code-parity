# rms-figma-code-parity

Checks that your CSS code matches your Figma design system. Run it whenever the DS changes — it tells you exactly what's out of sync and where to fix it.

> **Sister tool:** [rms-figma-sync](https://github.com/rafaelmatosds/rms-figma-sync) — checks whether a consumer Figma product file is using the latest DS library. Use that for design handoff; use this one for code implementation.

---

## Quick start

**1 — Install (once per machine)**

```bash
curl -fsSL https://raw.githubusercontent.com/rafaelmatosds/rms-figma-code-parity/main/install.sh | bash
```

**2 — Add to a project (once per repo)**

```bash
git submodule add https://github.com/rafaelmatosds/rms-figma-code-parity scripts
node scripts/audit.mjs --init
```

`--init` asks 4 questions, auto-detects everything else, and prints a checklist of what to fill in next.

**3 — Run**

Open Claude Code inside the project and run:

```
/rms-figma-code-parity
```

---

## What it does

Every run has two phases:

| Phase | What happens |
|---|---|
| **1 — Figma refresh** | Pulls the latest values from Figma (colors, sizes, fonts, component structure), shows you what changed since last time, and updates the local snapshot files. |
| **2 — Code audit** | Runs 18 automated checks against your CSS and reports everything that doesn't match. |

You always audit against a fresh snapshot. There's no way to accidentally check against yesterday's design.

---

## The 18 checks

Gates are grouped by theme so failures point you to the right layer immediately.

**Freshness** — is the data you're checking against fresh?
| # | What it checks |
|---|---|
| 1 | **Freshness** — Are the snapshot files from today? Are your compiled plugin files newer than their sources? |
| 2 | **Visual regression** — Does the live Figma frame still look the same as the last accepted screenshot? |

**Tokens** — do CSS values match Figma's design decisions?
| # | What it checks |
|---|---|
| 3 | **Token parity** — Do every color, size, and font in your CSS match what Figma says they should be? Checks all color modes (light, dark, etc.). |
| 4 | **Bound-token coverage** — Is there anything in the Figma frames that has no CSS variable yet? |
| 5 | **Mode completeness** — Do all tokens that are supposed to change between modes (light/dark, compact/comfortable) actually resolve to different values in each mode? |
| 6 | **Exemption validity** — Are any "skip this token" exceptions in your config now pointing to tokens that no longer exist? |
| 7 | **CSS naming round-trip** — Does every CSS variable name trace back to a real token in the Figma file? Catches variables someone invented that have no design backing. |

**CSS quality** — is the stylesheet itself clean?
| # | What it checks |
|---|---|
| 8 | **CSS hygiene** — Are there CSS variables nobody's using? Are there raw values (colors, sizes) written directly into CSS rules instead of using a token variable? Also catches hand-drawn icons embedded as CSS strings (invisible to slot checks). |
| 9 | **Sub-component isolation** — When one DS component is nested inside another, are their styles leaking into each other? |

**Structure** — do components match the Figma component spec?
| # | What it checks |
|---|---|
| 10 | **Component structure** — Is each component the right height? Are its spacing, font, and corner radius wired to the right tokens — not hardcoded? |
| 11 | **State coverage** — Does every interactive state from Figma (hover, disabled, selected…) have a CSS rule? Are the right token variables used inside those rules? |

**Markup** — is the HTML the right shape?
| # | What it checks |
|---|---|
| 12 | **HTML structure snapshot** — Have any ids, component classes, or icon refs changed since the last accepted baseline? |
| 13 | **Slot parity** — Does every declared button slot use the exact DS icon and component class the Figma spec calls for? (Two-phase: declared slots + exhaustiveness scan for undeclared ones.) |
| 14 | **Icon contract** — Are all SVG icons documented (with Figma node IDs), named after the DS component they come from, using the exact path data from Figma, and still matching the live Figma export? Four-part check: symbol docs → sprite id ↔ DS component name → path verification → live freshness. |

**Animation** — do motion values match?
| # | What it checks |
|---|---|
| 15 | **Transition contract** — Does every DS component's CSS transition match the documented duration and easing value? Catches duration/easing drift before Figma EASING/TIMING tokens are available. |
| 16 | **Rendered parity** — Does the browser actually compute what the DS contract says? Headless Chrome loads each built plugin UI and asserts getComputedStyle values — catches cascade/specificity overrides, wrong var() resolution, and stale builds that static text analysis cannot see. |
| 17 | **Contrast parity** — Do text and background colors meet WCAG contrast, per mode? Computes the ratio of every foreground token against its background straight from the resolved DS hexes — surfaces low-contrast/illegible pairs a token-only audit is blind to. |
| 18 | **Coverage meta-gate** — What is the audit *not* checking? Cross-references every DS component against the checks the contract declares and prints a coverage matrix — surfaces components with no rendered assertion, no per-variant capture, or no model at all, so a new component/state can't stay silently unchecked. |

---

## Example output

> Auto-generated by `sync-docs.mjs` — do not edit manually.

<!-- EXAMPLE-OUTPUT-START -->
```
────────────────────────────────────────────────────────────
  PARITY AUDIT  ·  YYYY-MM-DD
────────────────────────────────────────────────────────────

✅  [1] Figma snapshots are up to date
       packages/ui/src/figma-vars.snapshot.json ✓ (updated today)
       ✅ All outputs current

❌  [2] Visual output matches the stored Figma frame screenshot
       ✅ PASS  87
       ❌ FAIL  2
         ❌ [color/Dark] buttonPrimary/background → --buttonPrimary-background
              Figma: #ededed   CSS: #d4d4d4

  ... (one block per gate)

────────────────────────────────────────────────────────────
  GATE SUMMARY
────────────────────────────────────────────────────────────
  ✅  [1]   Figma snapshots are up to date and build output…Pass
  ✅  [2]   Visual output matches the stored Figma frame sc…Pass
  ✅  [3]   Token values match Figma (color · sizing · typo…Pass
  ✅  [4]   Every DS token bound in Figma is implemented in…Pass
  ✅  [5]   Every token that changes between modes is handl…Pass
  ✅  [6]   All documented exceptions are still valid       Pass
  ✅  [7]   Every CSS variable maps back to a real Figma to…Pass
  ✅  [8]   No unused CSS variables or hardcoded values     Pass
  ✅  [9]   Child components are not overridden by parent C…Pass
  ✅  [10]  Component structure matches Figma (height, spac…Pass
  ✅  [11]  All component states are covered, wired, and in…Pass
  ✅  [12]  HTML structure (ids, component classes, icon re…Pass
  ✅  [13]  Every declared slot uses the correct DS icon an…Pass
  ✅  [14]  All DS icon symbols are documented, paths verif…Pass
  ✅  [15]  All CSS transitions match the documented durati…Pass
  ✅  [16]  Rendered computed styles match the DS contract …Pass
  ✅  [17]  Text/background colors meet WCAG contrast per m…Pass
  ✅  [18]  Coverage — which DS components/states the audit…Pass

────────────────────────────────────────────────────────────

  ALL GATES PASS ✅

  ⏭  STALE-SNAPSHOT MODE — when a gate shows ⏭ instead of ✅:

  [1] Figma snapshots are up to date and build outputs are current
      Shown as ⏭ only when a snapshot is >24h old and the REST auto-refresh
      is not available on this plan. The Phase 1 Plugin API captures refresh
      every snapshot on any plan — commit them and the gate is ✅.
      Risk: gates consuming a stale snapshot pass against outdated data — DS changes made after its _updated stamp are invisible. Fix: run /rms-figma-code-parity — the Phase 1 Plugin API captures refresh every snapshot on any plan; commit the refreshed files and this gate goes fully green.

────────────────────────────────────────────────────────────
```
<!-- EXAMPLE-OUTPUT-END -->

**Trend view** (`node scripts/audit.mjs --trend`):

```
─── Parity Trend ───────────────────────────────────────────
  ✅  2026-06-15  18/18 [██████████████████]
  ❌  2026-06-16  11/12 [█████████████████░]
  ✅  2026-06-17  18/18 [██████████████████]
────────────────────────────────────────────────────────────
```

---

## Other commands

```bash
node scripts/audit.mjs --init                        # first-time setup
node scripts/audit.mjs --trend                       # show last 20 runs
node scripts/audit.mjs --report-html parity.html     # generate an HTML report
node scripts/parity-check.mjs --fix                  # auto-fix sizing/typography values in theme.css
node scripts/setup-webhook.mjs --list                # list Figma webhooks registered for this file
node scripts/setup-webhook.mjs --delete <id>
```

---

## Project setup

### 1. Add as a submodule

```bash
git submodule add https://github.com/rafaelmatosds/rms-figma-code-parity scripts
```

This puts the scripts at `scripts/` so `node scripts/audit.mjs` works from your project root.

### 2. Run --init

```bash
node scripts/audit.mjs --init
```

It asks 4 questions, then auto-detects everything else:

1. **Figma file URL** — paste the browser URL of your DS file
2. **Token CSS file** — the file where all your `--variable-name` declarations live; auto-detected if there's only one
3. **Figma access token** *(optional)* — needed for visual regression (check 7) and auto-detecting collection names; saved to `.env`
4. **Upstream DS URL** *(optional)* — if your project uses a branded fork of a shared DS, paste the upstream URL here. Any token where your code matches the upstream (but not the fork) will be marked "pending sync" instead of "fail".

It creates:
- `ds-config.json` — your project's config (commit this, it has no secrets)
- `parity-map.mjs` — where you document any token naming shortcuts
- `structure-contract.mjs` — where you describe each component's expected structure

### 3. Install the Claude Code skill

```bash
mkdir -p ~/.claude/commands
cp scripts/rms-figma-code-parity.md ~/.claude/commands/
```

Or just run the one-line installer from the Quick start above — it does this for you.

---

## Using an upstream DS source

If your project is a branded fork of a shared design system, set `figmaSourceKey` in `ds-config.json` to the upstream DS file key. Phase 1 will query both files. Any token where your CSS matches the upstream source (but not the fork snapshot) gets flagged as `⏳ PENDING FIGMA SYNC` instead of ❌ — that means it's not a code bug, just a snapshot that hasn't been updated yet.

---

## Visual regression

Check 7 compares live Figma frame screenshots against stored reference images.

Requires a `FIGMA_TOKEN` in `.env` and at least one frame configured in `ds-config.json`. Silently skips if either is missing.

To accept a visual change as the new baseline:

```bash
mv .parity-refs/<frame-id>.new.png .parity-refs/<frame-id>.png
```

---

## Webhook automation

You can set up automatic parity checks that trigger every time Figma publishes a library update:

```bash
# Start the server (keep it running, e.g. with pm2)
node scripts/webhook-server.mjs

# Register with Figma once (needs a public URL)
FIGMA_TOKEN=xxx node scripts/setup-webhook.mjs --url https://your-host.com/webhook
```

Configure `webhook.port` and `webhook.secret` in `ds-config.json`. The server never modifies your source files — it only reports.

---

## Keeping multiple projects in sync

When you improve the scripts in one project, push the changes and pull them into other projects with:

```bash
git submodule update --remote scripts
```

Your project-specific files (`ds-config.json`, `parity-map.mjs`, `structure-contract.mjs`) stay in your project and are never touched by the submodule update.
