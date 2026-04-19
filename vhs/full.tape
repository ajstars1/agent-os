# AgentOS — Full Capability Showcase (animated)
# Records: ask --demo  (full slow reveal)
# Output: gifs/full.gif
#
# This runs ~45s — every section animates line by line with pauses.
# Good for a hero GIF on the README.

Output vhs/gifs/full.gif

Set Shell "zsh"
Set FontSize 13
Set Width 900
Set Height 600
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 40ms
Set CursorBlink false

Hide
Type "cd /home/ubuntu/Developer/Ayush/agent-os"
Enter
Sleep 300ms
Type "alias ask='node packages/cli/dist/ask.js'"
Enter
Sleep 300ms
Show

Type "clear"
Enter
Sleep 500ms

Type "ask --demo"
Enter

# Header + logo (~500ms)
# Providers section (~800ms)
# Speed section: boot + 2 API calls (~10s) + line printing
# Memory section (~2s)
# Companion section (~2s)
# Learner section (~2s)
# Skills section (~2s)
# Arch section (~3s)
# Footer (~500ms)
Sleep 55s
