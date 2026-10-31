#!/usr/bin/env bash
# Remote desktop for the phone: wayvnc bound to this machine's Tailscale IP only, so it is
# reachable from Ayush's tailnet devices and never from the LAN or the internet.
set -euo pipefail
until tailscale status >/dev/null 2>&1; do sleep 5; done
ip=$(tailscale ip -4 | head -1)
exec wayvnc --render-cursor --max-fps=30 "$ip" 5900
