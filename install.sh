#!/usr/bin/env bash
# install.sh — install the rms-figma-code-parity Claude Code skill globally
# Run once per machine: curl -fsSL https://raw.githubusercontent.com/rafaelmatosds/rms-figma-code-parity/main/install.sh | bash

set -e

COMMANDS_DIR="$HOME/.claude/commands"
SKILL_FILE="rms-figma-code-parity.md"
REPO_RAW="https://raw.githubusercontent.com/rafaelmatosds/rms-figma-code-parity/main"

mkdir -p "$COMMANDS_DIR"

if command -v curl &>/dev/null; then
  curl -fsSL "$REPO_RAW/$SKILL_FILE" -o "$COMMANDS_DIR/$SKILL_FILE"
elif command -v wget &>/dev/null; then
  wget -qO "$COMMANDS_DIR/$SKILL_FILE" "$REPO_RAW/$SKILL_FILE"
else
  echo "❌  curl or wget required." && exit 1
fi

echo ""
echo "✅  /rms-figma-code-parity installed to $COMMANDS_DIR/$SKILL_FILE"
echo ""
echo "──────────────────────────────────────────────────────────"
echo "  Per-project setup (run once inside each repo):"
echo ""
echo "    git submodule add https://github.com/rafaelmatosds/rms-figma-code-parity scripts"
echo "    node scripts/audit.mjs --init"
echo ""
echo "  Then open Claude Code and run /rms-figma-code-parity"
echo "──────────────────────────────────────────────────────────"
