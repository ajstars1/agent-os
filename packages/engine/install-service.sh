#!/usr/bin/env bash
# install-service.sh — Register AgentOS as system services (engine + tray).
#
# Installs two things:
#   1. Neural engine  — background service (systemd / launchd), starts on boot
#   2. Tray monitor   — desktop autostart (XDG / LaunchAgent), shows status icon
#
# Usage:
#   ./install-service.sh               # install engine + tray
#   ./install-service.sh --engine-only # skip tray
#   ./install-service.sh --tray-only   # skip engine service
#   ./install-service.sh --uninstall   # remove everything

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="agent-os-engine"
TRAY_NAME="agent-os-tray"
PYTHON_BIN="${PYTHON_BIN:-$(which python3)}"
POETRY_BIN="${POETRY_BIN:-$(which poetry 2>/dev/null || echo '')}"

# ── Resolve commands ──────────────────────────────────────────────────────────
if [[ -n "$POETRY_BIN" ]] && [[ -f "$SCRIPT_DIR/pyproject.toml" ]]; then
  PYTHON_CMD="$POETRY_BIN run python"
  ENGINE_CMD="$POETRY_BIN run uvicorn engine.app:app --host 127.0.0.1 --port 8765 --no-access-log"
  TRAY_CMD="$POETRY_BIN run agent-tray"
else
  PYTHON_CMD="$PYTHON_BIN"
  ENGINE_CMD="$PYTHON_BIN -m uvicorn engine.app:app --host 127.0.0.1 --port 8765 --no-access-log"
  TRAY_CMD="$PYTHON_BIN $SCRIPT_DIR/src/engine/tray_monitor.py"
fi

DB_DIR="$HOME/.agent-os"
COMPANION_DB="$DB_DIR/companion.db"
LOG_DIR="$DB_DIR/logs"
OS="$(uname -s)"

INSTALL_ENGINE=true
INSTALL_TRAY=true

for arg in "$@"; do
  case "$arg" in
    --engine-only) INSTALL_TRAY=false ;;
    --tray-only)   INSTALL_ENGINE=false ;;
    --uninstall)
      _uninstall
      exit 0
      ;;
  esac
done

# ── Uninstall ─────────────────────────────────────────────────────────────────
_uninstall() {
  echo "Uninstalling AgentOS services..."

  if [[ "$OS" == "Linux" ]]; then
    systemctl --user stop  "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
    systemctl --user daemon-reload
    rm -f "$HOME/.config/autostart/${TRAY_NAME}.desktop"
    echo "✓ Removed systemd service + XDG autostart"

  elif [[ "$OS" == "Darwin" ]]; then
    local eng_plist="$HOME/Library/LaunchAgents/com.agent-os.engine.plist"
    local tray_plist="$HOME/Library/LaunchAgents/com.agent-os.tray.plist"
    launchctl unload "$eng_plist"  2>/dev/null || true
    launchctl unload "$tray_plist" 2>/dev/null || true
    rm -f "$eng_plist" "$tray_plist"
    echo "✓ Removed launchd agents"
  fi
}

# ── Check tray dependencies ───────────────────────────────────────────────────
_check_tray_deps() {
  if ! "$PYTHON_CMD" -c "import pystray, PIL" 2>/dev/null; then
    echo ""
    echo "⚠️  Tray dependencies missing. Installing..."
    if [[ -n "$POETRY_BIN" ]]; then
      "$POETRY_BIN" install --with tray 2>/dev/null || \
      "$POETRY_BIN" run pip install pystray Pillow requests
    else
      "$PYTHON_BIN" -m pip install pystray Pillow requests --quiet
    fi

    # Linux GNOME extra: needs AppIndicator
    if [[ "$OS" == "Linux" ]] && command -v apt-get &>/dev/null; then
      echo "  Installing AppIndicator support for GNOME..."
      sudo apt-get install -y -q gir1.2-ayatanaappindicator3-0.1 2>/dev/null || \
      sudo apt-get install -y -q gir1.2-appindicator3-0.1 2>/dev/null || \
      echo "  (AppIndicator package not found — tray may not work on GNOME without the AppIndicator Shell extension)"
    fi
  fi
}

# ── Linux: systemd engine service ─────────────────────────────────────────────
_install_engine_systemd() {
  mkdir -p "$HOME/.config/systemd/user" "$LOG_DIR"

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
ExecStart=${ENGINE_CMD}
Restart=on-failure
RestartSec=10
MemoryMax=512M
CPUQuota=25%
StandardOutput=append:${LOG_DIR}/engine.log
StandardError=append:${LOG_DIR}/engine-error.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start  "$SERVICE_NAME"

  echo "✓ Engine service installed (systemd)"
  echo "  Status:  systemctl --user status $SERVICE_NAME"
  echo "  Logs:    tail -f $LOG_DIR/engine.log"
}

# ── Linux: XDG autostart for tray ─────────────────────────────────────────────
_install_tray_xdg() {
  mkdir -p "$HOME/.config/autostart"

  cat > "$HOME/.config/autostart/${TRAY_NAME}.desktop" << EOF
[Desktop Entry]
Type=Application
Name=AgentOS Tray
Comment=AgentOS status indicator in system tray
Exec=${TRAY_CMD}
Icon=utilities-system-monitor
Terminal=false
StartupNotify=false
X-GNOME-Autostart-enabled=true
X-KDE-autostart-after=panel
EOF

  echo "✓ Tray autostart installed (XDG)"
  echo "  Will start on next login. Start now:"
  echo "    $TRAY_CMD &"

  # Offer to start now
  if [[ "${DISPLAY:-}" != "" || "${WAYLAND_DISPLAY:-}" != "" ]]; then
    echo ""
    read -r -p "  Start tray monitor now? [y/N] " ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      nohup $TRAY_CMD &>/dev/null &
      echo "  Tray monitor started (PID $!)"
    fi
  fi
}

# ── macOS: launchd engine ─────────────────────────────────────────────────────
_install_engine_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  local plist="$HOME/Library/LaunchAgents/com.agent-os.engine.plist"

  # Build ProgramArguments XML from command string
  local args_xml=""
  for word in $ENGINE_CMD; do
    args_xml+="    <string>${word}</string>\n"
  done

  cat > "$plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-os.engine</string>
  <key>ProgramArguments</key>
  <array>
$(printf '%b' "$args_xml")
  </array>
  <key>WorkingDirectory</key><string>${SCRIPT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COMPANION_DB_PATH</key><string>${COMPANION_DB}</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/engine.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/engine-error.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF

  launchctl load "$plist"
  echo "✓ Engine service installed (launchd)"
  echo "  Logs: tail -f $LOG_DIR/engine.log"
}

# ── macOS: launchd tray agent ─────────────────────────────────────────────────
_install_tray_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents"
  local plist="$HOME/Library/LaunchAgents/com.agent-os.tray.plist"

  local args_xml=""
  for word in $TRAY_CMD; do
    args_xml+="    <string>${word}</string>\n"
  done

  cat > "$plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-os.tray</string>
  <key>ProgramArguments</key>
  <array>
$(printf '%b' "$args_xml")
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${LOG_DIR}/tray.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/tray-error.log</string>
</dict></plist>
EOF

  launchctl load "$plist"
  echo "✓ Tray monitor installed (launchd — appears in menu bar on login)"
}

# ── Run ───────────────────────────────────────────────────────────────────────
mkdir -p "$DB_DIR" "$LOG_DIR"

echo ""
echo "  AgentOS Service Installer"
echo "  ─────────────────────────"
echo "  OS:     $OS"
echo "  Engine: $ENGINE_CMD"
echo ""

if [[ "$OS" == "Linux" ]]; then
  [[ "$INSTALL_ENGINE" == true ]] && _install_engine_systemd
  if [[ "$INSTALL_TRAY" == true ]]; then
    _check_tray_deps
    _install_tray_xdg
  fi

elif [[ "$OS" == "Darwin" ]]; then
  [[ "$INSTALL_ENGINE" == true ]] && _install_engine_launchd
  if [[ "$INSTALL_TRAY" == true ]]; then
    _check_tray_deps
    _install_tray_launchd
  fi

else
  echo "Unsupported OS: $OS"
  echo "Start engine manually: cd $SCRIPT_DIR && $ENGINE_CMD"
  echo "Start tray manually:   $TRAY_CMD"
  exit 1
fi

echo ""
echo "  Done. AgentOS starts on every login."
echo "  Check status anytime: ask --status  (or open the tray icon)"
echo ""
