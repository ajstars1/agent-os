#!/usr/bin/env bash
# Install aos-unlock (unlock the lock screen from Discord with a one-time code). Run it yourself:
#   sudo bash ~/Developer/Ayush/agent-os/control/boot/unlock/install.sh            # install / update code
#   sudo bash ~/Developer/Ayush/agent-os/control/boot/unlock/install.sh --new-key  # new secret + QR
#   sudo bash ~/Developer/Ayush/agent-os/control/boot/unlock/install.sh --remove   # uninstall
# The secret is created here as root and shown once as a QR code in this terminal only.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="${SUDO_USER:-ubuntu}"
CONF=/etc/aos-unlock

if [[ "${1:-}" == "--remove" ]]; then
  systemctl disable --now aos-unlock.service 2>/dev/null || true
  rm -f /etc/systemd/system/aos-unlock.service /run/aos-unlock.sock
  rm -rf /usr/local/lib/aos-unlock "$CONF" /var/lib/aos-unlock
  systemctl daemon-reload
  echo "aos-unlock removed (also delete the 'aos unlock' entry from your authenticator app)"
  exit 0
fi

command -v qrencode >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qrencode >/dev/null

# Root-owned copy of the code: the service never runs anything your user can edit.
install -d -m 755 /usr/local/lib/aos-unlock
install -m 644 -o root -g root "$HERE/unlockd.py" /usr/local/lib/aos-unlock/unlockd.py
install -d -m 700 "$CONF"
echo "$USER_NAME" > "$CONF/user"
grep '^DISCORD_WEBHOOK_URL=' "$HERE/../../.env.local" | cut -d= -f2- > "$CONF/webhook"
chmod 600 "$CONF/user" "$CONF/webhook"

cat > /etc/systemd/system/aos-unlock.service <<'EOF'
[Unit]
Description=aos-unlock: unlock the Hyprland lock screen with a one-time code (socket /run/aos-unlock.sock)

[Service]
ExecStart=/usr/bin/python3 -I /usr/local/lib/aos-unlock/unlockd.py
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

NEW_KEY=0
[[ ! -s "$CONF/secret" || "${1:-}" == "--new-key" ]] && NEW_KEY=1
if [[ $NEW_KEY == 1 ]]; then
  python3 -I -c 'import base64,secrets;print(base64.b32encode(secrets.token_bytes(20)).decode())' > "$CONF/secret"
  chmod 600 "$CONF/secret"
  rm -f /var/lib/aos-unlock/state.json
fi
systemctl daemon-reload
systemctl enable aos-unlock.service >/dev/null 2>&1
systemctl restart aos-unlock.service

if [[ $NEW_KEY == 1 ]]; then
  echo
  echo "Scan this with your authenticator app (it adds 'aos unlock'):"
  qrencode -t ansiutf8 "otpauth://totp/aos:unlock?secret=$(cat "$CONF/secret")&issuer=aos&digits=6&period=30"
  read -rp "Scanned? Press Enter to wipe it from this screen... " _
  printf '\033[2J\033[3J\033[H'
fi
sleep 1
systemctl is-active --quiet aos-unlock.service && echo "aos-unlock running. In Discord: unlock <code>, lock." \
  || { echo "aos-unlock failed to start:"; journalctl -u aos-unlock -n 10 --no-pager; exit 1; }
