# AgentOS

Personal open-source AI agent system — TypeScript/Node.js Turborepo monorepo.

## Stack
- Node.js 22, TypeScript 5.7 strict, ESM (NodeNext)
- Turborepo monorepo with 4 packages: shared, core, cli, discord
- better-sqlite3 for memory, pino for logging, Zod for config validation
- Claude (Anthropic) + Gemini (Google) as LLM backends

## Code Rules
- All imports must include `.js` extension (NodeNext resolution)
- No `any` types. No default exports (except pages). No `console.log`.
- Named exports everywhere.
- Zod validation on all external inputs.
- Try/catch with typed errors on all async operations.

## Package Structure
- `packages/shared` — types, config, logger
- `packages/core` — engine, LLM clients, memory, MCP tools, skills
- `packages/cli` — terminal REPL adapter
- `packages/discord` — Discord bot adapter

## Build Order
shared → core → cli / discord (parallel)
