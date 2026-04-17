# Architecture

This document describes the AgentOS monorepo structure, data flow through the system, and how each subsystem works.

---

## Monorepo layout

```
agent-os/
├── packages/
│   ├── shared/       TypeScript — types, config, logger
│   ├── core/         TypeScript — engine, memory, LLM clients, tools
│   ├── cli/          TypeScript — terminal REPL (Ink)
│   ├── discord/      TypeScript — Discord bot adapter
│   ├── web/          TypeScript — Hono HTTP + SSE web API
│   ├── ui/           TypeScript — Next.js dashboard
│   └── engine/       Python     — sleep-cycle memory consolidation
├── docs/
├── scripts/          build utilities, seed-memory, benchmark
├── install.sh
├── turbo.json
└── package.json      (npm workspaces)
```

Build order is enforced by Turborepo:

```
shared → core → cli, discord, web, ui   (parallel)
                engine                  (independent, Python)
```

All TypeScript packages use `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`. Every import requires an explicit `.js` extension, even for `.ts` source files.

---

## Package responsibilities

### `packages/shared`

The dependency foundation — nothing in `shared` imports from other AgentOS packages.

- `src/types/index.ts` — core type definitions: `Message`, `Conversation`, `AgentConfig`, `ToolCall`, `ToolResult`, `StreamChunk`, `PermissionDecision`, `Config`, `LLMProvider`, `ChannelType`
- `src/config.ts` — Zod schema for the `Config` type, `.env` loading, validation
- `src/logger.ts` — pino logger instance

### `packages/core`

The engine that all channel packages depend on.

- `AgentEngine` — orchestrates LLM calls, tool execution, memory retrieval, streaming
- `LLM clients` — separate Claude (Anthropic SDK) and Gemini (Google Generative AI) clients. Auto-routing logic lives here.
- `HAM memory` — `TieredStore` (SQLite), `HAMCompressor` (Gemini Flash), `HAMRetriever` (topic detection + depth selection)
- `SkillLoader` — reads `.md` files from `SKILLS_DIR`, compresses via HAM, hot-reloads on file change
- `AgentLoader` — reads `.json` profiles from `AGENTS_DIR`
- `MCP client` — JSON-RPC 2.0 client for connecting external MCP servers
- `Tool registry` — built-in tools: `web_fetch`, `bash`, `read_file`, `write_file`
- `FeedbackStore` — SQLite-backed store for `/feedback` entries and sleep-cycle consumption

### `packages/cli`

Terminal REPL built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

- `PromptInput` — multi-line input, command suggestions, paste truncation, @-file mentions
- `PermissionPrompt` — interactive tool permission gate
- `commands/index.ts` — all `/command` handlers
- `config-server.ts` — local HTTP server for `/config web`
- `index.ts` — entry point, CLI argument parsing (`--model`, `--agent`), session bootstrap

### `packages/discord`

Discord bot using discord.js. Maps Discord message events to `AgentEngine.chat()` calls. Streaming chunks are buffered and sent as message edits.

### `packages/web`

Hono-based HTTP server. Two routes:
- `POST /chat` — synchronous response
- `POST /chat/stream` — SSE streaming (text/event-stream)

Plus: `GET /conversations`, `GET /memory/chunks`, `GET /health`.

### `packages/ui`

Next.js 14 App Router dashboard. Connects to the web API for conversation history and real-time streaming.

### `packages/engine`

Python (Poetry) sleep-cycle backend. Consumes pending feedback entries, runs memory consolidation with a local or remote LLM, writes updated knowledge chunks back to the SQLite database. Exposed as an HTTP server that `AgentEngine.startSleepCycle()` calls when `NEURAL_ENGINE_URL` is set.

---

## Request data flow

```
User input
    │
    ▼
PromptInput  (CLI) / Discord message / HTTP POST
    │
    ▼
isCommand(input)?
  Yes → handleCommand(input, ctx)   →  command output
  No  →
    │
    ▼
AgentEngine.chat(conversationId, message, model, permissionCallback)
    │
    ├── HAMRetriever.detectTopic(message)
    │       └── keyword + tag match against knowledge_chunks
    │
    ├── StateRouter.transition(message)
    │       └── zero-cost regex → ConversationState
    │
    ├── HAMRetriever.assembleMemory(topic, depth)
    │       ├── getAllL0()           → headline index (~80 tokens, always)
    │       └── getAtDepth(topic)   → expanded content (only if topic matched)
    │
    ├── SkillLoader.getSystemContext()
    │       └── loaded skill files as system context
    │
    ├── LLMRouter.route(message, model)
    │       ├── "cc:" prefix → Claude
    │       ├── "g:" prefix  → Gemini
    │       ├── "auto"       → Gemini Flash classifies, routes accordingly
    │       └── default      → Claude
    │
    ├── LLM.stream(messages, systemPrompt)
    │       └── yields StreamChunk[]
    │
    ├── For each tool_call chunk:
    │       ├── permission_request? → yield to CLI, await decision
    │       ├── allow/always        → execute tool, yield tool_result
    │       └── deny                → yield error tool_result
    │
    ├── Unknown topic? (L4 path)
    │       └── HAMCompressor.compressChunk(response) → store new knowledge_chunk
    │
    └── updateAccessStats(usedChunkIds)
```

---

## Memory subsystem

See [ham-algorithm.md](ham-algorithm.md) for full detail.

**SQLite tables:**

```sql
-- Primary knowledge store
knowledge_chunks (id, topic, l0, l1, l2, l3, tags, last_accessed, access_count)

-- Compression cache — avoids re-compressing unchanged skill files
compression_cache (content_hash, l0, l1, l2, created_at)

-- Conversation history
conversations (id, channel, channel_id, created_at, updated_at)
messages      (id, conversation_id, role, content, model, tokens, created_at)

-- Feedback for sleep cycle
feedback (id, timestamp, context, text, applied)
```

Both `memory.db` and `feedback.db` run in WAL mode for concurrent read performance.

---

## Tool registry

Built-in tools are registered in `packages/core/src/tools/`. Each tool exports a `ToolDefinition` (name, description, JSON Schema for inputs) and an executor function.

The engine passes tool definitions to the LLM as part of the system prompt. When the LLM emits a `tool_use` content block, the engine looks up the executor by name and runs it.

MCP tools are discovered from connected MCP servers via JSON-RPC `tools/list` and registered alongside built-in tools. MCP tool calls are proxied back to the server via `tools/call`.

---

## LLM routing

```
Input prefix "cc:" → strip prefix → Claude (always)
Input prefix "g:"  → strip prefix → Gemini (always)

model = "auto":
  → Gemini Flash: "classify this message: reasoning or large-context?"
  → "reasoning" → Claude
  → "large-context" → Gemini

model = "gemini:flash-thinking":
  → Gemini Flash with thinking budget 8k tokens

model = "gemini:pro-thinking":
  → Gemini 2.5 Pro with thinking budget 16k tokens
```

All routing logic lives in `packages/core/src/llm/router.ts`.

---

## Permission system

When a tool executor determines that user approval is needed, it does not execute. Instead, the engine yields a `StreamChunk` of type `permission_request` containing:

```typescript
{
  toolName: string;
  input: Record<string, unknown>;
  preview: string;   // diff-style text shown to the user
}
```

The CLI intercepts this chunk and renders `PermissionPrompt`. The engine awaits the `PermissionCallback` promise. When the user decides, the callback resolves with `'allow' | 'always' | 'deny'` and execution continues or is cancelled.

`always` decisions are stored in a `Set<string>` on the engine instance for the session lifetime.

---

## Config server (for `/config web`)

`packages/cli/src/config-server.ts` starts a plain Node.js `http.createServer` on localhost. It serves:

- `GET /` — HTML config UI (inline CSS + JS, no external dependencies)
- `GET /config` — current `.env` as JSON
- `POST /save` — write updates to `.env`, hot-reload into `process.env`, broadcast via SSE
- `GET /events` — SSE endpoint; also watches `.env` with `fs.watchFile` for external changes

At most one config server runs per CLI session. `/config web stop` calls `server.close()` and clears the SSE client set.
