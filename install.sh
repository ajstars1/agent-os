#!/usr/bin/env bash
# AgentOS installer / updater
#
#   Install:  curl -fsSL https://raw.githubusercontent.com/ajstars1/agent-os/main/install.sh | bash
#   Update:   aos update   (or re-run this script)
#
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'
RED='\033[31m';  DIM='\033[2m';    BOLD='\033[1m'; RESET='\033[0m'

# ── Config ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/ajstars1/agent-os.git"
SRC_DIR="$HOME/.agent-os-src"
CONFIG_DIR="$HOME/.agent-os"
BIN_DIR="$HOME/.local/bin"
ENV_FILE="$CONFIG_DIR/.env"
DIST="$SRC_DIR/packages/cli/dist/index.js"
IS_UPDATE=false

# ── Helpers ───────────────────────────────────────────────────────────────────
_spin_pid=""
spin_start() {
  local msg="$1"; local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  ( i=0; while true; do
      printf "\r  ${CYAN}%s${RESET}  %s " "${frames[$((i % ${#frames[@]}))]}" "$msg"
      i=$((i+1)); sleep 0.08
    done ) &
  _spin_pid=$!
}
spin_stop() {
  [ -n "$_spin_pid" ] && { kill "$_spin_pid" 2>/dev/null || true; wait "$_spin_pid" 2>/dev/null || true; _spin_pid=""; printf "\r\033[2K"; }
}
ok()   { spin_stop; echo -e "  ${GREEN}✓${RESET}  $1"; }
info() { echo -e "  ${DIM}$1${RESET}"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail() { spin_stop; echo -e "  ${RED}✗${RESET}  $1"; exit 1; }
hr()   { echo -e "  ${DIM}────────────────────────────────────${RESET}"; }

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}${CYAN}AgentOS${RESET}"
hr
echo ""

# ── Detect update vs fresh install ────────────────────────────────────────────
if [ -d "$SRC_DIR/.git" ]; then IS_UPDATE=true; fi
if [ "${1:-}" = "--update" ] || [ "${1:-}" = "update" ]; then IS_UPDATE=true; fi

# ── Prerequisites ─────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install Node.js ≥ 20: https://nodejs.org/"
fi
NODE_VER=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
if [ "$NODE_VER" -lt 20 ]; then
  fail "Node.js ≥ 20 required (found v${NODE_VER}). Upgrade: https://nodejs.org/"
fi
ok "Node.js $(node --version)"

if ! command -v git >/dev/null 2>&1; then fail "git not found. Install git and retry."; fi

# Prefer bun for speed, fall back to npm
if command -v bun >/dev/null 2>&1; then PKG="bun"; ok "bun $(bun --version) (faster installs)"
else PKG="npm"; ok "npm $(npm --version)"; fi
echo ""

# ── Clone or pull ─────────────────────────────────────────────────────────────
if $IS_UPDATE && [ -d "$SRC_DIR/.git" ]; then
  spin_start "Pulling latest from GitHub"
  if git -C "$SRC_DIR" pull --ff-only --quiet 2>/dev/null; then
    ok "Repository updated"
  else
    spin_stop; warn "git pull failed — continuing with existing source"
  fi
else
  spin_start "Cloning agent-os into $SRC_DIR"
  # shallow clone — much faster, users don't need full history
  git clone --depth=1 --quiet "$REPO_URL" "$SRC_DIR" 2>/dev/null \
    || fail "Failed to clone. Check your internet connection and try again."
  ok "Cloned"
  # convert shallow to full so future git pull works
  git -C "$SRC_DIR" fetch --unshallow --quiet 2>/dev/null || true
fi
echo ""

# ── Install dependencies ──────────────────────────────────────────────────────
cd "$SRC_DIR"
spin_start "Installing dependencies"
if [ "$PKG" = "bun" ]; then
  bun install --silent 2>/dev/null || fail "bun install failed"
else
  npm install --silent 2>/dev/null || fail "npm install failed"
fi
ok "Dependencies ready"

# ── Build ─────────────────────────────────────────────────────────────────────
BUILD_LOG=$(mktemp)
spin_start "Building packages"
if ! npm run build >"$BUILD_LOG" 2>&1; then
  spin_stop; echo ""; cat "$BUILD_LOG"; rm -f "$BUILD_LOG"
  fail "Build failed — see output above"
fi
rm -f "$BUILD_LOG"
ok "Build complete"
echo ""

# ── Directories + binary ──────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR" "$BIN_DIR"

[ -f "$DIST" ] || fail "CLI entry point missing at $DIST — build may have failed"
chmod +x "$DIST"
ln -sf "$DIST" "$BIN_DIR/aos"
ok "Linked $BIN_DIR/aos → CLI"

# ── PATH setup (auto-patch shell profile) ─────────────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  warn "~/.local/bin is not in your PATH"

  PROFILE=""
  SHELL_NAME="$(basename "${SHELL:-}")"
  if   [ "$SHELL_NAME" = "zsh"  ] && [ -f "$HOME/.zshrc"     ]; then PROFILE="$HOME/.zshrc"
  elif [ "$SHELL_NAME" = "bash" ] && [ -f "$HOME/.bashrc"    ]; then PROFILE="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ];                                  then PROFILE="$HOME/.profile"
  fi

  if [ -n "$PROFILE" ]; then
    echo ""
    echo -n "  Add to $PROFILE automatically? [Y/n] "
    read -r yn < /dev/tty || yn="y"
    yn="${yn:-y}"
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      echo '' >> "$PROFILE"
      echo '# AgentOS' >> "$PROFILE"
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$PROFILE"
      ok "Added PATH export to $PROFILE"
      # shellcheck disable=SC1090
      export PATH="$HOME/.local/bin:$PATH"
    else
      info "Add this to your shell profile manually:"
      info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
  else
    info "Add this to your shell profile:"
    info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ── API key setup (first install only) ────────────────────────────────────────
if ! $IS_UPDATE; then
  echo ""
  hr
  echo ""
  echo -e "  ${BOLD}API Key Setup${RESET}"
  echo ""
  info "You need at least one LLM API key."
  info "  • Anthropic (Claude) → console.anthropic.com"
  info "  • Google (Gemini)    → aistudio.google.com/app/apikey"
  echo ""

  mkdir -p "$(dirname "$ENV_FILE")"

  # Write .env template if it doesn't exist
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << 'ENVEOF'
# AgentOS config — edit here or run: /config web

ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# claude | gemini | auto
DEFAULT_MODEL=auto

DB_PATH=~/.agent-os/memory.db
SKILLS_DIR=~/.claude/skills
AGENTS_DIR=~/.agent-os/agents
CONFIG_UI_PORT=7877
LOG_LEVEL=warn
NODE_ENV=production
ENVEOF
  fi

  # Prompt for Anthropic key
  echo -n "  Anthropic API key (sk-ant-…) — Enter to skip: "
  read -r ant_key < /dev/tty || ant_key=""
  ant_key="${ant_key// /}"
  if [ -n "$ant_key" ]; then
    sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${ant_key}|" "$ENV_FILE"
    ok "Anthropic key saved"
  fi

  # Prompt for Google key
  echo -n "  Google API key (AIza…)       — Enter to skip: "
  read -r goo_key < /dev/tty || goo_key=""
  goo_key="${goo_key// /}"
  if [ -n "$goo_key" ]; then
    sed -i "s|^GOOGLE_API_KEY=.*|GOOGLE_API_KEY=${goo_key}|" "$ENV_FILE"
    ok "Google key saved"
  fi

  if [ -z "$ant_key" ] && [ -z "$goo_key" ]; then
    echo ""
    warn "No keys entered. Run ${CYAN}aos${RESET} — it will prompt you on first launch."
    info "Or set keys later:  /config set ANTHROPIC_API_KEY sk-ant-..."
    info "                    /config web  (browser UI)"
  fi

  # Default model hint
  if [ -z "$ant_key" ] && [ -n "$goo_key" ]; then
    sed -i "s|^DEFAULT_MODEL=.*|DEFAULT_MODEL=gemini|" "$ENV_FILE"
    info "Default model set to gemini (no Anthropic key provided)"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
hr
echo ""
if $IS_UPDATE; then
  echo -e "  ${GREEN}${BOLD}Updated.${RESET}  Restart ${CYAN}aos${RESET} to use the new version."
else
  echo -e "  ${GREEN}${BOLD}Done.${RESET}  Run ${CYAN}aos${RESET} to start."
fi
echo ""
echo -e "  ${DIM}aos --model gemini    # Gemini session${RESET}"
echo -e "  ${DIM}aos --model claude    # Claude session${RESET}"
echo -e "  ${DIM}aos update            # pull + rebuild${RESET}"
echo -e "  ${DIM}/config web           # browser config UI${RESET}"
echo -e "  ${DIM}/help                 # all commands${RESET}"
echo ""
