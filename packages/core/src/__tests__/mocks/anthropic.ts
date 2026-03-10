import type { StreamChunk, ToolDefinition } from '@agent-os/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

export class MockClaudeClient {
  private readonly responses: StreamChunk[][];
  private callIndex = 0;

  constructor(responses: StreamChunk[][] = []) {
    this.responses = responses;
  }

  async *stream(
    _messages: MessageParam[],
    _system: string,
    _tools?: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const chunks = this.responses[this.callIndex] ?? [
      { type: 'text', content: 'mock claude response' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'done' },
    ];
    this.callIndex++;
    for (const chunk of chunks) {
      yield chunk;
    }
  }
}
