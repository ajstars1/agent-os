/**
 * Bridge routes — REST+SSE endpoints for the VS Code extension.
 *
 * All routes require Authorization: Bearer <bridge-secret>.
 *
 * GET  /bridge/status          → health check + metadata
 * GET  /bridge/context         → last IDE file context pushed by extension
 * POST /bridge/context         → extension pushes current file/selection
 * POST /bridge/chat            → collect (non-streaming) chat
 * POST /bridge/stream          → SSE streaming chat
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEngine } from '@agent-os-core/core';
import type { LLMProvider } from '@agent-os-core/shared';
import { bridgeAuth } from '../middleware/bridgeAuth.js';
import { secretFilePath } from '../bridge-secret.js';

// ─── IDE context store (in-memory, last push wins) ───────────────────────────

interface IDEContext {
  file?: string;
  language?: string;
  selection?: string;
  visibleRange?: string;
  workspaceRoot?: string;
  pushedAt: number;
}

let _ideContext: IDEContext = { pushedAt: 0 };

const ContextSchema = z.object({
  file: z.string().optional(),
  language: z.string().optional(),
  selection: z.string().optional(),
  visibleRange: z.string().optional(),
  workspaceRoot: z.string().optional(),
});

const ChatSchema = z.object({
  message: z.string().min(1).max(32_000),
  conversationId: z.string().optional(),
  model: z.string().optional(),
  includeFileContext: z.boolean().default(true),
});

// ─── Build augmented message with file context ────────────────────────────────

function augmentWithContext(message: string, ctx: IDEContext, include: boolean): string {
  if (!include || !ctx.file || Date.now() - ctx.pushedAt > 60_000) return message;

  const parts: string[] = [];
  parts.push(`[IDE Context]`);
  parts.push(`File: ${ctx.file}${ctx.language ? ` (${ctx.language})` : ''}`);
  if (ctx.visibleRange) parts.push(`Visible: ${ctx.visibleRange}`);
  if (ctx.selection) parts.push(`Selected code:\n\`\`\`\n${ctx.selection.slice(0, 2000)}\n\`\`\``);
  parts.push(`[User message]\n${message}`);

  return parts.join('\n');
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function bridgeRoute(engine: AgentEngine): Hono {
  const app = new Hono();
  app.use('*', bridgeAuth());

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/status', (c) => {
    return c.json({
      ok: true,
      version: '0.1.0',
      cwd: process.cwd(),
      secretFile: secretFilePath(),
      ideContext: _ideContext.file ? {
        file: _ideContext.file,
        language: _ideContext.language,
        hasSelection: !!_ideContext.selection,
        ageMs: Date.now() - _ideContext.pushedAt,
      } : null,
    });
  });

  // ── IDE context push ────────────────────────────────────────────────────────
  app.post('/context', async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const parsed = ContextSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    _ideContext = { ...parsed.data, pushedAt: Date.now() };
    return c.json({ ok: true });
  });

  // ── IDE context fetch ───────────────────────────────────────────────────────
  app.get('/context', (c) => {
    return c.json(_ideContext);
  });

  // ── Non-streaming chat ──────────────────────────────────────────────────────
  app.post('/chat', async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const parsed = ChatSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const { message, conversationId, model, includeFileContext } = parsed.data;
    const convId = conversationId ?? randomUUID();
    const augmented = augmentWithContext(message, _ideContext, includeFileContext);

    let fullText = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const chunk of engine.chat({
        conversationId: convId,
        message: augmented,
        forceModel: model as LLMProvider | undefined,
      })) {
        if (chunk.type === 'text' && chunk.content) fullText += chunk.content;
        if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
        if (chunk.type === 'done') break;
      }
      c.header('X-Conversation-Id', convId);
      return c.json({ conversationId: convId, response: fullText, usage });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── SSE streaming chat ──────────────────────────────────────────────────────
  app.post('/stream', async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const parsed = ChatSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const { message, conversationId, model, includeFileContext } = parsed.data;
    const convId = conversationId ?? randomUUID();
    const augmented = augmentWithContext(message, _ideContext, includeFileContext);

    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of engine.chat({
          conversationId: convId,
          message: augmented,
          forceModel: model as LLMProvider | undefined,
        })) {
          if (chunk.type === 'done') {
            await stream.writeSSE({ event: 'done', data: JSON.stringify({ conversationId: convId }) });
            break;
          }
          await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
        }
      } catch (err) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
      }
    });
  });

  return app;
}
