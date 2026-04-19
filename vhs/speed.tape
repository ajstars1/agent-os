# AgentOS — Speed Benchmark
# Records: ask --demo speed
# Output: gifs/speed.gif

Output vhs/gifs/speed.gif

Set Shell "zsh"
Set FontSize 14
Set Width 860
Set Height 380
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 40ms
Set CursorBlink false

# Setup (hidden)
Hide
Type "cd /home/ubuntu/Developer/Ayush/agent-os"
Enter
Sleep 300ms
Type "alias ask='node packages/cli/dist/ask.js'"
Enter
Sleep 300ms
Show

# Clear and run
Type "clear"
Enter
Sleep 300ms

Type "ask --demo speed"
Enter

# Boot + 2 API calls (Claude ~3s, Gemini ~2s) + output
Sleep 18s
