#!/usr/bin/env bash
# Claude Code PreToolUse hook for mcp__claude-in-chrome__*, also run by hand: "extension disconnected" almost always
# means Chrome is closed, so start it and wait for the extension's native host before the tool call goes out.
# Never blocks the call (always exits 0); a note goes to stderr.
pgrep -x chrome >/dev/null && exit 0
hyprctl dispatch exec google-chrome-stable >/dev/null 2>&1 \
  || (setsid google-chrome-stable >/dev/null 2>&1 &)
for _ in $(seq 1 25); do
  sleep 1
  pgrep -f 'chrome-native-host' >/dev/null && { echo "ensure-chrome: Chrome was closed; started it, extension connected" >&2; exit 0; }
done
echo "ensure-chrome: started Chrome but the Claude extension has not connected after 25 s; retry once, then use pilot-browser" >&2
exit 0
