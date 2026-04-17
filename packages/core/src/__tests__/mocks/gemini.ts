import type { StreamChunk } from '@agent-os-core/shared';
import type { GeminiMessage } from '../../llm/gemini.js';

export class MockGeminiClient {
  private classifyResult: 'claude' | 'gemini';

  constructor(classifyResult: 'claude' | 'gemini' = 'claude') {
    this.classifyResult = classifyResult;
  }

  async *stream(
    _messages: GeminiMessage[],
    _systemPrompt: string,
  ): AsyncGenerator<StreamChunk> {
    yield { type: 'text', content: 'mock gemini response' };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 10 } };
    yield { type: 'done' };
  }

  async classify(_message: string): Promise<'claude' | 'gemini'> {
    return this.classifyResult;
  }
}
