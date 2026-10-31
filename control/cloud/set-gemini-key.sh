#!/usr/bin/env bash
# Add or replace aos-cloud's Gemini key (AI Studio "AIza..." or Vertex express "AQ..."). Hidden prompt:
#   bash ~/Developer/Ayush/agent-os/control/cloud/set-gemini-key.sh
set -euo pipefail
# Settings come from control/.env.local (gitignored), or the environment.
conf() { sed -n "s/^$1=//p" "$(cd "$(dirname "$0")/.." && pwd)/.env.local" 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//"; }
VM="${AOS_VM:-$(conf AOS_VM)}"; : "${VM:?set AOS_VM=ubuntu@<VM Tailscale IP> in control/.env.local}"
read -rsp "Gemini / Vertex API key: " KEY; echo
[[ -n "$KEY" ]] || { echo "nothing entered"; exit 1; }
printf '%s\n' "$KEY" | ssh "$VM" 'read -r k; sudo sed -i "/^GEMINI_API_KEY=/d" /etc/aos-cloud/env && printf "GEMINI_API_KEY=%s\n" "$k" | sudo tee -a /etc/aos-cloud/env >/dev/null && sudo systemctl restart aos-cloud && sleep 6 && sudo journalctl -u aos-cloud -n 1 --no-pager -o cat'
unset KEY
