# AgentOS

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ajstars1/agent-os?style=social)](https://github.com/ajstars1/agent-os)

**Open-source AI agent that learns from every conversation — 82% fewer tokens than LangChain.**

AgentOS is a self-hosted personal AI agent with a novel memory system (HAM) that compresses knowledge into 4 levels and loads only what each question needs. It runs on CLI, Discord, and a web API — all from the same engine. And it gets smarter over time: when you ask something it doesn't know, it learns the answer automatically.

---

## Demo

<p align="center">
  <img src="assets/demo.gif" alt="AgentOS CLI demo" width="700" />
</p>

---

## Benchmark — HAM vs Naive Full Context

<p align="center">
  <img src="assets/benchmark.gif" alt="HAM token benchmark" width="700" />
</p>

| | Naive (LangChain-style) | AgentOS HAM |
|---|---|---|
| Tokens per conversation (8 turns) | ~6,825 | ~1,205 |
| Cost per 1000 conversations (Claude Sonnet) | $20.47 | $3.61 |
| State detection latency | ~200ms (LLM call) | **0ms (regex)** |
| Vector DB required | Often yes | **No** |

Run it yourself: `npm run benchmark`

---

## How It Works

### HAM — Hierarchical Adaptive Memory

Traditional agents dump all context into every prompt — expensive, slow, and unnecessary.
HAM stores knowledge at 4 compression levels and uses a **zero-cost regex state machine** to decide what depth to load.

```
Question: "What is this?"      → INTRO state     → L1 (~35 tokens)
Question: "How does X work?"   → SOLUTION state  → L2 (~150 tokens)
Question: "Explain internals"  → DEEP_DIVE state → L3 (~500 tokens)
Unknown topic (no memory hit)  → L4: LLM answers → auto-saved to memory
```

**L4 Self-Learning:** When you ask something not in memory, AgentOS answers from the LLM's knowledge and automatically compresses + stores the response as a new knowledge chunk. The agent gets smarter with every conversation.

```
❯ Who is Elon Musk?
Elon Musk is a billionaire entrepreneur and CEO of Tesla, SpaceX...

  ◆ learned "elon-musk" → saved to memory

  ─ claude · 312↑ 89↓ tokens
```

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Channels                          │
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

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/ajstars1/agent-os.git
cd agent-os
npm install

# 2. Configure
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY (Claude) and/or GOOGLE_API_KEY (Gemini)

# 3. Build
npm run build

# 4. Seed default knowledge (optional but recommended)
npm run seed-memory

# 5. Run the CLI
npm run cli
```

That's it. No Docker, no external database, no cloud services required.

---

## Features

| Feature | Description |
|---|---|
| **HAM Memory** | 4-level compression (L0–L3) + L4 self-learning from every conversation |
| **Smart routing** | Claude by default · `cc:` / `g:` prefixes for per-message override |
| **Auto-routing** | In `auto` mode, Gemini Flash classifies: Claude for reasoning, Gemini for large-context |
| **Multi-channel** | CLI REPL, Discord bot, HTTP + SSE web API, Next.js dashboard |
| **MCP tools** | JSON-RPC 2.0 — connect any MCP server with zero custom code |
| **Built-in tools** | `web_fetch`, `bash` (sandboxed), `read_file`, `write_file` (path-jailed) |
| **Named agents** | Load agent profiles from `~/.agent-os/agents/*.json` |
| **Skills** | Hot-reload `.md` skill files, auto-ingest into HAM on startup |
| **SQLite only** | WAL mode, no external DB — runs on a $5/mo VPS |

---

## CLI Commands

```
/help                        Show all commands
/clear                       Clear conversation history
/model <claude|gemini|auto>  Switch LLM for this session
/skills                      List loaded skill files
/memory list                 Show all knowledge topics with L0 headlines
/memory stats                Token usage and access patterns
/memory add <topic> <text>   Manually compress and store knowledge
/exit                        Quit
```

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

# Web API + SSE (port 3000)
node packages/web/dist/index.js

# Web dashboard (port 3002, requires web API running)
npm run dev:ui

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

# Health
curl http://localhost:3000/health
```

---

## Environment Variables

```bash
# Required (at least one)
ANTHROPIC_API_KEY=sk-ant-...    # Claude — default model for reasoning
GOOGLE_API_KEY=AIza...          # Gemini — enables auto-routing + HAM compression + L4

# LLM routing: claude (default) | gemini | auto
DEFAULT_MODEL=claude

# Storage
DB_PATH=~/.agent-os/memory.db

# Skills (loaded as system context, hot-reloaded)
SKILLS_DIR=~/.claude/skills

# Discord adapter
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_ALLOWED_CHANNELS=

# Web server
WEB_PORT=3000
WEB_CORS_ORIGIN=*

# File tool access (empty = unrestricted)
ALLOWED_DIRS=
```

---

## HAM Deep Dive

→ See [docs/ham-algorithm.md](docs/ham-algorithm.md) for the full algorithm specification, SQLite schema, token budget examples, and the state machine transition table.

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit with conventional format: `git commit -m "feat: my feature"`
4. Push and open a PR — include **What** and **Why** in the description

Code rules: TypeScript strict, no `any`, named exports, Zod on all inputs, pino for logging.

```bash
npm test          # run all tests
npm run type-check  # type check all packages
```

---

## License

[MIT](LICENSE) © 2025 Ayush Jamwal
