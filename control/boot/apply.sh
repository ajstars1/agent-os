#!/usr/bin/env bash
# Turn on boot auto-login (into a locked screen). Run it yourself, it needs root:
#   sudo bash ~/Developer/Ayush/agent-os/control/boot/apply.sh          # enable
#   sudo bash ~/Developer/Ayush/agent-os/control/boot/apply.sh --undo   # restore the original config
set -euo pipefail
CONF=/etc/greetd/config.toml
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
if [[ "${1:-}" == "--undo" ]]; then
  [[ -f $CONF.bak-aos ]] && cp "$CONF.bak-aos" "$CONF" && echo "restored $CONF (auto-login off)" || echo "no backup, nothing to undo"
  exit 0
fi
if grep -q '^\[initial_session\]' "$CONF"; then
  echo "initial_session already set in $CONF, leaving it alone"; exit 0
fi
cp "$CONF" "$CONF.bak-aos"
cat >> "$CONF" <<TOML

# aos: after boot, log ubuntu in once and lock at once (agent-os/control/boot). Undo: apply.sh --undo
[initial_session]
command = "$HERE/autologin-session.sh"
user = "ubuntu"
TOML
echo "auto-login on (backup: $CONF.bak-aos). Takes effect at the next boot."
