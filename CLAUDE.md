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
- `packages/shared` — types, config, logger, pricing, settings hierarchy
- `packages/core` — engine, LLM clients, memory, MCP tools, skills, hooks, subagents
- `packages/cli` — terminal REPL adapter (`aos`)
- `packages/gateway` — multi-platform messaging daemon (`aos-gateway`): Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email
- `packages/browser` — Playwright browser automation (local + Browser Use cloud)
- `packages/cron` — cron scheduler with SQLite persistence and platform delivery
- `packages/discord` — legacy Discord-only adapter (superseded by gateway)

## Build Order
shared → core → [cli, gateway, browser, cron, discord, web] (parallel)
