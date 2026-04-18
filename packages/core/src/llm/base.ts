import type { StreamChunk, ToolDefinition, ToolCall, ToolResult } from '@agent-os-core/shared';

export type UnifiedMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'tool_call'; id: string; name: string; input: Record<string, any> }
    | { type: 'tool_result'; toolCallId: string; name: string; content: string; isError?: boolean }
  >;
};

export interface LLMClient {
  stream(
    messages: UnifiedMessage[],
    systemPrompt: string,
    tools?: ToolDefinition[],
    options?: Record<string, any>
  ): AsyncGenerator<StreamChunk>;
}
