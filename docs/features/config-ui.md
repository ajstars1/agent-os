# /config web — Browser Config UI

`/config web` starts a local HTTP server that serves a browser-based configuration editor. Changes made in the browser are written to `~/.agent-os/.env` and hot-reloaded into the running agent immediately.

---

## Starting the UI

```
❯ /config web
  Config UI started at http://localhost:7877
  Open in browser — changes sync to terminal in real-time.
  Run /config web stop to shut it down.
```

Open `http://localhost:7877` in your browser.

<!-- Screenshot placeholder: docs/assets/config-ui.png -->

---

## What it shows

The UI presents every known configuration key as a labeled form field:

| Label | Key | Notes |
|---|---|---|
| Anthropic API Key | `ANTHROPIC_API_KEY` | Shown as `••••••••` — type to replace |
| Google API Key | `GOOGLE_API_KEY` | Shown as `••••••••` — type to replace |
| Default Model | `DEFAULT_MODEL` | `auto`, `claude`, or `gemini` |
| Database Path | `DB_PATH` | Path to SQLite memory database |
| Skills Directory | `SKILLS_DIR` | Directory of `.md` skill files |
| CLAUDE.md Path | `CLAUDE_MD_PATH` | Path to system instructions |
| Agents Directory | `AGENTS_DIR` | Directory of `.json` agent profiles |
| Neural Engine URL | `NEURAL_ENGINE_URL` | Python sleep-cycle backend |
| Web Port | `WEB_PORT` | Hono web API server port |
| CORS Origin | `WEB_CORS_ORIGIN` | Allowed origin for web API |
| Allowed Directories | `ALLOWED_DIRS` | Colon-separated paths for file tools |
| Log Level | `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| Discord Token | `DISCORD_TOKEN` | Shown masked |
| Discord Client ID | `DISCORD_CLIENT_ID` | |
| Discord Guild ID | `DISCORD_GUILD_ID` | |

---

## Saving changes

Click **Save Changes**. The browser posts the updated fields to the local server, which writes them to `~/.agent-os/.env` and hot-reloads the values into the running process with `process.env[key] = value`.

A toast notification confirms success or shows an error message.

Click **Reload from Disk** to discard unsaved changes and re-read the current `.env` file.

---

## Real-time sync via SSE

The UI maintains a Server-Sent Events connection to `/events` on the config server. When the `.env` file changes — whether from a browser save or from `/config set` in the terminal — the server broadcasts the updated config over SSE and the browser updates the form fields automatically.

The connection status indicator in the top bar shows:
- Green dot — connected, changes apply in real-time
- Red dot — disconnected, auto-reconnecting every 3 seconds

This means you can have the browser open and use `/config set` in the terminal simultaneously; both stay in sync.

---

## Stopping the UI

```
❯ /config web stop
  Config UI stopped.
```

Or close the terminal session — the server stops with the process.

---

## Port

The default port is `7877`. To change it, set `CONFIG_UI_PORT` in your `.env`:

```bash
/config set CONFIG_UI_PORT 9000
```

The next `/config web` invocation will use the new port.

---

## Security

The config server binds to `127.0.0.1` only — it is not accessible from other machines on the network. Do not use this UI on a shared or public machine where others have local network access.
