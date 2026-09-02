#!/usr/bin/env bash
# install.sh - install (or update) the rms-figma-code-parity Claude Code skill.
# One canonical clone + a symlinked command + a named terminal command, so updates
# are a `git pull` (or `rms-figma-code-parity --update`) with NO re-download. Run:
#   curl -fsSL https://raw.githubusercontent.com/rafaelmatosdasilva/rms-figma-code-parity/main/install.sh | bash

set -e

REPO="https://github.com/rafaelmatosdasilva/rms-figma-code-parity"
CLONE_DIR="$HOME/.claude/skills/rms-figma-code-parity"
COMMANDS_DIR="$HOME/.claude/commands"
BIN_DIR="$HOME/.local/bin"
SKILL_FILE="rms-figma-code-parity.md"

command -v git >/dev/null || { echo "❌  git is required."; exit 1; }

# 1. Canonical clone (or fast-forward it if already there) - the single source of truth.
if [ -d "$CLONE_DIR/.git" ]; then
  echo "↻  Updating existing install at $CLONE_DIR"
  git -C "$CLONE_DIR" pull --ff-only
else
  echo "⬇  Installing to $CLONE_DIR"
  mkdir -p "$(dirname "$CLONE_DIR")"
  git clone --depth 1 "$REPO" "$CLONE_DIR"
fi

# 2. Symlink the /rms-figma-code-parity command to the clone (NOT a copy) so it tracks updates.
mkdir -p "$COMMANDS_DIR"
ln -sf "$CLONE_DIR/$SKILL_FILE" "$COMMANDS_DIR/$SKILL_FILE"

# 3. Named terminal commands so you never type `node …/audit.mjs`.
#    `rms-figma-code-parity` (and the short alias `rms-parity`) run from wherever you are.
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/rms-figma-code-parity" <<LAUNCH
#!/usr/bin/env bash
exec node "$CLONE_DIR/audit.mjs" "\$@"
LAUNCH
chmod +x "$BIN_DIR/rms-figma-code-parity"
ln -sf "$BIN_DIR/rms-figma-code-parity" "$BIN_DIR/rms-parity"

echo ""
echo "✅  Installed. Command: /rms-figma-code-parity   ·   Terminal: rms-figma-code-parity (alias rms-parity)"
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo ""
  echo "⚠️  $BIN_DIR is not on your PATH yet. Add this line to your shell profile"
  echo "    (~/.zshrc or ~/.bashrc), then open a new terminal:"
  echo "        export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
echo ""
echo "──────────────────────────────────────────────────────────"
echo "  Use it inside any project:"
echo ""
echo "    cd my-project"
echo "    rms-figma-code-parity --init                 # first-time setup"
echo "    rms-figma-code-parity --component ButtonPrimary   # audit one component"
echo "    rms-figma-code-parity                         # audit the whole DS"
echo ""
echo "  Check / update (never a re-download):"
echo "    rms-figma-code-parity --version"
echo "    rms-figma-code-parity --update"
echo "──────────────────────────────────────────────────────────"
