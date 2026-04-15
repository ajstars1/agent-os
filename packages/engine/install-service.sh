#!/usr/bin/env bash
# install-service.sh — Register AgentOS neural engine as a system service.
#
# Supports:
#   Linux: systemd user service (~/.config/systemd/user/)
#   macOS: launchd user agent (~/Library/LaunchAgents/)
#
# Usage:
#   ./install-service.sh            # install + start
#   ./install-service.sh --uninstall

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="agent-os-engine"
PYTHON_BIN="${PYTHON_BIN:-$(which python3)}"
POETRY_BIN="${POETRY_BIN:-$(which poetry 2>/dev/null || echo '')}"

# ── Resolve python interpreter (prefer venv inside project) ──────────────────
if [[ -n "$POETRY_BIN" ]] && [[ -f "$SCRIPT_DIR/pyproject.toml" ]]; then
  PYTHON_CMD="$POETRY_BIN run python"
  RUN_CMD="$POETRY_BIN run uvicorn engine.app:app --host 127.0.0.1 --port 8000 --no-access-log"
else
  PYTHON_CMD="$PYTHON_BIN"
  RUN_CMD="$PYTHON_BIN -m uvicorn engine.app:app --host 127.0.0.1 --port 8000 --no-access-log"
fi

DB_DIR="$HOME/.agent-os"
COMPANION_DB="$DB_DIR/companion.db"

# ── Detect OS ────────────────────────────────────────────────────────────────
OS="$(uname -s)"

uninstall() {
  if [[ "$OS" == "Linux" ]]; then
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
    systemctl --user daemon-reload
    echo "Uninstalled $SERVICE_NAME (systemd)"
  elif [[ "$OS" == "Darwin" ]]; then
    local plist="$HOME/Library/LaunchAgents/com.agent-os.engine.plist"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "Uninstalled $SERVICE_NAME (launchd)"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

# ── Linux: systemd user service ──────────────────────────────────────────────
install_systemd() {
  mkdir -p "$HOME/.config/systemd/user"

  cat > "$HOME/.config/systemd/user/${SERVICE_NAME}.service" << EOF
[Unit]
Description=AgentOS Neural Engine (memory learning + inference)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
Environment="COMPANION_DB_PATH=${COMPANION_DB}"
Environment="PYTHONUNBUFFERED=1"
ExecStart=${RUN_CMD}
Restart=on-failure
RestartSec=10

# Resource limits — keep it lightweight
MemoryMax=512M
CPUQuota=25%

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"

  echo "✓ Installed and started $SERVICE_NAME (systemd user service)"
  echo "  Status:  systemctl --user status $SERVICE_NAME"
  echo "  Logs:    journalctl --user -u $SERVICE_NAME -f"
  echo "  Stop:    systemctl --user stop $SERVICE_NAME"
}

# ── macOS: launchd user agent ─────────────────────────────────────────────────
install_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents"
  local plist="$HOME/Library/LaunchAgents/com.agent-os.engine.plist"

  cat > "$plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-os.engine</string>

  <key>ProgramArguments</key>
  <array>
    $(echo "$RUN_CMD" | awk '{for(i=1;i<=NF;i++) print "    <string>"$i"</string>"}')
  </array>

  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>COMPANION_DB_PATH</key>
    <string>${COMPANION_DB}</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${HOME}/.agent-os/engine.log</string>

  <key>StandardErrorPath</key>
  <string>${HOME}/.agent-os/engine-error.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
EOF

  launchctl load "$plist"

  echo "✓ Installed and started $SERVICE_NAME (launchd agent)"
  echo "  Status:  launchctl list | grep agent-os"
  echo "  Logs:    tail -f ~/.agent-os/engine.log"
  echo "  Stop:    launchctl unload $plist"
}

# ── Run ───────────────────────────────────────────────────────────────────────
mkdir -p "$DB_DIR"

echo "Installing AgentOS engine service..."
echo "  Python: $PYTHON_CMD"
echo "  DB dir: $DB_DIR"
echo ""

if [[ "$OS" == "Linux" ]]; then
  install_systemd
elif [[ "$OS" == "Darwin" ]]; then
  install_launchd
else
  echo "Unsupported OS: $OS"
  echo "Start manually: cd $SCRIPT_DIR && $RUN_CMD"
  exit 1
fi
