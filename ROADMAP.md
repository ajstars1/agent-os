# AgentOS Superset Roadmap

**Mission:** AgentOS = Claude Code + Hermes Agent + unique innovations.  
The single AI agent that codes, remembers, browses, talks to any platform, and gets smarter while you sleep.

---

## Current State (v0.2.2 — Phase 1+2 complete)

| Feature | Status |
|---|---|
| HAM 4-level memory (82% token reduction) | ✅ |
| Claude + Gemini dual-LLM routing (`cc:` / `g:` / `auto`) | ✅ |
| Tools: bash, read_file, write_file, edit, glob, grep, ls, web_fetch | ✅ |
| MCP JSON-RPC 2.0 client | ✅ |
| CLI (Ink/React terminal UI) | ✅ |
| Discord bot | ✅ |
| Hono web API (POST /chat, SSE /chat/stream) | ✅ |
| Skills hot-reload (.md files) | ✅ |
| Agent profiles (JSON) | ✅ |
| Planning mode | ✅ |
| Feedback + `/dream` sleep-cycle | ✅ |
| Python neural engine (PyTorch, background learner) | ✅ |
| Semantic knowledge graph (SPO) | ✅ |

---

## Phase 1 — Tool & Hook Foundation ✅ DONE

> Makes agent-os a parity match for Claude Code's developer workflow features.

### 1A. Hooks System ✅ DONE
**What:** 5-event lifecycle hooks fired around every tool call and message.

Events:
- `toolUsePre` — fires before a tool runs. If a command hook exits non-zero → tool is **blocked**
- `toolUsePost` — fires after tool success, gets the output
- `toolUseError` — fires on tool failure
- `messageReceived` — fires when user sends a message
- `responseDone` — fires after the full response is emitted

Hook types:
- **command** — run a shell command (`{ type: "command", command: "echo {toolName}" }`)
- **http** — POST JSON payload to a URL (`{ type: "http", url: "https://..." }`)
- **prompt** — prepend text to the next user message (`{ type: "prompt", content: "..." }`)

Configure in `.agent-os/settings.json`:
```json
{
  "hooks": [
    {
      "events": ["toolUsePre"],
      "match": "bash",
      "hook": { "type": "command", "command": "echo 'about to run: {toolInput}'" }
    },
    {
      "events": ["responseDone"],
      "hook": { "type": "http", "url": "https://my-webhook.example.com/agent-done" }
    }
  ]
}
```

**Files:**
- `packages/core/src/hooks/types.ts` — event/hook types
- `packages/core/src/hooks/runner.ts` — executor + interpolation
- `packages/core/src/hooks/index.ts` — exports
- `packages/core/src/engine.ts` — fires messageReceived + responseDone hooks
- `packages/core/src/agents/tool-executor.ts` — fires toolUsePre/Post/Error hooks

### 1B. web_search Tool ✅ DONE
Uses Brave Search API if `BRAVE_SEARCH_API_KEY` is set, otherwise DuckDuckGo (free, no key needed).

```
search the web for "Next.js 15 breaking changes"
```

**File:** `packages/core/src/tools/builtin.ts`

### 1C. Session Cost Tracking ✅ DONE
- USD pricing constants for all models (Claude, Gemini, OpenRouter, Ollama)
- StatusBar shows `↑1840 ↓412 ~$0.04 [$0.18 total]` after each turn
- New active subagent indicator: `⚡2 agents`

**Files:**
- `packages/shared/src/config/pricing.ts` — pricing table + `estimateCost()` + `formatCost()`
- `packages/shared/src/types/index.ts` — `SessionCost` type added to `StreamChunk`
- `packages/cli/src/ui/StatusBar.tsx` — cost + subagent count display

### 1D. Settings Hierarchy ✅ DONE
Layered JSON settings, same pattern as Claude Code:

```
~/.agent-os/settings.json      ← global (all projects)
.agent-os/settings.json        ← project (commit this)
.agent-os/settings.local.json  ← local overrides (gitignore this)
.env                            ← env vars (highest priority)
```

All layers are deep-merged. Example `settings.json`:
```json
{
  "defaultModel": "claude",
  "hooks": [...],
  "permissions": { "allow": ["glob", "read_file"], "deny": [] },
  "allowedDirs": ["/home/ayush/projects"],
  "browser": { "backend": "local" }
}
```

**File:** `packages/shared/src/config/settings.ts`

### 1E. Extended Types ✅ DONE
- `ChannelType` expanded: `cli | discord | telegram | slack | whatsapp | signal | matrix | email | web`
- `LLMProvider` expanded: `claude | gemini | openrouter | ollama | auto`
- New env vars: `OPENROUTER_API_KEY`, `BRAVE_SEARCH_API_KEY`, `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`

---

## Phase 2 — Browser & Subagents ✅ DONE

> Browser automation + parallel agent delegation = what Hermes does that Claude Code can't.

### 2A. Browser Automation
New package: `packages/browser/`

Three backends (configurable in settings.json → `browser.backend`):
1. **`local`** (default) — Playwright headless Chromium, zero cost
2. **`browser-use`** — Browser Use cloud, residential proxies (needs `BROWSER_USE_API_KEY`)
3. **`camofox`** — Anti-detect mode, fingerprint randomization

Tools exposed:
```
browser_navigate(url)           → navigate to URL
browser_click(ref)              → click element by accessibility ref
browser_type(ref, text)         → type text into element
browser_snapshot()              → accessibility tree of current page
browser_screenshot()            → base64 PNG of current page
browser_close()                 → cleanup session
```

Usage example:
```
go to github.com/trending and give me the top 5 repos today
```

### 2B. Subagent Delegation
New file: `packages/core/src/agents/delegate.ts`

```typescript
// delegate_task tool
{
  goal: "research Next.js 15 migration guide",
  tools: ["web_search", "web_fetch", "read_file"],  // restricted set
  maxIterations: 20
}
```

- Fresh conversation context (no parent history)
- Restricted toolsets (no `delegate_task` recursion, no `bash` by default)
- Parallel execution via `Promise.all` for batch mode
- Depth limit: `settings.delegation.maxDepth` (default 1, max 3)
- SubagentOverlay in CLI shows active agents live

### 2C. Cron Scheduler
New package: `packages/cron/`

```bash
aos cron add "daily-standup" --schedule "0 9 * * mon-fri" --prompt "Summarise my open GitHub issues" --deliver discord
aos cron list
aos cron pause "daily-standup"
```

Schedule formats:
- `"30m"` — once in 30 minutes
- `"every 2h"` — recurring every 2 hours
- `"0 9 * * *"` — standard cron expression
- `"2026-05-10T14:00"` — one-shot at specific time

Delivery targets: `local` (file), `cli`, `discord`, `telegram`, `slack`, `email`

Jobs persisted in `~/.agent-os/cron/jobs.db` (SQLite).

---

## Phase 3 — Platform Gateway Expansion ✅ DONE

> Hermes has 15 platforms. We now have 7 in one daemon.

`packages/gateway/` — single daemon, all platforms share one AgentEngine and SQLite memory.

```
packages/gateway/src/
├── base.ts               ← PlatformAdapter abstract class (chunk, runAndDeliver)
├── gateway.ts            ← GatewayDaemon — starts all configured platforms
├── bin.ts                ← aos-gateway CLI entry point
└── platforms/
    ├── telegram.ts       ✅ pure-fetch long-polling, DM + group, typing indicator
    ├── discord.ts        ✅ discord.js, guild + DM + thread support, migrated from packages/discord/
    ├── slack.ts          ✅ @slack/bolt, Socket Mode or HTTP events, /ask slash command
    ├── whatsapp.ts       ✅ Meta Cloud API webhook, allowlisted numbers
    ├── signal.ts         ✅ signal-cli REST API bridge, group support
    ├── matrix.ts         ✅ matrix-js-sdk, room allowlist
    └── email.ts          ✅ IMAP poll + SMTP reply, subject prefix filter
```

**Start:**
```bash
aos-gateway                        # starts all platforms with valid env vars
aos-gateway --only telegram,slack  # start specific platforms
aos-gateway --list                 # show which platforms are configured
```

**Status in CLI:**
```
/gateway    # show platform config status
```

**Per-platform env vars:**
| Platform  | Required env vars |
|-----------|-------------------|
| Telegram  | `TELEGRAM_BOT_TOKEN` |
| Discord   | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` |
| Slack     | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| WhatsApp  | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` |
| Signal    | `SIGNAL_CLI_URL`, `SIGNAL_NUMBER` |
| Matrix    | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID` |
| Email     | `EMAIL_IMAP_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` |

---

## Phase 4 — Intelligence Layer ✅ DONE

> The features that make agent-os smarter over time — plus deep improvements to the existing Python self-learning engine.

### 4A. Skill Curator ✅ DONE
`packages/core/src/skills/curator.ts`

- Scans `~/.agent-os/skills/` for PREFIX CLUSTERS (2+ skills sharing a domain keyword)
- Triggers: idle 2+ hours OR 7 days since last run
- Lifecycle: `active` → `stale` (30d) → `archived` (90d) — never deletes, always archives
- Merges domain clusters via `claude-haiku` into umbrella `.md` skills
- `pinned: true` in frontmatter = never touched
- State persisted in `~/.agent-os/curator-state.json`
- Usage tracking in `~/.agent-os/skill-usage.json`

### 4B. FTS5 Session Search ✅ DONE
`packages/core/src/memory/fts5.ts`

- SQLite FTS5 virtual table (`messages_fts`) with auto-sync triggers on INSERT/UPDATE/DELETE
- `session_search` tool registered in engine — natural language queries across all history
- Haiku-powered summarisation of top-k matches
- `what did we work on last week?` now works across sessions

### 4C. User Profiling (USER.md) ✅ DONE
`packages/core/src/memory/user-model.ts`

- `~/.agent-os/USER.md` — `§`-delimited persistent user facts
- Injected as **frozen snapshot** at session start (prefix cache safe)
- Auto-extracts new facts after every response via Haiku (async, non-blocking)
- Deduplicates via SHA-256 content hash — never re-processes the same exchange
- `user_profile` tool registered: `read | add | replace | remove`

### 4D. Context Compression ✅ DONE
`packages/core/src/memory/context-compressor.ts`

- Triggers at 80% of model context limit
- Compresses oldest messages in batches of 3 via Gemini Flash Lite (cheapest)
- Last 6 messages always preserved verbatim
- Per-model limits: Claude (200k), Gemini (1M), Ollama (32k)
- Status chunk emitted to UI when compression fires

### 4E. Dream Journal ✅ DONE (Python engine improvement)
`packages/engine/src/engine/bg_learner.py` + `app.py`

After every `/dream` sleep cycle, generates a Markdown journal entry:
- Messages pruned vs retained
- Top interests with decay weights
- Tomorrow's predictions with confidence scores
- Any self-parameter updates applied
- Maturity progress toward next unlock

Stored in `dream_journal` SQLite table, exposed at `GET /dream/journal`.  
CLI: `/dream journal` — shows last 3 entries.

### 4F. Adult Web Search ✅ DONE (Python engine improvement)
`packages/engine/src/engine/bg_learner.py`

- ADULT+ (2000+ episodes) only — 1 search per week
- Fetches live web context for #1 predicted topic via Gemini + Google Search grounding
- Stored in `web_context` table, exposed at `GET /web-context`
- TypeScript engine can inject this as proactive context

### 4G. Extended Self-Updater ✅ DONE (Python engine improvement)
`packages/engine/src/engine/self_updater.py`

Added 3 new mutable parameters (all with constitution guards + audit trail):
| Param | Range | Default | Effect |
|---|---|---|---|
| `COOCCURRENCE_WINDOW_DAYS` | 1–30 | 14 | How many days of episodes feed the topic graph |
| `CONSOLIDATION_BATCH_SIZE` | 1–6 | 3 | Max LLM memory merges per consolidation run |
| `SELF_UPDATE_SENSITIVITY` | 0.5–3 | 1.0 | How aggressively metrics trigger self-updates |

---

## Phase 5 — Sensory Expansion ✅ DONE

| Feature | Tool | Backend |
|---|---|---|
| Vision (image analysis) | `analyze_image(path_or_url)` | Claude vision API |
| Screenshot | `browser_screenshot()` | Browser package |
| Voice input | `--voice` CLI flag | Whisper API / local |
| Voice output | Auto on voice mode | Edge TTS (free) / ElevenLabs |
| Image generation | `generate_image(prompt)` | DALL-E 3 / Flux / SD |

---

## Phase 6 — Skills Ecosystem ✅ DONE

### Skills Hub
`packages/core/src/skills/hub.ts`

Compatible with agentskills.io open standard (same frontmatter as Hermes Agent).
```bash
aos skills install productivity/daily-briefing
aos skills install github.com/user/my-skill
aos skills publish
aos skills search "devops"
```

### Skill Security Scanner
`packages/core/src/skills/guard.ts`

Scans for: prompt injection, data exfiltration, destructive commands, invisible unicode.
`dangerous` verdict blocks install — cannot be overridden.

### 100+ Bundled Skills
Categories: productivity, devops, github, data-science, research, creative, social-media, software-development, note-taking, smart-home, gaming, media, ml-ops, diagramming...

---

## Phase 7 — Model Agnosticism ✅ DONE

| Prefix | Routes to | Example |
|---|---|---|
| `cc:` | Claude (existing) | `cc: review this PR` |
| `g:` | Gemini (existing) | `g: summarise in bullets` |
| `or:` | OpenRouter (200+ models) | `or: gpt-4o compare these` |
| `ol:` | Ollama local | `ol:llama3.2 explain this` |
| (none) | Auto-route by cost/task | — |

OpenRouter pricing displayed per-model in StatusBar.
Auto mode gets cost-aware routing: cheap tasks → cheapest capable model.

---

## Phase 8 — IDE Bridge ✅ DONE

`packages/vscode/` — VS Code extension:
- Sidebar panel (conversation history)
- Inline suggestions (decoration API)
- `@file` mentions from active editor
- Bridge: WebSocket to `aos` on port 7878
- Compatible with Claude Code bridge protocol → works as fallback for CC's extension

---

## Agent-OS Unique Innovations

These are features neither Claude Code nor Hermes Agent has:

| Innovation | Description |
|---|---|
| **HAM v2** | 5-level compression + emotional context layer (tone/mood history) |
| **Cross-channel memory** | One SQLite DB — Discord message continues seamlessly in CLI |
| **Dream Journal** | `/dream` produces human-readable summary of what the agent learned |
| **Dual-process cognition** | System 1 (fast) / System 2 (deep) routing visible in UI |
| **Curiosity Engine v2** | Background learner proactively surfaces "you might want to know..." |
| **Self-healing** | Agent detects its own errors, files feedback, corrects without user input |

---

## Comparison Table

| Feature | Claude Code | Hermes Agent | **AgentOS** |
|---|---|---|---|
| Coding agent | ✅ | ⚠️ limited | ✅ |
| Persistent memory | ❌ (CLAUDE.md only) | ✅ | ✅ HAM + episodic + semantic |
| Browser automation | ❌ | ✅ | 🔜 Phase 2 |
| Self-improving skills | ❌ | ✅ | 🔜 Phase 4 |
| Multi-platform gateway | ❌ | ✅ 15 platforms | ✅ 7 platforms (Phase 3 done) |
| Cron/automation | ✅ basic | ✅ | 🔜 Phase 2 |
| Hooks system | ✅ | ❌ | ✅ Phase 1 done |
| Cost tracking | ✅ | ❌ | ✅ Phase 1 done |
| Settings hierarchy | ✅ | ✅ YAML | ✅ Phase 1 done |
| Session search | ❌ | ✅ FTS5 | ✅ FTS5 + LLM summary (Phase 4 done) |
| Voice I/O | ❌ | ✅ | ✅ Done |
| Image generation | ❌ | ✅ | ✅ Done |
| Subagent delegation | ✅ | ✅ | 🔜 Phase 2 |
| Model agnosticism | ❌ | ✅ 200+ | ✅ Done |
| IDE bridge (VS Code) | ✅ | ❌ | ✅ Done |
| Sleep-cycle learning | ❌ | ❌ | ✅ unique |
| Dual-process cognition | ❌ | ❌ | ✅ unique |
| Open source | ✅ | ✅ | ✅ |

---

## Install

```bash
npm install -g agent-os-core
aos
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Conventional commits (feat/fix/chore/docs).
Stack: Node 22, TypeScript 5.7 strict, ESM NodeNext, Turborepo.
