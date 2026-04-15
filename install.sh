#!/usr/bin/env bash
set -e

CYAN='\033[36m'
GREEN='\033[32m'
DIM='\033[2m'
RED='\033[31m'
RESET='\033[0m'

BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.agent-os"
ENV_FILE="$CONFIG_DIR/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SCRIPT_DIR/packages/cli/dist/index.js"

echo ""
echo -e "${CYAN}  AgentOS${RESET} — install"
echo -e "${DIM}  ─────────────────────────────────${RESET}"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────────
echo -e "${DIM}  building…${RESET}"
cd "$SCRIPT_DIR"
npm run build --silent
echo -e "${GREEN}  ✓ build complete${RESET}"

# ── Config dir ────────────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
mkdir -p "$BIN_DIR"

# ── Create .env if missing ────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# AgentOS global config — edit this file
# Run `aos` from any directory to start the agent

# Required
ANTHROPIC_API_KEY=

# Optional: Gemini fallback (enables dual-LLM routing)
# GOOGLE_API_KEY=

# Memory database location
DB_PATH=~/.agent-os/memory.db

# Skills directory (loads ~/.claude/skills/ by default)
SKILLS_DIR=~/.claude/skills

# Default model: claude | gemini | auto
DEFAULT_MODEL=claude
ENVEOF
  echo -e "${GREEN}  ✓ created ${ENV_FILE}${RESET}"
  echo -e "${DIM}    → add your ANTHROPIC_API_KEY to get started${RESET}"
else
  echo -e "${DIM}  ✓ ${ENV_FILE} exists — not overwritten${RESET}"
fi

# ── Symlink ────────────────────────────────────────────────────────────────────
chmod +x "$DIST"
ln -sf "$DIST" "$BIN_DIR/aos"
echo -e "${GREEN}  ✓ linked:  ${BIN_DIR}/aos${RESET}"

# ── PATH check ────────────────────────────────────────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo -e "${DIM}  add to your shell profile:${RESET}"
  echo -e "  ${CYAN}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
  echo ""
fi

echo ""
echo -e "${GREEN}  Done.${RESET} Run ${CYAN}aos${RESET} from any directory."
echo -e "${DIM}  aos --model gemini    # use Gemini${RESET}"
echo -e "${DIM}  aos --agent myagent   # use a named agent profile${RESET}"
echo ""
