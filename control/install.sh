#!/usr/bin/env bash
# aos control: switch on the Linux side. Run it yourself:  ! bash ~/Developer/Ayush/agent-os/control/install.sh
# Safe to re-run. Flags: --discord once the Discord plugin is configured and paired (README step 3),
# --vnc once wayvnc is installed and Tailscale is up (README step 4).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"

echo "1/3 systemd user units"
for f in aos-tick.service aos-tick.timer aos-discord.service aos-discord-fresh.service aos-discord-fresh.timer \
  aos-watch.service claude-rc.service aos-vnc.service; do
  ln -sf "$HERE/systemd/$f" "$UNITS/$f"
done
systemctl --user daemon-reload
systemctl --user enable --now aos-tick.timer
systemctl --user enable --now claude-rc.service
for arg in "$@"; do
  case "$arg" in
    --discord) systemctl --user enable --now aos-discord.service aos-watch.service aos-discord-fresh.timer ;;
    --vnc) command -v wayvnc >/dev/null || { echo "wayvnc missing: sudo apt install -y wayvnc"; exit 1; }
           systemctl --user enable --now aos-vnc.service ;;
  esac
done

echo "2/3 SessionStart hook (agenda in every Claude session)"
python3 - <<'PY'
import json, os, shutil
p = os.path.expanduser('~/.claude/settings.json')
shutil.copy(p, p + '.bak-aos')
d = json.load(open(p))
cmd = 'cd /home/ubuntu/Developer/Ayush/agent-os/control && /home/ubuntu/.bun/bin/bun hooks/agenda.ts'
hooks = d.setdefault('hooks', {}).setdefault('SessionStart', [])
if not any(h.get('hooks', [{}])[0].get('command') == cmd for h in hooks):
    hooks.append({'matcher': 'startup', 'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
json.dump(d, open(p, 'w'), indent=2)
print('   hook present (backup: settings.json.bak-aos)')
PY

echo "3/3 status"
systemctl --user list-timers aos-tick.timer --no-pager | head -2
systemctl --user --no-pager --lines=5 status claude-rc.service | sed -n '1,8p' || true
systemctl --user is-active aos-vnc.service >/dev/null && echo "   vnc: $(tailscale ip -4 | head -1):5900 (Tailscale only)"
echo "Done. Logs: journalctl --user -u aos-tick -u claude-rc -u aos-discord -u aos-vnc -f"
