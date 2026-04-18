import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type {
  StreamChunk,
  ToolCall,
  ToolResult,
  LLMProvider,
  ChannelType,
  Conversation,
  Config,
} from '@agent-os-core/shared';
import type { IMemoryStore } from './memory/interface.js';
import type { SkillLoader } from './skills/loader.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ClaudeClient } from './llm/claude.js';
import type { GeminiClient, GeminiMessage, GeminiVariant } from './llm/gemini.js';
import type { LLMRouter } from './llm/router.js';
import type { Logger } from '@agent-os-core/shared';
import type { AgentProfile } from './agents/types.js';
import type { HAMRetriever } from './memory/retriever.js';
import type { TieredStore } from './memory/tiered-store.js';
import type { HAMCompressor } from './memory/compressor.js';
import { SemanticGraph } from './memory/semantic-graph.js';
import type { EpisodicStore } from './memory/episodic-store.js';
import type { UserProfileStore } from './memory/user-profile-store.js';
import type { ProfileExtractor } from './memory/profile-extractor.js';
import { buildContext } from './memory/context-builder.js';
import { Orchestrator } from './agents/orchestrator.js';
import type { FeedbackStore } from './memory/feedback-store.js';
import { ToolExecutor } from './agents/tool-executor.js';
import { PlanningManager, TaskRegistry } from './planning.js';

const MAX_TOOL_ITERATIONS = 10;

const L4_MIN_RESPONSE_CHARS = 400;
const STOP_WORDS = new Set(['what','who','where','when','why','how','is','are','was','were','the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','about','can','you','tell','me','explain','describe','please','could','would','should','does','do','did']);

function extractTopicSlug(message: string): string {
  const words = message.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return words.slice(0, 4).join('-') || 'general-knowledge';
}

/** Returns true only for responses worth caching — factual, specific, not generic advice. */
function isWorthSaving(response: string, question: string): boolean {
  if (response.length < L4_MIN_RESPONSE_CHARS) return false;
  const lowerQ = question.toLowerCase().trim();
  const lowerR = response.toLowerCase();
  // Skip advice/opinion questions
  const advicePatterns = [
    /^how (can|do|would|could|should|to)/,
    /^what (are|would|could|should) (some|the best|ways|good)/,
    /^(can you )?(suggest|recommend|advise|give me)/,
    /^(improve|enhance|better|optimize|fix)/,
    /^what do you think/,
  ];
  if (advicePatterns.some((p) => p.test(lowerQ))) return false;
  // Skip conversational / uncertain responses
  const skipPhrases = ["i don't know", "i'm not sure", "i cannot", "sorry,", "i apologize", "as an ai", "here are some ways", "here are a few"];
  if (skipPhrases.some((p) => lowerR.includes(p))) return false;
  return true;
}

/** Milliseconds of user inactivity before the sleep cycle triggers (5 minutes). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/** Number of recent messages gathered for the sleep consolidation pass. */
const SLEEP_MESSAGE_LIMIT = 50;

// Removed global NEURAL_ENGINE_URL; using config.NEURAL_ENGINE_URL instead.

export interface EngineInput {
  conversationId: string;
  message: string;
  forceModel?: LLMProvider;
  agentProfile?: AgentProfile;
  /** Enable Gemini Google Search grounding for this request. */
  useSearch?: boolean;
}

export class AgentEngine {
  // ---------------------------------------------------------------------------
  // Idle-sleep state
  // ---------------------------------------------------------------------------

  /**
   * Handle for the active inactivity `setTimeout`.  Reset on every user
   * message; fires `startSleepCycle()` after {@link IDLE_TIMEOUT_MS}.
   */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Guard flag — prevents concurrent sleep cycles if the timer somehow fires
   * while a previous cycle is still running.
   */
  private _sleepRunning = false;

  /**
   * The conversation ID used for the last sleep cycle fetch.  We track the
   * most recently active conversation so the cycle knows which thread to mine.
   */
  private _activeConversationId: string | null = null;

  /**
   * Semantic graph for permanent fact storage.  Shared across sleep cycles.
   * Accepts an optional injected instance for testing; defaults to an
   * in-memory SQLite-backed graph when omitted.
   */
  private readonly _semanticGraph: SemanticGraph;
  private readonly _orchestrator: Orchestrator;
  private readonly _toolExecutor?: ToolExecutor;
  public readonly planningManager: PlanningManager;
  public readonly taskRegistry: TaskRegistry;

  constructor(
    private readonly config: Config,
    private readonly memory: IMemoryStore,
    private readonly skills: SkillLoader,
    private readonly tools: ToolRegistry,
    private readonly claude: ClaudeClient | null,
    private readonly gemini: GeminiClient | null,
    private readonly router: LLMRouter,
    private readonly logger: Logger,
    private readonly hamRetriever?: HAMRetriever,
    private readonly hamStore?: TieredStore,
    private readonly hamCompressor?: HAMCompressor | null,
    semanticGraph?: SemanticGraph,
    private readonly episodicStore?: EpisodicStore,
    private readonly userProfileStore?: UserProfileStore,
    private readonly profileExtractor?: ProfileExtractor,
    /** Pre-loaded hot topics from the background learner (boosts episode retrieval). */
    private readonly learnerTopics: string[] = [],
    private readonly feedbackStore?: FeedbackStore,
  ) {
    this._orchestrator = new Orchestrator(claude, gemini, episodicStore, logger, tools);
    if (claude) {
      this._toolExecutor = new ToolExecutor(claude, tools, logger);
    }

    this.taskRegistry = new TaskRegistry();
    this.planningManager = new PlanningManager(this.taskRegistry, logger);

    this._semanticGraph = semanticGraph ?? new SemanticGraph({
      llm: {
        complete: async (systemPrompt: string, userPrompt: string) => {
          // Respect the configured default model so internal calls (SemanticGraph,
          // sleep-cycle) don't silently fall back to Claude when the user is in
          // Gemini mode.  Only route dynamically when the default is 'auto'.
          const useGemini =
            gemini !== null &&
            (config.DEFAULT_MODEL === 'gemini' ||
              (config.DEFAULT_MODEL === 'auto' && (await router.route(userPrompt)) === 'gemini'));

          let text = '';
          if (useGemini && gemini) {
            for await (const chunk of gemini.stream([{ role: 'user', parts: [{ text: userPrompt }] }], systemPrompt)) {
              if (chunk.type === 'text' && chunk.content) text += chunk.content;
            }
          } else if (claude) {
            for await (const chunk of claude.stream([{ role: 'user', content: userPrompt }], systemPrompt)) {
              if (chunk.type === 'text' && chunk.content) text += chunk.content;
            }
          }
          return text;
        }
      }
    });
  }

  getOrCreateConversation(channel: ChannelType, channelId: string): Conversation {
    return this.memory.getOrCreateConversation(channel, channelId);
  }

  clearConversation(conversationId: string): void {
    this.memory.clearConversation(conversationId);
  }

  /**
   * Retrieves messages for a given conversation.
   *
   * @param conversationId - The unique conversation identifier.
   * @param limit - Maximum number of messages to return (default: 50).
   * @returns Array of Message objects ordered by creation time.
   */
  getMessages(conversationId: string, limit = 50): ReturnType<IMemoryStore['getMessages']> {
    return this.memory.getMessages(conversationId, limit);
  }

  // ---------------------------------------------------------------------------
  // Idle timer & sleep cycle
  // ---------------------------------------------------------------------------

  /**
   * Reset the inactivity countdown.  Must be called every time the user sends
   * a message so the timer starts fresh from that point.
   *
   * If the engine has been idle for {@link IDLE_TIMEOUT_MS} with no calls to
   * this method, {@link startSleepCycle} fires automatically.
   *
   * @param conversationId - The conversation that is currently active.  Stored
   *                         so the sleep cycle knows which thread to mine.
   */
  resetIdleTimer(conversationId: string): void {
    this._activeConversationId = conversationId;

    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
    }

    this._idleTimer = setTimeout(() => {
      this.startSleepCycle().catch((err: unknown) => {
        this.logger.error({ err }, '[SleepCycle] Unhandled error in sleep cycle');
      });
    }, IDLE_TIMEOUT_MS);
  }

  /**
   * Cancel the idle timer (e.g. on graceful shutdown).
   */
  cancelIdleTimer(): void {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * Run the full sleep-cycle consolidation pass.
   *
   * Steps:
   * 1. Gather the last {@link SLEEP_MESSAGE_LIMIT} messages from SQLite.
   * 2. POST them to the PyTorch `/trigger_sleep` endpoint.
   * 3. Delete the rows at `indices_to_delete` from SQLite.
   * 4. Pass `consolidated_context` through {@link SemanticGraph.extractAndStoreFacts}
   *    to permanently save extracted facts.
   * 5. Log completion.
   *
   * Protected by `_sleepRunning` — concurrent invocations are dropped.
   */
  async startSleepCycle(): Promise<void> {
    if (this._sleepRunning) {
      this.logger.warn('[SleepCycle] Cycle already running — skipping concurrent invocation.');
      return;
    }

    const conversationId = this._activeConversationId;
    if (!conversationId) {
      this.logger.warn('[SleepCycle] No active conversation to consolidate.');
      return;
    }

    this._sleepRunning = true;
    this.logger.info({ conversationId }, '[SleepCycle] Starting sleep cycle...');

    try {
      // ── Step 1: Gather recent messages ─────────────────────────────────────
      const messages = this.memory.getMessages(conversationId, SLEEP_MESSAGE_LIMIT);

      if (messages.length === 0) {
        this.logger.info('[SleepCycle] No messages to consolidate — skipping.');
        return;
      }

      // Build ordered log strings: "[role] content"
      const logs = messages.map((m) => `[${m.role}] ${m.content}`);

      // Append pending user feedback to logs for consolidation awareness
      if (this.feedbackStore) {
        const feedbackCtx = this.feedbackStore.buildFeedbackContext();
        if (feedbackCtx) {
          logs.push(`[system] ${feedbackCtx}`);
          this.logger.info('[SleepCycle] Injected user feedback into consolidation context');
        }
      }

      // ── Step 2: Call the PyTorch /trigger_sleep endpoint ───────────────────
      let sleepResponse: {
        indices_to_delete: number[];
        consolidated_context: string;
        logs_total: number;
        logs_pruned: number;
        logs_retained: number;
      };

      try {
        const res = await fetch(`${this.config.NEURAL_ENGINE_URL}/trigger_sleep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs, prune_threshold: 0.9 }),
          signal: AbortSignal.timeout(30_000), // 30 s — consolidation can be slow
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '(unreadable)');
          this.logger.error(
            { status: res.status, body: errBody },
            '[SleepCycle] /trigger_sleep returned non-2xx',
          );
          return;
        }

        sleepResponse = await res.json() as typeof sleepResponse;
      } catch (fetchErr) {
        this.logger.error({ err: fetchErr }, '[SleepCycle] Network error calling /trigger_sleep');
        return;
      }

      this.logger.info(
        {
          total: sleepResponse.logs_total,
          pruned: sleepResponse.logs_pruned,
          retained: sleepResponse.logs_retained,
        },
        '[SleepCycle] /trigger_sleep response received',
      );

      // ── Step 3: Delete redundant message rows from SQLite ──────────────────
      const { indices_to_delete, consolidated_context } = sleepResponse;

      if (indices_to_delete.length > 0) {
        // Map positional indices → message IDs
        const idsToDelete = indices_to_delete
          .filter((idx) => idx >= 0 && idx < messages.length)
          .map((idx) => messages[idx]!.id);

        this.memory.deleteMessagesByIds(idsToDelete);
        this.logger.info(
          { count: idsToDelete.length },
          '[SleepCycle] Pruned redundant messages from SQLite',
        );
      }

      // ── Step 4: Permanently save facts via SemanticGraph ──────────────────
      if (consolidated_context.trim()) {
        try {
          const extraction = await this._semanticGraph.extractAndStoreFacts(
            consolidated_context,
          );
          this.logger.info(
            { stored: extraction.stored, skipped: extraction.skipped },
            '[SleepCycle] SemanticGraph fact extraction complete',
          );
        } catch (graphErr) {
          // Extraction failure is non-fatal — log and continue.
          this.logger.warn({ err: graphErr }, '[SleepCycle] SemanticGraph extraction failed');
        }
      }

      // ── Step 5: Mark feedback as applied ─────────────────────────────────
      if (this.feedbackStore) {
        const pending = this.feedbackStore.getPending(20);
        if (pending.length > 0) {
          this.feedbackStore.markApplied(pending.map((e) => e.id));
          this.logger.info({ count: pending.length }, '[SleepCycle] Marked feedback as applied');
        }
      }

      // ── Step 6: Done ───────────────────────────────────────────────────────
      console.log('Sleep cycle complete. Memory pruned and facts consolidated.');
    } finally {
      this._sleepRunning = false;
    }
  }

  async *chat(input: EngineInput): AsyncGenerator<StreamChunk> {
    // Reset the idle timer on every user message so the sleep cycle only fires
    // after a genuine period of inactivity.
    this.resetIdleTimer(input.conversationId);

    // If in Planning Mode, check for approval/rejection keywords
    if (this.planningManager.getMode() === 'plan') {
      const lower = input.message.toLowerCase().trim();
      if (lower === 'approve' || lower === 'yes' || lower === 'ok' || lower === 'do it') {
        this.planningManager.approvePlan();
        yield { type: 'status', content: 'Plan approved. Starting execution...' };
      } else if (lower === 'reject' || lower === 'no' || lower === 'cancel') {
        this.planningManager.rejectPlan();
        yield { type: 'status', content: 'Plan rejected. Returning to chat.' };
        return;
      } else {
        yield { type: 'text', content: 'We are currently in Planning Mode. Please "Approve" the plan to proceed or "Reject" to cancel.' };
        return;
      }
    }

    const cleanedMessage = this.router.stripPrefix(input.message);
    const parsedModel = this.router.parseForceModel((input.forceModel ?? input.agentProfile?.defaultModel) as string | undefined);
    const provider = await this.router.route(input.message, (parsedModel?.provider ?? input.forceModel) as LLMProvider | undefined);

    // Auto-select Gemini variant when none is explicitly specified
    let geminiVariant = parsedModel?.variant;
    if (provider === 'gemini' && !geminiVariant && this.gemini) {
      geminiVariant = this.gemini.classifyVariant(cleanedMessage);
      this.logger.debug({ variant: geminiVariant }, 'Gemini auto-variant selected');
    }

    // Emit provider + resolved model so the UI can show which variant is running
    yield { type: 'provider', provider, model: provider === 'gemini' ? `gemini:${geminiVariant ?? 'flash'}` : 'claude' };

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

    // ── HAM retrieval ─────────────────────────────────────────────────────────
    const hamResult = await this.hamRetriever?.retrieve(cleanedMessage, history, input.conversationId);

    // ── Companion context (profile + episodic + semantic) ──────────────────
    const CORE_SYSTEM_PROMPT = `You are the cognitive generator for AgentOS — a personal AI companion, not a generic assistant. You remember who the user is, what they're building, and what has happened between you. When provided with companion memory below, treat it as verified personal context and reference it naturally. Use first-person pronouns (I/me/my) as referring to the user, not yourself.`;
    const baseContext = this.skills.getSystemContext();

    let companionBlock = '';
    if (this.userProfileStore && this.episodicStore) {
      const profile = this.userProfileStore.get('default');
      // Merge message topics with learner-predicted hot topics for richer retrieval
      const messagTopics = this.extractTopics(cleanedMessage);
      const mergedTopics = [...new Set([...messagTopics, ...this.learnerTopics])].slice(0, 10);
      const episodes = this.episodicStore.getTopN(20, mergedTopics);
      const { contextBlock, hasPersonalMemory } = buildContext({
        profile,
        episodes,
        semanticMemory: hamResult?.activeMemory ?? '',
        currentTopics: mergedTopics,
      });
      companionBlock = contextBlock;
      this.logger.debug(
        { hasPersonalMemory, episodeCount: episodes.length },
        'Companion context assembled',
      );
    } else if (hamResult?.activeMemory) {
      companionBlock = hamResult.activeMemory;
    }

    let systemPrompt = input.agentProfile?.systemPrompt
      ? `${CORE_SYSTEM_PROMPT}\n\n${input.agentProfile.systemPrompt}\n\n---\n\n${baseContext}`
      : `${CORE_SYSTEM_PROMPT}\n\n---\n\n${baseContext}`;

    if (companionBlock) {
      systemPrompt = `${companionBlock}\n\n---\n\n${systemPrompt}`;
    }

    if (hamResult) {
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

    // ── Multi-agent orchestration ─────────────────────────────────────────────
    // Run classifier only for non-trivial messages (skip for <20 chars, commands, etc.)
    // Determine if the user explicitly chose a model (vs auto-routing).
    // When explicit, the orchestrator and all sub-agents must respect it.
    const forceProvider = (parsedModel?.provider ?? input.forceModel) as LLMProvider | undefined;
    const isExplicitChoice =
      (forceProvider !== undefined && forceProvider !== 'auto') ||
      this.config.DEFAULT_MODEL !== 'auto' ||
      input.message.startsWith('cc:') ||
      input.message.startsWith('g:');
    const userModelChoice = isExplicitChoice ? provider as 'claude' | 'gemini' : undefined;

    let orchestratorHandled = false;
    if (cleanedMessage.length > 40 && !input.agentProfile) {
      for await (const event of this._orchestrator.run(cleanedMessage, input.conversationId, userModelChoice)) {
        if (event.type === 'classified') {
          if (event.complexity === 'simple') {
            // Fall through to standard single-agent path
            break;
          }
          // Complex — stream orchestration status via dedicated status chunks
          yield { type: 'status', content: 'Routing to specialist agents...' };
        } else if (event.type === 'decomposed') {
          yield { type: 'status', content: `Spawning ${event.taskCount} workers...` };
        } else if (event.type === 'worker_start') {
          yield { type: 'status', content: `[${event.workerType}] running...` };
        } else if (event.type === 'worker_done') {
          yield { type: 'status', content: `[${event.workerType}] done` };
        } else if (event.type === 'reducing') {
          yield { type: 'status', content: 'Synthesizing results...' };
        } else if (event.type === 'done') {
          if (event.result && event.result.length > 0) {
            // Persist synthesized result to conversation history
            fullResponse = event.result;
            this.memory.addMessage(input.conversationId, {
              conversationId: input.conversationId,
              role: 'assistant',
              content: fullResponse,
              model: 'orchestrator',
            });
            yield { type: 'text', content: event.result };
            yield { type: 'done' };
            orchestratorHandled = true;
          }
          break;
        }
      }
    }

    if (!orchestratorHandled) {
      if (provider === 'claude' && this._toolExecutor) {
        const messages: MessageParam[] = history
          .slice(0, -1) // exclude last user message
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }));
        messages.push({ role: 'user', content: cleanedMessage });
        
        yield* collectChunks(
          this._toolExecutor.runLoop(
            systemPrompt,
            messages,
            toolDefs,
            (text, tokens) => {
              this.memory.addMessage(input.conversationId, {
                conversationId: input.conversationId,
                role: 'assistant',
                content: text,
                model: 'claude',
                tokens,
              });
            }
          )
        );
      } else {
        yield* collectChunks(this.geminiStream(input.conversationId, history, systemPrompt, cleanedMessage, geminiVariant, input.useSearch));
      }
    }

    // Update HAM access stats after response
    if (hamResult?.usedChunkIds.length && this.hamStore) {
      for (const id of hamResult.usedChunkIds) {
        this.hamStore.updateAccessStats(id);
      }
    }

    // ── Profile extraction (async, non-blocking) ───────────────────────────
    if (this.profileExtractor && fullResponse) {
      this.profileExtractor.extractAsync(
        cleanedMessage,
        fullResponse,
        input.conversationId,
        'default',
      );
    }

    // ── L4 auto-save — cache factual responses worth storing ───────────────
    if (
      hamResult?.isMemoryMiss &&
      this.hamStore &&
      this.hamCompressor &&
      isWorthSaving(fullResponse, cleanedMessage)
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

  /** Extract simple topic keywords from a user message for episode boosting. */
  private extractTopics(message: string): string[] {
    return message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
      .slice(0, 6);
  }



  private async *geminiStream(
    conversationId: string,
    history: ReturnType<IMemoryStore['getMessages']>,
    systemPrompt: string,
    lastUserMessage: string,
    variant?: GeminiVariant,
    useSearch?: boolean,
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

    // Use search grounding when explicitly requested (ask command, research tasks)
    const stream = useSearch
      ? this.gemini.streamSearch(lastUserMessage, systemPrompt)
      : this.gemini.stream(geminiMessages, systemPrompt, variant ?? 'flash');

    for await (const chunk of stream) {
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
