/**
 * OpenRouter LLM client — wraps the OpenAI-compatible OpenRouter API.
 *
 * Supports 200+ models via a single API key. Model selection:
 *   or: <message>              → uses OPENROUTER_DEFAULT_MODEL (default: openai/gpt-4o-mini)
 *   or:gpt-4o <message>        → routes to openai/gpt-4o
 *   or:claude-3-opus <message> → routes to anthropic/claude-opus-4
 *
 * Short aliases are expanded to full OR model IDs.
 */

import type { LLMClient, UnifiedMessage } from './base.js';
import type { StreamChunk, ToolDefinition } from '@agent-os-core/shared';

const OR_BASE = 'https://openrouter.ai/api/v1';

export const OR_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** Short name → OpenRouter model ID */
const MODEL_ALIASES: Record<string, string> = {
  'gpt-4o':          'openai/gpt-4o',
  'gpt-4o-mini':     'openai/gpt-4o-mini',
  'gpt-4':           'openai/gpt-4',
  'gpt-3.5':         'openai/gpt-3.5-turbo',
  'claude-3-opus':   'anthropic/claude-opus-4',
  'claude-3-sonnet': 'anthropic/claude-sonnet-4-5',
  'claude-3-haiku':  'anthropic/claude-haiku-4-5',
  'gemini-pro':      'google/gemini-pro-1.5',
  'gemini-flash':    'google/gemini-flash-1.5',
  'llama-3':         'meta-llama/llama-3.1-8b-instruct',
  'llama-3-70b':     'meta-llama/llama-3.1-70b-instruct',
  'mixtral':         'mistralai/mixtral-8x7b-instruct',
  'mistral':         'mistralai/mistral-7b-instruct',
  'qwen':            'qwen/qwen-2.5-72b-instruct',
  'deepseek':        'deepseek/deepseek-chat',
  'phi-3':           'microsoft/phi-3-medium-128k-instruct',
};

export function resolveORModel(shortName: string): string {
  return MODEL_ALIASES[shortName] ?? shortName;
}

// ─── SSE parsing ──────────────────────────────────────────────────────────────

async function* parseSSE(res: Response): AsyncGenerator<string> {
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
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data && data !== '[DONE]') yield data;
      }
    }
  }
}

// ─── OpenRouter client ────────────────────────────────────────────────────────

export class OpenRouterClient implements LLMClient {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string = OR_DEFAULT_MODEL,
  ) {}

  async *stream(
    messages: UnifiedMessage[],
    systemPrompt: string,
    _tools?: ToolDefinition[],
    options?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    const model = resolveORModel((options?.['orModel'] as string | undefined) ?? this.defaultModel);

    const orMessages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) orMessages.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      orMessages.push({
        role: m.role === 'system' ? 'user' : m.role,
        content: typeof m.content === 'string' ? m.content
          : m.content.map((c) => c.type === 'text' ? c.text : '').join(''),
      });
    }

    let res: Response;
    try {
      res = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/agent-os/agent-os',
          'X-Title': 'AgentOS',
        },
        body: JSON.stringify({
          model,
          messages: orMessages,
          stream: true,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      yield { type: 'error', content: `OpenRouter network error: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      yield { type: 'error', content: `OpenRouter error ${res.status}: ${body}` };
      return;
    }

    // Emit model name so UI can display it
    yield { type: 'provider', provider: 'openrouter', model };

    let fullText = '';

    for await (const raw of parseSSE(res)) {
      try {
        const chunk = JSON.parse(raw) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          yield { type: 'text', content: delta };
        }

        const usage = chunk.usage;
        if (usage) {
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
          };
        }

        if (chunk.choices?.[0]?.finish_reason) {
          yield { type: 'done' };
          return;
        }
      } catch {
        // Malformed SSE chunk — skip
      }
    }

    if (fullText) yield { type: 'done' };
  }
}
