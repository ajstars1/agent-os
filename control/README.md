# aos control

The agent-os control plane: one task list and calendar for every venture, an agent on this Linux machine that works through it, and a phone channel (Discord, OpenClaw-style) to talk to it.

```
phone (Discord DM)  ─►  aos-discord: Claude Code session on Linux (Channels) ──┐
phone (Claude app)  ─►  claude-rc: Remote Control server, spawns sessions ─────┤
systemd timer 10min ─►  runner/tick.ts: pings overdue, runs due `auto` tasks ──┼─► aos MCP (Vercel) ─► Supabase
any Claude session  ─►  desk MCP (local): windows, kitty terminals, claude sessions, screen + mouse + keys
every Claude session ─► SessionStart hook prints today's agenda ──────────────┘        │
Vercel cron 08:00 IST ─► morning digest to Discord ◄──────────────────────────────────┘
```

- **MCP:** `https://<your-app>.vercel.app/api/mcp` (`AOS_MCP_URL`; bearer token `AOS_MCP_TOKEN`, both in `.env.local`). Tools: `agenda`, `task_list`, `task_add`, `task_update`, `task_done` (handles recurrence), `task_delete` (soft), `approval_request`, `approval_list`, `approval_decide`, `approval_mark_sent`, `log_activity`, `activity_recent`, `event_add`, `runs_recent`. Registered in Claude Code at user scope as `aos`.
- **DB:** Supabase project `aos-control` (Mumbai, free tier). Tables: tasks, runs, approvals, events, activity. RLS on, service role only. Soft delete.
- **Desk MCP** (`desk/server.py`, user scope as `desk`): live control of this Hyprland desktop. Ladder: `windows`/`open_app`/`close_windows`/`focus_window` (hyprctl) → `terminal_open`/`terminal_send`/`terminal_read`/`terminal_key` (kitty remote control, reads text without screenshots) → `claude_session` (visible Claude in kitty with Remote Control, returns the phone link) → `screenshot` + `click`/`type_text`/`key`/`scroll`/`drag`/`paste` (virtual uinput mouse and keyboard, US layout). No root needed: /dev/uinput is writable for the seat user. Tested 28 Oct. Does nothing on a locked screen. Extra: `power` (reboot / poweroff / suspend after a delay, `cancel`; refuses poweroff and suspend without force because nothing can wake the PC remotely yet, and reboot without force while auto-login is off), `desk_status`, `wake_screen`, `stay_awake` (blocks the 10-min idle lock), `close_windows(force)`. The unattended runner is denied the desk tools (`--disallowedTools mcp__desk`). Screenshots are also saved to `~/.cache/aos-desk/` (last 30) so the Discord agent can attach them. `live_start`/`live_stop` run `desk/live.py`: one #aos webhook message whose screenshot refreshes every 3 s, up to 60 min, no tokens used. Real video is not possible: Discord bots cannot screen-share.
- **Sending rule:** unattended runs never send. They queue drafts with `approval_request`, Discord shows them, you reply `yes N`, and an approved draft becomes a `SEND APPROVED #N` task that the runner sends word for word.
- **Recurrence:** `daily`, `weekdays`, `weekly:MO,TH`, `every:3d`. Finishing a recurring task creates the next one.

## Setup (things only Ayush can do)

1. **Switch on the Linux side:** `! bash ~/Developer/Ayush/agent-os/control/install.sh`
   Starts the 10-minute runner timer and the Remote Control server, and adds the agenda hook.
   Remote Control needs one interactive first run to answer its "Enable Remote Control?" and trust prompts. If `claude-rc` keeps restarting, run `claude remote-control --name linux` once in a terminal, answer y, Ctrl+C, then `systemctl --user restart claude-rc`.
2. **Discord webhook (pings and digest):** make a private server with a `#aos` channel → Channel settings → Integrations → Webhooks → New → Copy URL. Then:
   - add `DISCORD_WEBHOOK_URL=...` to `agent-os/control/.env.local` (never paste it in chat)
   - `! cd ~/Developer/Ayush/agent-os/control && vercel env add DISCORD_WEBHOOK_URL production && vercel deploy --prod`
3. **Discord bot (talk to it from the phone):** discord.com/developers → New Application → Bot → enable Message Content Intent → Reset Token and copy it, then invite it to your server (OAuth2 → URL Generator → `bot` scope). The plugin is installed (28 Oct). Save the token from the clipboard without it touching the chat:
   - `! mkdir -p ~/.claude/channels/discord && printf 'DISCORD_BOT_TOKEN=%s\n' "$(wl-paste)" > ~/.claude/channels/discord/.env && chmod 600 ~/.claude/channels/discord/.env && echo saved`
   - The plugin is disabled at user scope on purpose (it would log every Claude session in as the bot); `systemd/discord-agent.sh` enables it for the agent session only.
   - `! bash ~/Developer/Ayush/agent-os/control/install.sh --discord`, DM the bot "hi", then pair from here: `tmux send-keys -t aos-discord '/discord:access pair <code>' Enter`, then the same with `/discord:access policy allowlist`. Watch it with `tmux attach -t aos-discord`.
4. **Remote desktop (live video + touch control from the phone):** in a real terminal (sudo needs a password):
   `sudo apt install -y wayvnc && sudo tailscale set --operator=$USER && sudo tailscale up && bash ~/Developer/Ayush/agent-os/control/install.sh --vnc`
   Phone: Tailscale app on the same account, then a VNC app (AVNC on Android, RealVNC Viewer on iPhone) → `<PC Tailscale IP>:5900` (`tailscale ip -4`). wayvnc listens on the Tailscale IP only and has no VNC password: every device in your tailnet can connect, so add a password before sharing the tailnet with anyone. You can unlock the lock screen through it.
5. **Come back by itself after a reboot:** `sudo bash ~/Developer/Ayush/agent-os/control/boot/apply.sh` (undo: `--undo`). greetd then logs ubuntu in once at boot through `boot/autologin-session.sh`, and the first `exec-once` in `~/.config/hypr/hyprland.conf` (`boot/lock-on-autologin.sh`) locks the screen at once with no grace, so the bot, VNC and runner start while the desk stays locked. Manual logins are untouched. Unlock over VNC. For power cuts also set BIOS → Power Management → AC Recovery = Power On.
6. **Below the OS (Intel AMT + MeshCentral):** checklist in `boot/BIOS-AMT-CHECKLIST.md`. Server: Oracle Always Free VM `aos-mesh` (its Tailscale address is `AOS_VM` in `.env.local`) running MeshCentral (Node 22, `/opt/meshcentral`, systemd `meshcentral`).
   - Web UI only at `https://<VM Tailscale IP>` over Tailscale (portBind + userAllowedIP), 2FA forced, sign-ups off.
   - AMT CIRA: the PC's AMT connects out to `<VM public IP>:4433`. That port admits only the home IP (an Oracle NSG rule, `OCI_NSG_ID`, + VM iptables); `runner/mps-firewall.ts` moves both when the ISP changes the IP (OCI CLI profile `AOS` in `~/.oci/config`).
   - Device group `home`: agent installed on the PC (root service in `/usr/local/mesh_services`), Intel AMT policy Simple ACM with CIRA. Power on / off / reset and the AMT screen (KVM, works in BIOS) from the device page → Actions or the Intel AMT tab.
7. **aos-cloud (always-on basic bot):** `cloud/bot.ts` runs on `aos-mesh` (systemd `aos-cloud`, user `aoscloud`, secrets in `/etc/aos-cloud/env` root:aoscloud 640). Separate Discord bot, DMs from Ayush only: `pc` / `pc on` / `pc off` / `pc reset` (MeshCentral login token + meshctrl: AMT when Linux is down, clean agent shutdown when it is up; off/reset need `force pc …`), task commands through the aos MCP, anything else to Gemini Flash. Deploy `bash cloud/deploy.sh`; secrets once with `bash cloud/set-secrets.sh` (hidden prompts).
   - `do <anything>` on aos-cloud queues a Claude task (owner claude, auto) and wakes the PC through AMT if it is off; the runner starts it ~2 min after boot (`OnStartupSec`) and posts the summary in #aos. Free text is routed by Gemini: answered, or offered as a PC task (`go`). Voice notes are transcribed first.
   - Runner extras: cheap watchers every 30 min (`runner/watchers.ts`: GKT new leads/bookings, WhatsApp delivery failures, chats waiting), daily copy of the MeshCentral auto-backup to `~/Backups/aos-mesh` (`runner/mesh-backup.ts`). Public SSH on aos-mesh is closed; use Tailscale.
8. **Phone app:** in the Claude app → Code, the machine shows up as "linux" once `claude-rc` runs; start sessions there.

## Use

From Discord: `today`, `yes 12`, `no 12`, `edit 12: new text`, `done 7`, `move 7 tomorrow 10am`, `add call the accountant Fri 11am`, or any request ("check if anyone replied on LinkedIn").
From any Claude session: the agenda prints at start; say "add this to aos" or "mark #7 done".

## Run by hand

- `bun runner/tick.ts`: one tick (needs `.env.local`)
- `bun hooks/agenda.ts`: what the hook prints
- `bun runner/smoke.ts && bun runner/tick.ts`: end-to-end smoke test (passed 28 Oct: MCP + Chrome + self-close, ~$0.92)
- Deploy: `vercel deploy --prod` from this folder. Build needs TypeScript 6 (Next 15 can't use TS 7).

## Costs and limits

- Each unattended run is a full Claude session (smoke test about $0.92 of usage). About 8 auto tasks a weekday at that rate is roughly $5 to $10 a day of plan usage. Make tasks `auto: false` to cut it.
- The runner does one task per tick, so a queue drains at about 6 tasks an hour. Chrome runs need the desktop logged in.
- Vercel Hobby cron runs once a day, so the morning digest is the only cloud cron. Everything frequent runs on the local timer.
