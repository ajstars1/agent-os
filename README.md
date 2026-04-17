# AgentOS

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?logo=node.js)](https://nodejs.org/)
[![npm](https://img.shields.io/badge/npm-10+-cb3837?logo=npm)](https://www.npmjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord)](https://discord.gg/agent-os)

**Open-source AI agent that learns from every conversation — 82% fewer tokens than naive full-context approaches.**

AgentOS is a self-hosted personal AI agent with a novel memory system (HAM) that compresses knowledge into 4 levels and loads only what each question needs. It runs on CLI, Discord, and a web API — all from the same engine. The agent gets smarter over time: when you ask something it doesn't know, it learns the answer automatically and stores it for future sessions.

---

<p align="center">
  <img src="assets/demo.gif" alt="AgentOS CLI demo" width="700" />
</p>

---

## Benchmark — HAM vs Naive Full Context

<p align="center">
  <img src="assets/benchmark.gif" alt="HAM token benchmark" width="700" />
</p>

| | Naive (full context) | AgentOS HAM |
|---|---|---|
| Tokens per conversation (8 turns) | ~6,825 | ~1,205 |
| Cost per 1,000 conversations (Claude Sonnet) | $20.47 | $3.61 |
| State detection latency | ~200ms (LLM call) | **0ms (regex)** |
| Vector DB required | Often yes | **No** |

Run it yourself: `npm run benchmark`

---

## Features

| Feature | Description |
|---|---|
| **HAM Memory** | 4-level compression (L0–L3) + L4 self-learning. Every unknown answer is stored automatically |
| **Multi-line input** | Alt+Enter inserts newlines in the CLI. Full multi-line editing with cursor navigation |
| **Permission system** | Edit, write, and bash tools require explicit approval. Allow once, Always allow, or Deny — with session cache |
| **`/feedback` command** | Leave feedback that is incorporated into agent behavior during the next sleep cycle |
| **`/config web` UI** | Browser-based config editor on localhost. Changes sync back to the terminal in real-time via SSE |
| **Smart LLM routing** | Claude by default. `cc:` prefix forces Claude, `g:` prefix forces Gemini. `auto` mode selects per message |
| **Gemini variants** | `gemini:flash`, `gemini:pro`, `gemini:flash-thinking`, `gemini:pro-thinking` — switchable mid-session |
| **Multi-channel** | CLI REPL, Discord bot, HTTP + SSE web API, Next.js dashboard — all share one engine |
| **MCP tools** | JSON-RPC 2.0 — connect any MCP-compatible server with zero custom code |
| **Built-in tools** | `web_fetch`, `bash` (sandboxed), `read_file`, `write_file` (path-jailed) |
| **Named agents** | Load agent profiles from `~/.agent-os/agents/*.json` |
| **Skills** | Hot-reload `.md` skill files, auto-ingest into HAM on startup |
| **`/dream` command** | Trigger the memory consolidation sleep cycle manually |
| **SQLite only** | WAL mode, no external DB — runs on a $5/month VPS |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Packages                                 │
│                                                                   │
│  shared  ──►  core  ──►  cli                                     │
│                    ──►  discord                                   │
│                    ──►  web                                       │
│                    ──►  ui  (Next.js dashboard)                  │
│                    ──►  engine  (Python sleep cycle)             │
└──────────────────────────────────────────────────────────────────┘

Build order: shared → core → cli / discord / web / ui / engine (parallel)

┌─────────────────────────────────────────────────────────┐
│                       Channels                           │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────────┐  │
│  │  CLI     │  │   Discord   │  │   Web (Hono SSE)   │  │
│  └────┬─────┘  └──────┬──────┘  └─────────┬──────────┘  │
└───────┼───────────────┼──────────────────┼──────────────┘
        │               │                  │
        └───────────────▼──────────────────┘
                 ┌───────────────┐
                 │  AgentEngine  │
                 └──────┬────────┘
          ┌─────────────┼──────────────┐
          │             │              │
   ┌──────▼──────┐ ┌────▼────┐ ┌──────▼──────┐
   │ LLM Router  │ │  Tools  │ │ HAM Memory  │
   │ cc: → Claude│ │ MCP +   │ │ L0/L1/L2/L3 │
   │ g:  → Gemini│ │ builtin │ │ + L4 auto   │
   └──────┬──────┘ └────┬────┘ └──────┬──────┘
          │             │              │
   ┌──────▼─────────────▼──────────────▼──────┐
   │              SQLite (WAL)                 │
   │  conversations · messages · knowledge     │
   └───────────────────────────────────────────┘
```

---

## HAM — Hierarchical Adaptive Memory

Traditional agents inject all knowledge into every prompt — expensive, slow, and unnecessary. HAM stores knowledge at 4 compression levels and uses a **zero-cost regex state machine** to decide what depth to load.

```
Question: "What is this?"      → INTRO state     → L1 (~35 tokens)
Question: "How does X work?"   → SOLUTION state  → L2 (~150 tokens)
Question: "Explain internals"  → DEEP_DIVE state → L3 (~500 tokens)
Unknown topic (no memory hit)  → L4: LLM answers → auto-saved to memory
```

**L0** (8 tokens) is always in context — a one-line headline per topic.  
**L1–L3** load on demand for the active topic only.  
**L4 self-learning:** unknown questions are answered by the LLM and the response is automatically compressed and stored as a new knowledge chunk.

```
❯ Who is Elon Musk?
Elon Musk is a billionaire entrepreneur and CEO of Tesla, SpaceX...

  ◆ learned "elon-musk" → saved to memory

  ─ claude · 312↑ 89↓ tokens
```

**Sleep cycle** — `/dream` triggers memory consolidation: pending feedback entries are read, the LLM distills behavioral changes, and updated knowledge chunks are written back to SQLite.

→ Full algorithm specification: [docs/ham-algorithm.md](docs/ham-algorithm.md)

---

## Quick Start

**Option 1 — curl (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/ajstars1/agent-os/main/install.sh | bash
```

The installer clones the repo, builds, wires up `aos` in your PATH, and prompts for your API key. Takes ~60 seconds. Then:

```bash
aos
```

**Option 2 — npm global:**

```bash
npm install -g agent-os
aos
```

**Option 3 — manual:**

```bash
git clone https://github.com/ajstars1/agent-os.git && cd agent-os
npm install && npm run build
node packages/cli/dist/index.js
```

**Updating:**

```bash
aos update        # pull + rebuild in one command
```

No Docker, no external database, no cloud services required. Anthropic key, Google key, or both — any one is enough to start.

---

## CLI Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/clear` | Clear conversation history |
| `/model <model>` | Switch model: `claude`, `gemini`, `auto`, `gemini:flash`, `gemini:pro`, `gemini:flash-thinking`, `gemini:pro-thinking` |
| `/config` | Show all config keys and current values |
| `/config set <KEY> <value>` | Update a key in `~/.agent-os/.env` with hot-reload |
| `/config path` | Print the config file path |
| `/config web` | Launch the browser-based config UI (default port 7877) |
| `/config web stop` | Shut down the config UI server |
| `/skills` | List loaded skill files |
| `/memory list` | Show all knowledge topics with L0 headlines |
| `/memory stats` | Show access counts and last-accessed dates |
| `/memory add <topic> <content>` | Compress and store a new knowledge chunk |
| `/feedback <text>` | Save feedback — applied during the next sleep cycle |
| `/feedback list` | Show saved feedback entries (applied and pending) |
| `/export [filename]` | Export conversation to a markdown file |
| `/cd <path>` | Change the agent's working directory |
| `/cwd` | Print the current working directory |
| `/dream` | Trigger memory consolidation sleep cycle |
| `/agents` | List loaded agent profiles |
| `/exit` | Quit |

**Per-message model override:**

```
cc: explain this algorithm    → always uses Claude (strips prefix)
g: summarise this document    → always uses Gemini (strips prefix)
```

---

## Running Each Channel

```bash
# Interactive CLI
npm run cli

# Discord bot
node packages/discord/dist/index.js

# Web API + SSE (port from WEB_PORT env, default 3000)
node packages/web/dist/index.js

# Web dashboard (requires web API running)
npm run dev:ui

# Python sleep-cycle engine
npm run dev:engine

# Token benchmark
npm run benchmark
```

---

## Web API

```bash
# Non-streaming
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello", "conversationId": "uuid"}'

# SSE streaming
curl -X POST http://localhost:3000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message": "explain HAM memory"}'

# List conversations
curl http://localhost:3000/conversations

# Memory chunks
curl http://localhost:3000/memory/chunks

# Health check
curl http://localhost:3000/health
```

---

## Configuration Reference

All config lives in `~/.agent-os/.env`. Edit with `/config set` or `/config web`, or directly in the file.

| Key | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | — | Claude API key |
| `GOOGLE_API_KEY` | Yes* | — | Gemini API key — also enables HAM compression and L4 learning |
| `DEFAULT_MODEL` | No | `claude` | `claude` \| `gemini` \| `auto` |
| `DB_PATH` | No | `~/.agent-os/memory.db` | SQLite database location |
| `SKILLS_DIR` | No | `~/.claude/skills` | Directory of `.md` skill files |
| `CLAUDE_MD_PATH` | No | — | Path to a system instructions file |
| `AGENTS_DIR` | No | — | Directory of `.json` agent profiles |
| `NEURAL_ENGINE_URL` | No | — | URL of the Python sleep-cycle backend |
| `WEB_PORT` | No | `3000` | Web API server port |
| `WEB_CORS_ORIGIN` | No | `*` | Allowed CORS origin for the web API |
| `ALLOWED_DIRS` | No | — | Colon-separated dirs for file tools (empty = cwd only) |
| `LOG_LEVEL` | No | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DISCORD_TOKEN` | No | — | Discord bot token |
| `DISCORD_CLIENT_ID` | No | — | Discord app client ID |
| `DISCORD_GUILD_ID` | No | — | Discord server ID for slash commands |
| `CONFIG_UI_PORT` | No | `7877` | Port for the `/config web` UI |

*At least one of `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY` is required.

---

## Package Overview

| Package | Language | Description |
|---|---|---|
| `packages/shared` | TypeScript | Types, config schema (Zod), logger |
| `packages/core` | TypeScript | AgentEngine, LLM clients, HAM memory, MCP tools, skill loader, feedback store |
| `packages/cli` | TypeScript | Terminal REPL — Ink-based UI, PromptInput, PermissionPrompt, commands |
| `packages/discord` | TypeScript | Discord bot adapter |
| `packages/web` | TypeScript | Hono HTTP + SSE web API |
| `packages/ui` | TypeScript | Next.js dashboard |
| `packages/engine` | Python | Sleep-cycle memory consolidation backend |

---

## HAM Deep Dive

→ [docs/ham-algorithm.md](docs/ham-algorithm.md) — full algorithm specification, SQLite schema, token budget examples, and state machine transition table.

## Architecture Deep Dive

→ [docs/architecture.md](docs/architecture.md) — monorepo structure, data flow, memory layers, tool registry, MCP integration.

## Getting Started

→ [docs/getting-started.md](docs/getting-started.md) — prerequisites, install, first run, first skill, first agent profile.

---

## Contributing

→ [CONTRIBUTING.md](CONTRIBUTING.md) — conventional commits, how to add a skill, how to add a tool, PR process.

```bash
npm test            # run all tests
npm run type-check  # type-check all packages
```

---

## License

[MIT](LICENSE) © 2025 Ayush Jamwal
