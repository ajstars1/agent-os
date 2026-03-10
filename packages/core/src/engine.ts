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
import type { HAMCompressor } from './memory/compressor.js';

const MAX_TOOL_ITERATIONS = 10;
const L4_MIN_RESPONSE_CHARS = 180; // minimum response length to be worth saving

const STOP_WORDS = new Set([
  'what', 'who', 'where', 'when', 'why', 'how', 'is', 'are', 'was', 'were',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'about', 'can', 'you', 'tell', 'me', 'explain',
  'describe', 'please', 'could', 'would', 'should', 'does', 'do', 'did',
]);

function extractTopicSlug(message: string): string {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return words.slice(0, 4).join('-') || 'general-knowledge';
}

function isWorthSaving(response: string): boolean {
  if (response.length < L4_MIN_RESPONSE_CHARS) return false;
  const lower = response.toLowerCase();
  const conversational = ["i don't know", "i'm not sure", "i cannot", "sorry,", "i apologize", "as an ai"];
  return !conversational.some((p) => lower.startsWith(p));
}

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
    private readonly hamCompressor?: HAMCompressor | null,
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

    // Emit provider so clients can display which model is responding
    yield { type: 'provider', provider };

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

    // Collect full response text for L4 auto-save check
    let fullResponse = '';
    const collectChunks = async function* (
      gen: AsyncGenerator<StreamChunk>,
    ): AsyncGenerator<StreamChunk> {
      for await (const chunk of gen) {
        if (chunk.type === 'text' && chunk.content) fullResponse += chunk.content;
        yield chunk;
      }
    };

    if (provider === 'claude') {
      yield* collectChunks(this.claudeLoop(input.conversationId, history, systemPrompt, toolDefs, cleanedMessage));
    } else {
      yield* collectChunks(this.geminiStream(input.conversationId, history, systemPrompt, cleanedMessage));
    }

    // Update HAM access stats after response
    if (hamResult?.usedChunkIds.length && this.hamStore) {
      for (const id of hamResult.usedChunkIds) {
        this.hamStore.updateAccessStats(id);
      }
    }

    // L4 auto-save: if nothing was in memory and response is substantive, learn it
    if (
      hamResult?.isMemoryMiss &&
      this.hamStore &&
      this.hamCompressor &&
      isWorthSaving(fullResponse)
    ) {
      const topic = extractTopicSlug(cleanedMessage);
      const existing = this.hamStore.getByTopic(topic);
      if (!existing) {
        this.hamCompressor
          .compressChunk(fullResponse, topic, [])
          .then((chunk) => {
            this.hamStore!.addChunk({ ...chunk, lastAccessed: 0, accessCount: 0 });
            this.logger.info({ topic }, 'L4 auto-saved new knowledge chunk');
          })
          .catch((err: unknown) => {
            this.logger.warn({ err }, 'L4 auto-save failed');
          });
        yield { type: 'memory_saved', content: topic };
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
