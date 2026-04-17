# Contributing to AgentOS

Pull requests are welcome. This document covers the conventions, package layout, and the two most common contribution types: adding a skill and adding a built-in tool.

---

## Commit format

AgentOS uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add /export command
fix: correct cursor position in multi-line PromptInput
chore: bump turbo to 2.4
docs: document HAM L4 self-learning flow
refactor: extract readEnvFile into shared util
test: add FeedbackStore.markApplied coverage
```

Scope is optional but helpful:

```
feat(cli): multi-line input with Alt+Enter
fix(core): prevent duplicate L4 writes on concurrent requests
```

Rules:
- Present tense, imperative mood ("add" not "added")
- No capital first letter after the colon
- Breaking changes: append `!` after type — `feat!: change DB schema`
- Keep the subject line under 72 characters

---

## Development setup

```bash
git clone https://github.com/ajstars1/agent-os.git
cd agent-os
npm install
cp .env.example .env
# Edit .env — add at least ANTHROPIC_API_KEY
npm run build
npm run cli          # verify it runs
```

### Type checking and tests

```bash
npm run type-check   # zero errors required before any PR
npm test             # run all package tests
```

### Per-package dev mode

```bash
# Watch-mode builds (Turborepo handles dependency order)
npx turbo run dev --filter=@agent-os/cli
npx turbo run dev --filter=@agent-os/core
```

---

## Package structure

```
packages/
  shared/   — types, config schema (Zod), logger. No dependencies on other packages.
  core/     — AgentEngine, LLM clients (Claude + Gemini), HAM memory, MCP client,
              skill loader, feedback store. Depends on: shared.
  cli/      — Terminal REPL (Ink). PromptInput, PermissionPrompt, command handlers.
              Depends on: shared, core.
  discord/  — Discord bot adapter. Depends on: shared, core.
  web/      — Hono HTTP + SSE web API. Depends on: shared, core.
  ui/       — Next.js dashboard. Depends on: shared.
  engine/   — Python sleep-cycle / memory consolidation backend.
```

**Build order enforced by Turborepo:** `shared → core → cli / discord / web / ui` (parallel).

All TypeScript packages use NodeNext module resolution. Every import within the repo must include the `.js` extension, even for `.ts` source files.

---

## Code rules

- No `any` types. Use `unknown` and narrow with type guards.
- Named exports everywhere. No default exports except Next.js pages.
- No `console.log`. Use the pino logger from `@agent-os/shared`.
- Zod validation on all external inputs (API request bodies, config, tool inputs).
- `try/catch` with typed error handling on all async operations.
- Database: transactions for multi-table writes (`prisma.$transaction` or `db.transaction()`).
- Soft delete only — never hard-delete rows.

---

## How to add a skill

Skills are Markdown files that are loaded as system context. They require no code changes.

1. Create `~/.claude/skills/my-skill.md` (or wherever `SKILLS_DIR` points):

```markdown
# Skill: My Topic

This skill teaches the agent about my topic.

Key facts:
- Fact one
- Fact two
```

2. Restart the CLI or wait for hot-reload. The skill appears in `/skills`.

3. To ship a skill with the repo, add it to `packages/core/src/skills/` — the skill loader picks up any `.md` files in that directory.

The skill content is compressed via HAM (Gemini Flash) on first load and cached. Subsequent loads are instant.

---

## How to add a built-in tool

Built-in tools live in `packages/core/src/tools/`. Each tool is a TypeScript module that exports a `ToolDefinition` and an executor function.

### 1. Define the tool

```typescript
// packages/core/src/tools/my-tool.ts
import type { ToolDefinition } from '@agent-os/shared';

export const myToolDefinition: ToolDefinition = {
  name: 'my_tool',
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'Input value' },
    },
    required: ['value'],
  },
};

export async function runMyTool(input: Record<string, unknown>): Promise<string> {
  const value = String(input['value'] ?? '');
  // ... implementation
  return result;
}
```

### 2. Register the tool

In `packages/core/src/tools/index.ts`, add your tool to the registry:

```typescript
import { myToolDefinition, runMyTool } from './my-tool.js';

export const toolRegistry = {
  // ... existing tools
  my_tool: { definition: myToolDefinition, run: runMyTool },
};
```

### 3. Handle permissions (if the tool is destructive)

If your tool writes files, executes code, or has side effects, it should go through the permission system. In the tool executor, emit a `permission_request` stream chunk before executing. The CLI's `PermissionPrompt` will intercept it and ask the user for `allow`, `always`, or `deny`.

See `packages/core/src/tools/bash.ts` and `packages/core/src/tools/write-file.ts` for examples.

### 4. Write a test

```typescript
// packages/core/src/__tests__/tools/my-tool.test.ts
import { describe, it, expect } from 'vitest';
import { runMyTool } from '../../tools/my-tool.js';

describe('my_tool', () => {
  it('should return expected output', async () => {
    const result = await runMyTool({ value: 'test' });
    expect(result).toContain('expected');
  });
});
```

---

## How to add a CLI command

Commands live in `packages/cli/src/commands/index.ts` in the `commands` record.

```typescript
// Add to the commands record:
mycommand: (args, ctx) => {
  const input = args.trim();
  if (!input) return 'Usage: /mycommand <arg>';
  // ... logic using ctx.engine, ctx.hamStore, etc.
  return `Result: ${input}`;
},
```

Also add a line to the `HELP_TEXT` string at the top of the file.

---

## Pull request process

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes. Run type-check and tests locally before pushing:
   ```bash
   npm run type-check
   npm test
   ```

3. Push and open a PR against `main`. In the PR description include:
   - **What** — what does this PR change?
   - **Why** — what problem does it solve?
   - **Testing** — how did you test it?

4. PRs require at least one review before merge.

5. Squash-merge is preferred for small PRs. Merge commits are used for larger feature branches.

---

## Reporting bugs

Open a GitHub issue with:
- AgentOS version (`aos --version`)
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant output or error messages
