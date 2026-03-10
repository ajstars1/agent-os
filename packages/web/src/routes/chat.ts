import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEngine, AgentLoader } from '@agent-os/core';
import type { Logger, LLMProvider } from '@agent-os/shared';
import { ChatRequestSchema } from '../schemas/chat.js';

export function chatRoute(
  engine: AgentEngine,
  agents: AgentLoader,
  logger: Logger,
): Hono {
  const app = new Hono();

  function parseBody(raw: unknown): z.SafeParseReturnType<unknown, z.infer<typeof ChatRequestSchema>> {
    return ChatRequestSchema.safeParse(raw);
  }

  // SSE streaming endpoint
  app.post('/stream', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = parseBody(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues }, 400);
    }

    const body = parsed.data;
    const conversationId = body.conversationId ?? randomUUID();
    const agentProfile = body.agentName ? agents.get(body.agentName) : undefined;

    // Disable nginx buffering for SSE
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of engine.chat({
          conversationId,
          message: body.message,
          forceModel: body.model as LLMProvider | undefined,
          agentProfile,
        })) {
          if (chunk.type === 'done') {
            await stream.writeSSE({ event: 'done', data: '' });
            break;
          }
          await stream.writeSSE({
            event: chunk.type,
            data: JSON.stringify(chunk),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, conversationId }, 'SSE stream error');
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: msg }) });
      }
    });
  });

  // Non-streaming collect endpoint
  app.post('/', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = parseBody(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues }, 400);
    }

    const body = parsed.data;
    const conversationId = body.conversationId ?? randomUUID();
    const agentProfile = body.agentName ? agents.get(body.agentName) : undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let fullText = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const chunk of engine.chat({
        conversationId,
        message: body.message,
        forceModel: body.model as LLMProvider | undefined,
        agentProfile,
      })) {
        if (controller.signal.aborted) break;
        if (chunk.type === 'text' && chunk.content) fullText += chunk.content;
        if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
        if (chunk.type === 'done') break;
      }

      clearTimeout(timeout);
      c.header('X-Conversation-Id', conversationId);
      return c.json({ conversationId, response: fullText, usage });
    } catch (err: unknown) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'Chat error');
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
