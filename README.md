# AgentOS

> **Looking for aos?** It moved to its own repo: **[ajstars1/aos](https://github.com/ajstars1/aos)**, the version
> anyone can use on Mac, Windows, Linux or a phone (a link you add to Claude or ChatGPT, nothing to install).
> Everything below is about the older terminal agent.

> **Archived (2026-10-06).** This terminal agent is no longer maintained and was never published to npm
> (`npm install -g agent-os-core` does not work). Its core idea, a short always-loaded index plus detail loaded on
> demand, now ships natively in Claude Code's auto memory. The code stays here as a reference; build it from source
> (below) to try it. Linux and macOS only.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Status: archived](https://img.shields.io/badge/status-archived-lightgrey.svg)](#)

### The AI agent that lives in your terminal — codes like Claude Code, remembers like a human, and gets smarter while you sleep.

---

## Why AgentOS?

Every other AI tool forgets you the moment you close the tab.

AgentOS doesn't.

It runs **on your machine**, remembers **every conversation**, learns **in the background**, and ships with a coding agent that's as capable as the best closed-source tools — without sending your code to anyone.

```
❯ fix the failing auth test

  ⌕ grep  "auth.*test"  →  3 files
  ◎ read  src/auth/__tests__/login.test.ts
  ◎ read  src/auth/login.ts
  ✎ edit  login.ts — handle the missing session.user case
  ❯ bash  npm test src/auth
  ✓ 4/4 passing

Done. The session was undefined when the cookie was missing — added a guard
and a return before the redirect call.

  ─ claude  1,840↑ 412↓  2.8s
```

That's a real run. No mocks, no fake demos. This is what every interaction looks like.

---

## What it can actually do

### 🧠 Codes like Claude Code
A full coding agent in your terminal. It reads files, makes precise edits, runs commands, and shows you everything it does. No diffs to copy-paste. No "here's what you should do" — it just does it.

### 🫀 Memory that works like a human brain
Four layers of memory, each modeled on how human cognition actually works:

- **Episodic memory** — "you were debugging Supabase auth on Apr 15, you got frustrated, then you shipped it" — with **10-day decay half-life** so yesterday feels vivid and last month is a faint echo
- **Semantic memory** — a Subject-Predicate-Object knowledge graph of permanent facts about you, your projects, your stack
- **Profile memory** — a living relationship document, deep-merged after every chat: name, role, communication style, current projects, what frustrates you
- **HAM (Hierarchical Adaptive Memory)** — 4 compression levels (L0–L3) with a zero-cost regex state machine that loads only the depth your question needs. **82% fewer tokens than naive full-context.**

### 🌙 Background self-learning (the Jarvis quality)
A Python learner runs in the background, watching what topics matter to you. By the time you open a chat tomorrow, the relevant context is **already pre-loaded**. It guesses what you'll need before you ask.

### 💤 Self-improves from your feedback
Tell it once: `/feedback you keep giving me React advice — I work in Vue`

When you next run `/dream`, the sleep cycle:
1. Reads all pending feedback
2. Distills behavioral changes via LLM
3. Writes the changes back into its own behavior

Next morning, the bias is gone. Permanently. **The agent literally rewrites how it thinks about you.**

### 🔮 Dual-process cognition (System 1 vs System 2)
Routine questions get System 1 — fast, cheap, instant. High-surprise inputs trip a neural threshold and escalate to System 2 — slow, deliberative, step-by-step reasoning. **The same architecture Kahneman wrote a book about.**

### 🌐 Centralized memory across every channel
CLI, Discord bot, Web API — all three pull from **one SQLite database**. Ask a question on Discord, then continue in your terminal. It remembers.

### ⚡ `aos ask` — drop-in terminal Q&A
```bash
aos ask "how do I check ubuntu version?"
aos ask --claude "explain closures in JS"
aos ask --agents "research and build me a Tailwind plugin for X"
```

One-shot mode. Pipe it. Script it. Run it from anywhere.

### 🤖 Multi-LLM, switchable mid-sentence
```
cc: review this PR for security issues   → forces Claude
g:  summarise this document in bullets   → forces Gemini (Flash)
```

Or set `auto` and let AgentOS pick the right model per message. Works with **Claude Sonnet, Gemini Pro, Gemini Flash, Gemini Thinking models** — switch on the fly.

### 🧰 Connect any MCP server
JSON-RPC 2.0 out of the box. Drop in any MCP-compatible tool — GitHub, Linear, Notion, your custom internal API — and AgentOS picks them up. Zero glue code.

### 🎭 Skills + Agent Profiles
Drop a `.md` file in `~/.agent-os/skills/` → it's now a `/slash-command`.
Drop a `.json` file in `~/.agent-os/agents/` → start it with `aos --agent <name>`.

Hot-reload. No restart. No config file gymnastics.

### 🔒 Permission system
Every file write, every shell command requires explicit approval. **Allow once, Remember this exact request, Always allow the tool, or Deny.** Session-cached. You stay in control.

### 🪶 Runs on a $5 VPS
SQLite + WAL mode. No Docker. No Postgres. No Redis. No vector database. No cloud bill.

---

## Memory benchmark — proof, not vibes

```bash
npm run benchmark
```

Runs 10 simulated conversations and prints token usage side-by-side:

| | Naive (full context) | AgentOS HAM |
|---|---|---|
| Tokens per conversation (8 turns) | ~6,825 | **~1,205** |
| Cost per 1,000 conversations (Claude Sonnet) | $20.47 | **$3.61** |
| State detection latency | ~200ms (LLM call) | **0ms (regex)** |
| Vector DB required | Often yes | **No** |

**5.6× cheaper. 200ms faster per question. Same quality.**

<p align="center">
  <img src="assets/benchmark.gif" alt="HAM token benchmark" width="700" />
</p>

---

## Install (from source)

There is no npm package. Build it from this repo (Node.js 22, Linux or macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/ajstars1/agent-os/main/install.sh | bash
aos
```

On first run, `aos` walks you through entering your API key (Claude or Gemini — either one is enough) and saves it to `~/.agent-os/.env`.

---

## A taste of the commands

```
/help                    Show all commands
/model claude            Switch to Claude
/model gemini:pro        Switch to Gemini Pro
/memory list             Browse what AgentOS remembers about you
/memory add <topic>      Teach it something new
/feedback <text>         Improve future behavior — applied next /dream
/dream                   Trigger sleep-cycle memory consolidation
/skills                  List loaded skills
/agents                  List loaded agent profiles
/plan <task>             Enter Planning Mode for complex multi-step work
/config web              Launch browser-based config UI
/export                  Export this conversation to markdown
/cd <path>               Change agent working directory
/exit                    Quit
```

Plus per-message overrides:
```
cc: <message>            Force Claude for this message
g:  <message>            Force Gemini for this message
```

---

## Multi-channel from day one

Same engine. Same memory. Three doorways.

```bash
aos                                              # CLI REPL
aos ask "your question"                          # one-shot terminal
node packages/discord/dist/index.js              # Discord bot
node packages/web/dist/index.js                  # HTTP + SSE web API
```

```bash
# Hit it from anywhere
curl -X POST http://localhost:3000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message": "what was I working on yesterday?"}'
```

---

## Built for builders

**Stack:** Node 22 · TypeScript 5.7 strict · ESM · Turborepo monorepo · SQLite (WAL) · Python (background learner)

**Packages:**

| | |
|---|---|
| `@agent-os-core/shared` | Types, Zod config, logger |
| `@agent-os-core/core` | Engine, LLM clients, HAM, semantic graph, MCP, skills |
| `@agent-os-core/cli` | Terminal REPL — Ink UI, permission prompts |
| `@agent-os-core/discord` | Discord bot adapter |
| `@agent-os-core/web` | Hono HTTP + SSE API |

Want the deep dive? → [docs/architecture.md](docs/architecture.md) · [docs/ham-algorithm.md](docs/ham-algorithm.md) · [docs/getting-started.md](docs/getting-started.md)

---

## Roadmap

- [ ] VSCode extension
- [ ] Local model support via Ollama
- [ ] Agent-to-agent task delegation
- [ ] Conversation branching (`/branch`, `/checkout`)
- [ ] Web dashboard for memory browser

---

## Contributing

PRs welcome. Conventional Commits. Read [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/ajstars1/agent-os.git
cd agent-os && npm install && npm run build
npm test
```

---

## License

[MIT](LICENSE) © 2025 Ayush Jamwal

---

<p align="center">
  <strong>Stop renting your memory from a chatbot. Run your own.</strong><br>
  <a href="https://github.com/ajstars1/agent-os">GitHub</a>
</p>
