import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { StreamChunk, ToolDefinition, ToolCall } from '@agent-os-core/shared';
import type { LLMClient, UnifiedMessage } from './base.js';

export class ClaudeClient implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async *stream(
    messages: UnifiedMessage[],
    systemPrompt: string,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const anthropicMessages: MessageParam[] = messages.map(m => {
      if (typeof m.content === 'string') {
        return {
          role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
          content: m.content
        };
      }
      return {
        role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
        content: m.content.map(c => {
          if (c.type === 'text') return { type: 'text', text: c.text };
          if (c.type === 'tool_call') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
          if (c.type === 'tool_result') return { type: 'tool_result', tool_use_id: c.toolCallId, content: c.content, is_error: c.isError };
          return { type: 'text', text: '' };
        }) as any
      };
    });

    const anthropicTools: Anthropic.Tool[] | undefined = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const stream = this.client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      system: systemPrompt,
      messages: anthropicMessages,
      ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    // Buffer for tool input JSON (streamed in fragments)
    const toolInputBuffers = new Map<number, string>();
    const toolCallsByIndex = new Map<number, { id: string; name: string }>();

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolCallsByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
          });
          toolInputBuffers.set(event.index, '');
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const existing = toolInputBuffers.get(event.index) ?? '';
          toolInputBuffers.set(event.index, existing + event.delta.partial_json);
        }
      } else if (event.type === 'content_block_stop') {
        const toolMeta = toolCallsByIndex.get(event.index);
        if (toolMeta) {
          const jsonStr = toolInputBuffers.get(event.index) ?? '{}';
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            input = {};
          }
          const toolCall: ToolCall = { id: toolMeta.id, name: toolMeta.name, input };
          yield { type: 'tool_call', toolCall };
          toolCallsByIndex.delete(event.index);
          toolInputBuffers.delete(event.index);
        }
      } else if (event.type === 'message_delta' && event.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 0,
            outputTokens: event.usage.output_tokens,
          },
        };
      } else if (event.type === 'message_start' && event.message.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
          },
        };
      }
    }

    yield { type: 'done' };
  }
}
