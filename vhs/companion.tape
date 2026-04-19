# AgentOS — Companion Profile
# Records: ask --demo companion
# Output: gifs/companion.gif

Output vhs/gifs/companion.gif

Set Shell "zsh"
Set FontSize 14
Set Width 860
Set Height 400
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
Sleep 300ms

Type "ask --demo companion"
Enter
Sleep 8s
