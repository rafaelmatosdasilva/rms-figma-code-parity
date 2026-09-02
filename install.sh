#!/usr/bin/env bash
# install.sh — install (or update) the rms-figma-code-parity Claude Code skill.
# One canonical clone + a symlinked command, so a `git pull` (or --update) keeps you
# on the latest with NO re-download. Run:
#   curl -fsSL https://raw.githubusercontent.com/rafaelmatosdasilva/rms-figma-code-parity/main/install.sh | bash

set -e

REPO="https://github.com/rafaelmatosdasilva/rms-figma-code-parity"
CLONE_DIR="$HOME/.claude/skills/rms-figma-code-parity"
COMMANDS_DIR="$HOME/.claude/commands"
SKILL_FILE="rms-figma-code-parity.md"

command -v git >/dev/null || { echo "❌  git is required."; exit 1; }

# 1. Canonical clone (or fast-forward it if already there) — the single source of truth.
if [ -d "$CLONE_DIR/.git" ]; then
  echo "↻  Updating existing clone at $CLONE_DIR"
  git -C "$CLONE_DIR" pull --ff-only
else
  echo "⬇  Cloning skill to $CLONE_DIR"
  mkdir -p "$(dirname "$CLONE_DIR")"
  git clone --depth 1 "$REPO" "$CLONE_DIR"
fi

# 2. Symlink the global command to the clone (NOT a copy) so it tracks every update.
mkdir -p "$COMMANDS_DIR"
ln -sf "$CLONE_DIR/$SKILL_FILE" "$COMMANDS_DIR/$SKILL_FILE"

echo ""
echo "✅  /rms-figma-code-parity linked → $COMMANDS_DIR/$SKILL_FILE"
echo "    → $CLONE_DIR/$SKILL_FILE  (symlink — updates with a pull, no re-download)"
echo ""
echo "──────────────────────────────────────────────────────────"
echo "  Per-project setup (run once inside each repo):"
echo ""
echo "    ln -s \"$CLONE_DIR\" scripts      # point 'scripts' at the shared clone"
echo "    echo scripts >> .gitignore        # it's a machine path, don't commit it"
echo "    node scripts/audit.mjs --init     # scaffold ds-config.json"
echo ""
echo "  Run:      /rms-figma-code-parity        (or: node scripts/audit.mjs --component <Name>)"
echo "  Update:   node scripts/audit.mjs --update    (git pull + relink — never re-download)"
echo "──────────────────────────────────────────────────────────"
