# PromptInput — CLI Input Features

The AgentOS CLI uses a custom Ink-based input component (`packages/cli/src/ui/PromptInput.tsx`) with several features designed for developer workflows.

---

## Multi-line input (Alt+Enter)

By default, pressing **Enter** submits the message. To insert a newline, press **Alt+Enter** (Meta+Enter).

```
  ❯ Here is a multi-line
  … message with two lines
  [multi-line: Alt+Enter=newline  Enter=submit]
```

When the buffer contains a newline, a hint appears below the prompt and continuation lines are prefixed with `…` instead of `❯`.

**Cursor navigation in multi-line mode:**

| Key | Action |
|---|---|
| Up arrow | Move cursor to previous line (same column) |
| Down arrow | Move cursor to next line (same column) |
| Ctrl+A | Move to start of current line |
| Ctrl+E | Move to end of current line |
| Ctrl+K | Delete from cursor to end of current line |
| Ctrl+U | Delete from cursor to start of current line |

**Single-line mode** (no newlines in buffer): Up/Down navigate history instead.

---

## Command suggestions

When the buffer starts with `/`, a suggestion popup appears above the prompt:

```
    /config
    /clear
    /cd
  ❯ /c
```

Navigation:
- **Tab** — cycle through suggestions and auto-complete
- **Up/Down arrows** — move selection in the popup
- **Enter** — run the selected command
- **Escape** — dismiss the popup

Suggestions are drawn from all registered commands plus any additional commands passed via props. Matching is prefix-based, case-insensitive, showing up to 6 results.

---

## Paste truncation

Large pastes (over 10,000 characters) are automatically truncated in the display to prevent the terminal from becoming unusable. The full content is preserved in a paste reference and sent to the agent intact.

Example of a truncated paste:

```
  ❯ Here is the start of a large file...
    [paste truncation: …paste #1 +847 lines…]
    ...and the end of the file.

  1 large paste truncated in display
```

Thresholds:
- Truncation kicks in at **10,000 characters**
- **500 characters** from the start and **500 characters** from the end are shown
- The middle is replaced with `[…paste #N +M lines…]`
- Multiple pastes in one message are numbered separately

The full paste content is reconstructed before being sent to the LLM.

---

## @-file mentions

Type `@` followed by a file path to reference a file. The component detects the mention as you type and shows a hint:

```
  ❯ review @src/lib/utils.ts and tell me what it does

  ◎ file: src/lib/utils.ts
```

For image paths (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`), the hint changes to:

```
  ◎ image: assets/screenshot.png
```

The detection is based on the path at the cursor position — it walks back from the cursor to find the `@` character, stopping at spaces and newlines.

---

## Keyboard shortcuts summary

| Key | Action |
|---|---|
| Enter | Submit (or select suggestion if popup is open) |
| Alt+Enter | Insert newline |
| Tab | Cycle command suggestions |
| Escape | Dismiss suggestion popup |
| Up / Down | History navigation (or popup selection) |
| Left / Right | Move cursor one character |
| Ctrl+B | Move cursor one word backward |
| Ctrl+F | Move cursor one word forward |
| Ctrl+A | Move to start of line |
| Ctrl+E | Move to end of line |
| Ctrl+K | Kill to end of line |
| Ctrl+U | Kill to start of line |
| Ctrl+L | Clear input buffer |
| Backspace | Delete character before cursor |
