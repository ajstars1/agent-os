import type { LLMClient, UnifiedMessage } from '../llm/base.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger, ToolResult, StreamChunk, ToolCall } from '@agent-os-core/shared';

const MAX_TOOL_ITERATIONS = 40;

export class ToolExecutor {
  constructor(
    private readonly client: LLMClient,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
  ) {}

  public async *runLoop(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    onFinalAssistantMessage?: (text: string, tokens: number) => void,
    options?: Record<string, any>,
  ): AsyncGenerator<StreamChunk> {
    const messages: UnifiedMessage[] = [...initialMessages];
    let iteration = 0;
    let fullAssistantText = '';
    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    while (iteration < MAX_TOOL_ITERATIONS) {
      const pendingToolCalls: ToolCall[] = [];
      let iterText = '';

      for await (const chunk of this.client.stream(messages, systemPrompt, toolDefs, options)) {
        if (chunk.type === 'text' && chunk.content) {
          iterText += chunk.content;
          yield chunk;
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          yield chunk;
        } else if (chunk.type === 'usage' && chunk.usage) {
          lastUsage = chunk.usage;
          yield chunk;
        } else if (chunk.type === 'done') {
          break;
        }
      }

      fullAssistantText += iterText;

      if (pendingToolCalls.length === 0) {
        break;
      }

      const toolResults: ToolResult[] = [];
      for (const toolCall of pendingToolCalls) {
        this.logger.debug({ tool: toolCall.name }, 'ToolExecutor calling tool');
        const result = await this.tools.callTool(toolCall.name, toolCall.input);
        result.toolCallId = toolCall.id;
        toolResults.push(result);
        yield { type: 'tool_result', toolResult: result };
      }

      const assistantContent: UnifiedMessage['content'] = [];
      if (iterText) assistantContent.push({ type: 'text', text: iterText });
      for (const tc of pendingToolCalls) {
        assistantContent.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result',
          toolCallId: r.toolCallId,
          name: pendingToolCalls.find(tc => tc.id === r.toolCallId)?.name ?? '',
          content: r.content,
          isError: r.isError,
        })),
      });

      iteration++;
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      this.logger.warn('ToolExecutor hit max tool iterations');
    }

    if (onFinalAssistantMessage && fullAssistantText) {
      onFinalAssistantMessage(fullAssistantText, lastUsage.inputTokens + lastUsage.outputTokens);
    }

    yield { type: 'done' };
  }
  
  /** 
   * Helper that runs the loop to completion and returns the final concatenated string.
   * Useful for Specialist Agents.
   */
  public async *runLoopAndReturnChunks(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    options?: Record<string, any>,
  ): AsyncGenerator<StreamChunk> {
    yield* this.runLoop(systemPrompt, initialMessages, toolDefs, undefined, options);
  }

  public async runLoopAndReturnString(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    options?: Record<string, any>,
  ): Promise<string> {
    let output = '';
    for await (const chunk of this.runLoop(systemPrompt, initialMessages, toolDefs, undefined, options)) {
      if (chunk.type === 'text' && chunk.content) {
        output += chunk.content;
      }
    }
    return output;
  }
}
