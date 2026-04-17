# Permission System

AgentOS gates destructive tool calls behind an interactive permission prompt. Before any `edit`, `write_file`, or `bash` invocation executes, the user must explicitly approve it.

---

## How it works

When the agent decides to call a tool that requires permission, the engine emits a `permission_request` stream chunk instead of executing immediately. The CLI intercepts this and renders the `PermissionPrompt` component (`packages/cli/src/ui/PermissionPrompt.tsx`), blocking further output until the user decides.

**Data flow:**

```
Agent chooses tool call
        │
        ▼
Does tool require permission?
        │
  Yes ──┤
        ▼
Emit permission_request chunk
        │
        ▼
CLI renders PermissionPrompt
        │
        ▼
User responds: allow / always / deny
        │
        ▼
Permission callback resolves
        │
  allow / always ──► tool executes, result returned to agent
  deny           ──► tool returns error "denied by user"
```

---

## The permission prompt

```
⚠ Permission Required

✎ edit

  - old line being removed
  + new line being added
    unchanged context line

 Allow once [y/1]   Always allow [a/2]   Deny [n/3]

← → to select  ·  Enter to confirm  ·  Esc to deny
```

The prompt shows:
- The tool icon (`❯` for bash, `✎` for edit, `◉` for write_file, `⚙` for others)
- The tool name
- A diff-style preview of what will happen (red lines = removed, green lines = added)
- Three action buttons

---

## The three decisions

| Decision | Shortcut | Effect |
|---|---|---|
| **Allow once** | `y` or `1` or Enter | Tool runs once. Next invocation of this tool will ask again. |
| **Always allow** | `a` or `2` | Tool runs and is added to the session allow-list. All subsequent calls to this tool in this session are approved silently. |
| **Deny** | `n` or `3` or Escape | Tool does not run. The agent receives an error and may try a different approach. |

---

## Navigation

- **Left/Right arrows** — move selection between the three options
- **Enter** — confirm the currently selected option
- **y** — always Allow once
- **a** — always Allow always
- **n** — always Deny
- **1 / 2 / 3** — number shortcuts for each option
- **Escape** — Deny (same as `n`)

---

## Session cache

`Always allow` decisions are cached for the lifetime of the process. If you grant `Always allow` to `bash`, subsequent bash invocations in that session skip the prompt. The cache is in-memory only — it resets when you quit `aos`.

---

## Which tools require permission

Tools that require permission are those with destructive or system-level side effects:

| Tool | Icon | Requires permission |
|---|---|---|
| `bash` | `❯` | Yes |
| `edit` | `✎` | Yes |
| `write_file` | `◉` | Yes |
| `web_fetch` | — | No |
| `read_file` | — | No |

MCP tool calls go through the same permission system — the tool name and a preview of the input are shown to the user.

---

## File access restrictions

In addition to the per-call permission system, the `write_file` and `read_file` tools are path-jailed. The `ALLOWED_DIRS` environment variable controls which directories they can access:

```bash
# .env
ALLOWED_DIRS=/home/user/projects:/tmp
```

If `ALLOWED_DIRS` is empty, access is restricted to the current working directory. Attempts to access paths outside the allowed list are rejected before the permission prompt is even shown.
