import type { ClaudeClient } from '../llm/claude.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger, ToolResult, StreamChunk, ToolCall } from '@agent-os-core/shared';

const MAX_TOOL_ITERATIONS = 40;

export class ToolExecutor {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
  ) {}

  public async *runLoop(
    systemPrompt: string,
    initialMessages: MessageParam[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    onFinalAssistantMessage?: (text: string, tokens: number) => void,
  ): AsyncGenerator<StreamChunk> {
    const messages: MessageParam[] = [...initialMessages];
    let iteration = 0;
    let fullAssistantText = '';
    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    while (iteration < MAX_TOOL_ITERATIONS) {
      const pendingToolCalls: ToolCall[] = [];
      let iterText = '';

      for await (const chunk of this.claude.stream(messages, systemPrompt, toolDefs)) {
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

      const assistantContent: MessageParam['content'] = [];
      if (iterText) assistantContent.push({ type: 'text', text: iterText });
      for (const tc of pendingToolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResultContent = toolResults.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      }));
      messages.push({ role: 'user', content: toolResultContent });

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
  public async runLoopAndReturnString(
    systemPrompt: string,
    initialMessages: MessageParam[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
  ): Promise<string> {
    let output = '';
    for await (const chunk of this.runLoop(systemPrompt, initialMessages, toolDefs)) {
      if (chunk.type === 'text' && chunk.content) {
        output += chunk.content;
      }
    }
    return output;
  }
}
