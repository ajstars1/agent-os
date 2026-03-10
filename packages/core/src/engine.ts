import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type {
  StreamChunk,
  ToolCall,
  ToolResult,
  LLMProvider,
  ChannelType,
  Conversation,
  Config,
} from '@agent-os/shared';
import type { IMemoryStore } from './memory/interface.js';
import type { SkillLoader } from './skills/loader.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ClaudeClient } from './llm/claude.js';
import type { GeminiClient, GeminiMessage } from './llm/gemini.js';
import type { LLMRouter } from './llm/router.js';
import type { Logger } from '@agent-os/shared';
import type { AgentProfile } from './agents/types.js';
import type { HAMRetriever } from './memory/retriever.js';
import type { TieredStore } from './memory/tiered-store.js';

const MAX_TOOL_ITERATIONS = 10;

export interface EngineInput {
  conversationId: string;
  message: string;
  forceModel?: LLMProvider;
  agentProfile?: AgentProfile;
}

export class AgentEngine {
  constructor(
    private readonly config: Config,
    private readonly memory: IMemoryStore,
    private readonly skills: SkillLoader,
    private readonly tools: ToolRegistry,
    private readonly claude: ClaudeClient,
    private readonly gemini: GeminiClient | null,
    private readonly router: LLMRouter,
    private readonly logger: Logger,
    private readonly hamRetriever?: HAMRetriever,
    private readonly hamStore?: TieredStore,
  ) {}

  getOrCreateConversation(channel: ChannelType, channelId: string): Conversation {
    return this.memory.getOrCreateConversation(channel, channelId);
  }

  clearConversation(conversationId: string): void {
    this.memory.clearConversation(conversationId);
  }

  async *chat(input: EngineInput): AsyncGenerator<StreamChunk> {
    const cleanedMessage = this.router.stripPrefix(input.message);
    const effectiveModel = input.forceModel ?? input.agentProfile?.defaultModel;
    const provider = await this.router.route(input.message, effectiveModel);

    // Ensure conversation row exists before inserting messages (web route passes a bare UUID)
    this.memory.ensureConversation(input.conversationId);

    // Store user message first so history is current for HAM retrieval
    this.memory.addMessage(input.conversationId, {
      conversationId: input.conversationId,
      role: 'user',
      content: cleanedMessage,
    });

    // Build message history
    const history = this.memory.getMessages(input.conversationId, 50);

    // HAM retrieval — prepend adaptive memory to system prompt
    const hamResult = this.hamRetriever?.retrieve(cleanedMessage, history, input.conversationId);
    const baseContext = this.skills.getSystemContext();
    let systemPrompt = input.agentProfile?.systemPrompt
      ? `${input.agentProfile.systemPrompt}\n\n---\n\n${baseContext}`
      : baseContext;

    if (hamResult?.activeMemory) {
      systemPrompt = `${hamResult.activeMemory}\n\n---\n\n${systemPrompt}`;
      this.logger.debug(
        { state: hamResult.state, tokens: hamResult.tokenCount, topics: hamResult.expandedTopics },
        'HAM retrieval complete',
      );
    }

    const toolDefs = this.tools.getTools();

    if (provider === 'claude') {
      yield* this.claudeLoop(input.conversationId, history, systemPrompt, toolDefs, cleanedMessage);
    } else {
      yield* this.geminiStream(input.conversationId, history, systemPrompt, cleanedMessage);
    }

    // Update HAM access stats after response
    if (hamResult?.usedChunkIds.length && this.hamStore) {
      for (const id of hamResult.usedChunkIds) {
        this.hamStore.updateAccessStats(id);
      }
    }
  }

  private async *claudeLoop(
    conversationId: string,
    history: ReturnType<IMemoryStore['getMessages']>,
    systemPrompt: string,
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    lastUserMessage: string,
  ): AsyncGenerator<StreamChunk> {
    const messages: MessageParam[] = history
      .slice(0, -1) // exclude last user message (already in history), we'll add it
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // Add the current user message
    messages.push({ role: 'user', content: lastUserMessage });

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
        // No tool calls — we're done
        break;
      }

      // Execute tool calls
      const toolResults: ToolResult[] = [];
      for (const toolCall of pendingToolCalls) {
        this.logger.debug({ tool: toolCall.name }, 'Calling tool');
        const result = await this.tools.callTool(toolCall.name, toolCall.input);
        result.toolCallId = toolCall.id;
        toolResults.push(result);
        yield { type: 'tool_result', toolResult: result };
      }

      // Build Claude tool use + tool result messages
      const assistantContent: MessageParam['content'] = [];
      if (iterText) {
        assistantContent.push({ type: 'text', text: iterText });
      }
      for (const tc of pendingToolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResultContent: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = toolResults.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      }));
      messages.push({ role: 'user', content: toolResultContent });

      iteration++;
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      this.logger.warn({ conversationId }, 'Hit max tool iterations');
    }

    // Persist assistant message
    if (fullAssistantText) {
      this.memory.addMessage(conversationId, {
        conversationId,
        role: 'assistant',
        content: fullAssistantText,
        model: 'claude',
        tokens: lastUsage.inputTokens + lastUsage.outputTokens,
      });
    }

    yield { type: 'done' };
  }

  private async *geminiStream(
    conversationId: string,
    history: ReturnType<IMemoryStore['getMessages']>,
    systemPrompt: string,
    lastUserMessage: string,
  ): AsyncGenerator<StreamChunk> {
    if (!this.gemini) {
      yield { type: 'text', content: 'Gemini client not configured.' };
      yield { type: 'done' };
      return;
    }

    const geminiMessages: GeminiMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    // Ensure last message is the current user input
    if (geminiMessages.length === 0 || geminiMessages[geminiMessages.length - 1]?.role !== 'user') {
      geminiMessages.push({ role: 'user', parts: [{ text: lastUserMessage }] });
    }

    let fullText = '';
    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of this.gemini.stream(geminiMessages, systemPrompt)) {
      if (chunk.type === 'text' && chunk.content) {
        fullText += chunk.content;
        yield chunk;
      } else if (chunk.type === 'usage' && chunk.usage) {
        lastUsage = chunk.usage;
        yield chunk;
      } else if (chunk.type === 'done') {
        break;
      }
    }

    if (fullText) {
      this.memory.addMessage(conversationId, {
        conversationId,
        role: 'assistant',
        content: fullText,
        model: 'gemini',
        tokens: lastUsage.inputTokens + lastUsage.outputTokens,
      });
    }

    yield { type: 'done' };
  }
}
