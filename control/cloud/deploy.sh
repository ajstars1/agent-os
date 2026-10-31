#!/usr/bin/env bash
# Deploy aos-cloud to the MeshCentral VM over Tailscale. Run from the PC: bash control/cloud/deploy.sh
# Secrets are not handled here: run set-secrets.sh yourself once (it prompts, hidden).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Settings come from control/.env.local (gitignored), or the environment.
conf() { sed -n "s/^$1=//p" "$(cd "$(dirname "$0")/.." && pwd)/.env.local" 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//"; }
VM="${AOS_VM:-$(conf AOS_VM)}"; : "${VM:?set AOS_VM=ubuntu@<VM Tailscale IP> in control/.env.local}"
MESH_URL="${MESH_URL:-$(conf MESH_URL)}"; : "${MESH_URL:?set MESH_URL in control/.env.local}"
AOS_MCP_URL="${AOS_MCP_URL:-$(conf AOS_MCP_URL)}"; : "${AOS_MCP_URL:?set AOS_MCP_URL in control/.env.local}"
scp -q "$HERE/bot.ts" "$HERE/package.json" "$HERE/aos-cloud.service" "$VM:/tmp/"
ssh "$VM" bash -s -- "$MESH_URL" "$AOS_MCP_URL" <<'REMOTE'
set -e
id aoscloud >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin aoscloud
sudo install -d -m 755 -o root -g root /opt/aos-cloud
sudo install -m 644 /tmp/bot.ts /tmp/package.json /opt/aos-cloud/
sudo install -m 644 /opt/meshcentral/node_modules/meshcentral/meshctrl.js /opt/aos-cloud/meshctrl.cjs
cd /opt/aos-cloud && sudo npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
sudo install -d -m 750 -o root -g aoscloud /etc/aos-cloud
sudo install -m 644 /tmp/aos-cloud.service /etc/systemd/system/aos-cloud.service
sudo systemctl daemon-reload
if sudo test -f /etc/aos-cloud/env; then
  sudo sed -i "/^MESH_URL=/d;/^AOS_MCP_URL=/d" /etc/aos-cloud/env
  printf "MESH_URL=%s\nAOS_MCP_URL=%s\n" "$1" "$2" | sudo tee -a /etc/aos-cloud/env >/dev/null
fi
if sudo test -s /etc/aos-cloud/env; then sudo systemctl enable --now aos-cloud >/dev/null 2>&1; sudo systemctl restart aos-cloud; sleep 6; sudo journalctl -u aos-cloud -n 5 --no-pager -o cat
else echo "deployed; secrets missing: run control/cloud/set-secrets.sh"; fi
REMOTE
