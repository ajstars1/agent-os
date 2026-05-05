/**
 * Ollama LLM client — wraps the local Ollama OpenAI-compatible API.
 *
 * Model selection:
 *   ol: <message>             → uses OLLAMA_DEFAULT_MODEL (default: llama3.2)
 *   ol:codellama <message>    → uses codellama model
 *
 * Auto-detects Ollama at localhost:11434. Falls back with a clear error if not running.
 */

import type { LLMClient, UnifiedMessage } from './base.js';
import type { StreamChunk, ToolDefinition } from '@agent-os-core/shared';

const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

// ─── Availability check ───────────────────────────────────────────────────────

export async function checkOllamaAvailable(base = DEFAULT_OLLAMA_BASE): Promise<{ available: boolean; models: string[] }> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

// ─── SSE parsing for Ollama's NDJSON stream ───────────────────────────────────

async function* parseNDJSON(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Skip malformed lines
      }
    }
  }
}

// ─── Ollama client ────────────────────────────────────────────────────────────

export class OllamaClient implements LLMClient {
  constructor(
    private readonly base: string = DEFAULT_OLLAMA_BASE,
    private readonly defaultModel: string = OLLAMA_DEFAULT_MODEL,
  ) {}

  async *stream(
    messages: UnifiedMessage[],
    systemPrompt: string,
    _tools?: ToolDefinition[],
    options?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    const model = (options?.['olModel'] as string | undefined) ?? this.defaultModel;

    // Use OpenAI-compatible /v1/chat/completions endpoint (Ollama 0.1.24+)
    const olMessages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) olMessages.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      olMessages.push({
        role: m.role === 'system' ? 'user' : m.role,
        content: typeof m.content === 'string' ? m.content
          : m.content.map((c) => c.type === 'text' ? c.text : '').join(''),
      });
    }

    let res: Response;
    try {
      res = await fetch(`${this.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: olMessages,
          stream: true,
        }),
        signal: AbortSignal.timeout(300_000), // local models can be slow
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        yield { type: 'error', content: 'Ollama not running. Start it with: ollama serve' };
      } else {
        yield { type: 'error', content: `Ollama error: ${msg}` };
      }
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      if (res.status === 404) {
        yield { type: 'error', content: `Ollama model not found: "${model}". Pull it with: ollama pull ${model}` };
      } else {
        yield { type: 'error', content: `Ollama error ${res.status}: ${body}` };
      }
      return;
    }

    // Emit provider info
    yield { type: 'provider', provider: 'ollama', model };

    let hasContent = false;

    for await (const chunk of parseNDJSON(res)) {
      const message = chunk['message'] as { content?: string } | undefined;
      const content = message?.content;
      if (content) {
        hasContent = true;
        yield { type: 'text', content };
      }

      if (chunk['done'] === true) {
        const promptTokens = (chunk['prompt_eval_count'] as number | undefined) ?? 0;
        const evalTokens = (chunk['eval_count'] as number | undefined) ?? 0;
        if (promptTokens || evalTokens) {
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: promptTokens,
              outputTokens: evalTokens,
            },
          };
        }
        yield { type: 'done' };
        return;
      }
    }

    if (hasContent) yield { type: 'done' };
  }
}
