# AgentOS — HAM Memory
# Records: ask --demo memory
# Output: gifs/memory.gif

Output vhs/gifs/memory.gif

Set Shell "zsh"
Set FontSize 14
Set Width 860
Set Height 360
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

Type "ask --demo memory"
Enter
Sleep 7s
