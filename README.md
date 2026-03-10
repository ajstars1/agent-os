# AgentOS

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ajstars1/agent-os?style=social)](https://github.com/ajstars1/agent-os)

**Open-source AI agent with human-like memory, multi-channel access, and smart LLM routing.**

AgentOS is a personal AI agent that runs everywhere — terminal, Discord, web API — with a novel memory system (HAM) that keeps context lean and responses sharp without burning tokens.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Channels                          │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────────┐ │
│  │  CLI     │  │   Discord   │  │   Web (Hono SSE)   │ │
│  └────┬─────┘  └──────┬──────┘  └─────────┬──────────┘ │
└───────┼───────────────┼──────────────────┼─────────────┘
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
   │ g:  → Gemini│ │ builtin │ │ StateRouter │
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
git clone https://github.com/ajstars/agent-os.git
cd agent-os
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY at minimum

# 3. Build
npm run build

# 4. Run CLI
node packages/cli/dist/index.js

# 5. Run Discord bot
node packages/discord/dist/index.js

# 6. Run Web API (port 3000)
node packages/web/dist/index.js
```

---

## Features

| Feature | Description |
|---|---|
| **HAM Memory** | Hierarchical Adaptive Memory — 4-level compression, state-aware retrieval |
| **Smart routing** | `cc:` prefix → Claude, `g:` prefix → Gemini, `auto` classifies per message |
| **Multi-channel** | CLI REPL, Discord bot, HTTP + SSE web API |
| **MCP tools** | JSON-RPC 2.0 tool protocol — connect any MCP server |
| **Built-in tools** | `web_fetch`, `bash`, `read_file`, `write_file` |
| **Named agents** | Load agent profiles from `~/.agent-os/agents/*.json` |
| **Skills** | Hot-reload `.md` skill files, auto-ingest into HAM |

---

## HAM Memory

Traditional agents stuff all context into every prompt — expensive and slow.
HAM loads only what's needed, at the depth needed.

```
User asks "what is this?" → INTRO state → L1 depth (~35 tokens per topic)
User asks "tell me more"  → DEEP_DIVE  → L3 depth (~500 tokens, active topic only)
User asks "how much?"     → CTA state  → L1 depth (brief, action-focused)
```

→ See [docs/ham-algorithm.md](docs/ham-algorithm.md) for full explanation.

---

## CLI Commands

```
/help                        Show all commands
/clear                       Clear conversation history
/model <claude|gemini|auto>  Switch LLM
/skills                      List loaded skills
/memory list                 Show knowledge base topics
/memory stats                Token usage and access patterns
/memory add <topic> <text>   Add and compress knowledge
/exit                        Quit
```

---

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Gemini (enables auto-routing + HAM compression)
GOOGLE_API_KEY=AIza...

# Discord adapter
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=

# Storage
DB_PATH=~/.agent-os/memory.db

# Skills
SKILLS_DIR=~/.claude/skills
CLAUDE_MD_PATH=./CLAUDE.md

# Web server
WEB_PORT=3000
WEB_CORS_ORIGIN=*
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
  -d '{"message": "explain HAM", "model": "claude"}'

# Clear conversation
curl -X DELETE http://localhost:3000/conversations/<id>

# Health
curl http://localhost:3000/health
```

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit: `git commit -m "feat: my feature"`
4. Push and open a PR — include **What** and **Why** in the description

Code rules: TypeScript strict, no `any`, named exports, Zod on all inputs, pino for logging.
Run tests: `npm test`

---

## License

[MIT](LICENSE) © 2025 Ayush Jamwal
