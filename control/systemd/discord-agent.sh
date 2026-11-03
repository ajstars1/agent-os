#!/usr/bin/env bash
# Starts the phone agent: a Claude Code session that receives Discord DMs (Channels).
# Memory: a restart (crash, reboot, `agent restart`, an update) resumes the same conversation; once a day
# (aos-discord-fresh.timer, 04:00) it starts a new one, carried over by the aos agenda and the DM history.
# Every start first answers any of Ayush's DMs that arrived while it was down (Discord does not redeliver them).
cd /home/ubuntu/Developer/Ayush
STATE=/home/ubuntu/.cache/aos
SID_FILE=$STATE/discord-session
FRESH=$STATE/discord-fresh
TRANSCRIPTS=/home/ubuntu/.claude/projects/-home-ubuntu-Developer-Ayush
mkdir -p "$STATE"

sid=$(cat "$SID_FILE" 2>/dev/null)
if [[ -f $FRESH || -z $sid || ! -f $TRANSCRIPTS/$sid.jsonl ]]; then
  rm -f "$FRESH"
  sid=$(cat /proc/sys/kernel/random/uuid)
  echo "$sid" > "$SID_FILE"
  session=(--session-id "$sid")
  start="New day, fresh session. "
else
  session=(--resume "$sid")
  start="You were restarted. "
fi
# Ayush's DM channel id (looked up once with the bot token; the token never appears on a command line).
DM_FILE=$STATE/discord-dm-channel
if [[ ! -s $DM_FILE ]]; then
  CH=/home/ubuntu/.claude/channels/discord
  owner=$(python3 -c "import json; print(json.load(open('$CH/access.json'))['allowFrom'][0])")
  curl -s -m 10 -X POST -H 'Content-Type: application/json' -d "{\"recipient_id\":\"$owner\"}" \
    -H @<(sed -n 's/^DISCORD_BOT_TOKEN=["'\'']\{0,1\}\([^"'\'']*\).*/Authorization: Bot \1/p' "$CH/.env") \
    https://discord.com/api/v10/users/@me/channels \
    | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))' > "$DM_FILE" 2>/dev/null
fi
dm=$(cat "$DM_FILE" 2>/dev/null)
start+="Startup check (automatic, not a message from Ayush): fetch the last 20 messages of Ayush's Discord DM \
(fetch_messages, chat_id ${dm:-unknown: find it}). \
Answer every message of his from the last 3 hours that has no reply from you after it (it arrived while you were down); \
skip ones already answered by the Gemini fallback (🌐) or by an approval card. If there is nothing to answer, do nothing and say nothing."

# The plugin is disabled at user scope (it would log every Claude session in as the bot); enable it here only.
# Nobody watches this terminal, so commands the user settings only "ask" for are denied here: the session gets an
# error it can report on Discord instead of freezing at a prompt (aos-watch relays any prompt that still appears).
# Coordinator mode (on in the user settings) is off here: dropped from the env and overridden in flag settings,
# which outrank user settings. ~/.claude/settings.json is left alone.
unset CLAUDE_CODE_COORDINATOR_MODE
exec claude "${session[@]}" --name aos-discord \
  --channels plugin:discord@claude-plugins-official --permission-mode auto --chrome \
  --settings '{"enabledPlugins":{"discord@claude-plugins-official":true},"permissions":{"deny":["Bash(git checkout:*)"]},"env":{"CLAUDE_CODE_COORDINATOR_MODE":"0"}}' \
  --append-system-prompt "$(cat /home/ubuntu/Developer/Ayush/agent-os/control/systemd/discord-agent.md)" \
  "$start"
