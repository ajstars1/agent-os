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
import { estimateCost } from '@agent-os-core/shared';
import { HookRunner } from './hooks/index.js';
import { delegateTask, batchDelegate, getActiveSubagents } from './agents/delegate.js';
import { searchAndSummarise } from './memory/fts5.js';
import { getUserModelBlock, handleUserModelTool, extractAndUpdateUserModel } from './memory/user-model.js';
import { compressHistory, getContextLimit } from './memory/context-compressor.js';
import { shouldRunCurator, runCurator } from './skills/curator.js';

// Browser tools — optional, loaded only if @agent-os-core/browser is installed
let _browserHandlers: Record<string, (i: Record<string, unknown>) => Promise<import('@agent-os-core/shared').ToolResult>> | null = null;
let _browserDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | null = null;

async function tryLoadBrowser(): Promise<void> {
  try {
    const mod = await import('@agent-os-core/browser' as string);
    _browserHandlers = mod.BROWSER_HANDLERS as typeof _browserHandlers;
    _browserDefs = mod.BROWSER_TOOL_DEFINITIONS as typeof _browserDefs;
  } catch {
    // Browser package not installed — browser tools unavailable
  }
}
import type { IMemoryStore } from './memory/interface.js';
import type { SkillLoader } from './skills/loader.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ClaudeClient } from './llm/claude.js';
import type { GeminiClient, GeminiVariant } from './llm/gemini.js';
import type { LLMRouter, RoutedProvider } from './llm/router.js';
import type { OpenRouterClient } from './llm/openrouter.js';
import type { OllamaClient } from './llm/ollama.js';
import type { UnifiedMessage } from './llm/base.js';
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
import { TodoStore, TODO_TOOL_DEFINITION, makeTodoHandler } from './tools/todo.js';
import { maybeAutoTitle } from './memory/title-generator.js';
import { handleAnalyzeImage, handleDescribeScreenshot, VISION_TOOL_DEFINITIONS } from './tools/vision.js';
import { handleGenerateImage, IMAGEGEN_TOOL_DEFINITION } from './tools/imagegen.js';

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
  private readonly _todoStore: TodoStore;
  private readonly _hooks: HookRunner;
  /** Cumulative USD cost for this engine instance (session). */
  private _sessionCostUsd = 0;

  constructor(
    private readonly config: Config,
    private readonly memory: IMemoryStore,
    private readonly skills: SkillLoader,
    private readonly tools: ToolRegistry,
    private readonly claude: ClaudeClient | null,
    private readonly gemini: GeminiClient | null,
    private readonly router: LLMRouter,
    private readonly openrouter: OpenRouterClient | null = null,
    private readonly ollama: OllamaClient | null = null,
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
    this._todoStore = new TodoStore();
    this._hooks = new HookRunner(config.hooks ?? [], logger);

    // Async browser tool registration (non-blocking)
    tryLoadBrowser().then(() => {
      if (_browserHandlers && _browserDefs) {
        for (const def of _browserDefs) {
          const handler = _browserHandlers[def.name];
          if (handler) {
            tools.register(def as import('@agent-os-core/shared').ToolDefinition, handler);
          }
        }
        logger.info('[Engine] Browser tools registered');
      }
    }).catch(() => {});

    // ToolExecutor is now generalized — we can create it dynamically or keep one for each
    if (claude) {
      this._toolExecutor = new ToolExecutor(claude, tools, logger, this._hooks);
    } else if (gemini) {
      this._toolExecutor = new ToolExecutor(gemini, tools, logger, this._hooks);
    }

    this.taskRegistry = new TaskRegistry();
    this.planningManager = new PlanningManager(this.taskRegistry, logger);

    this._semanticGraph = semanticGraph ?? new SemanticGraph({
      llm: {
        complete: async (systemPrompt: string, userPrompt: string) => {
          const useGemini =
            gemini !== null &&
            (config.DEFAULT_MODEL === 'gemini' ||
              (config.DEFAULT_MODEL === 'auto' && (await router.route(userPrompt)) === 'gemini'));

          let text = '';
          if (useGemini && gemini) {
            for await (const chunk of gemini.stream([{ role: 'user', content: userPrompt }], systemPrompt)) {
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

    // Register todo tool
    this.tools.register(TODO_TOOL_DEFINITION, makeTodoHandler(this._todoStore));

    // Register session search tool
    this.tools.register(
      {
        name: 'session_search',
        description: `Search across all past conversations for relevant information.
Use when the user asks "what did we work on last week?", "do you remember when we discussed X?",
or any question referencing past sessions.
Returns a summary of the most relevant past messages.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for in conversation history' },
            role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter by message role (optional)' },
            matchCount: { type: 'number', description: 'Max results to retrieve (default 10)', default: 10 },
          },
          required: ['query'],
        },
      },
      async (input) => {
        if (!this.episodicStore) {
          return { toolCallId: '', content: 'Session search not available (no episodic store)', isError: true };
        }
        try {
          // Access the underlying SQLite DB through the episodic store
          const db = (this.episodicStore as unknown as { db: import('better-sqlite3').Database }).db;
          if (!db) return { toolCallId: '', content: 'Session search not available', isError: true };
          const result = await searchAndSummarise(db, String(input['query']), {
            role: input['role'] as 'user' | 'assistant' | undefined,
            matchCount: typeof input['matchCount'] === 'number' ? input['matchCount'] : 10,
            anthropicKey: this.config.ANTHROPIC_API_KEY,
          });
          return {
            toolCallId: '',
            content: `${result.summary}\n\n(${result.matchCount} messages matched "${result.query}")`,
            isError: false,
          };
        } catch (err) {
          return { toolCallId: '', content: String(err), isError: true };
        }
      },
    );

    // Register user profile tool
    this.tools.register(
      {
        name: 'user_profile',
        description: `Read or update the persistent user profile (USER.md).
Use to remember long-term facts about the user: their role, preferences, active projects, frustrations.
These facts persist across ALL sessions — not just the current conversation.`,
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['read', 'add', 'replace', 'remove'],
              description: 'read: show profile | add: add fact | replace: update fact | remove: delete fact',
            },
            key: { type: 'string', description: 'Fact key (e.g. "Current project", "Preferred stack")' },
            value: { type: 'string', description: 'Fact value (for add/replace actions)' },
          },
          required: ['action'],
        },
      },
      (input) => {
        const result = handleUserModelTool(
          input['action'] as 'read' | 'add' | 'replace' | 'remove',
          input['key'] as string | undefined,
          input['value'] as string | undefined,
        );
        return Promise.resolve({ toolCallId: '', ...result });
      },
    );

    // Register delegation tools (subagent spawning)
    this.tools.register(
      {
        name: 'delegate_task',
        description: `Spawn an isolated subagent to handle a specific goal in parallel.
The subagent gets a fresh context, a restricted toolset, and works autonomously.
Use this to:
- Research while coding ("research X, then I'll implement it")
- Run multiple independent tasks in parallel
- Isolate risky or exploratory work from the main context

Returns the subagent's full output when complete.`,
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'Clear, specific goal for the subagent' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent may use (empty = all safe tools)',
            },
            maxIterations: {
              type: 'number',
              description: 'Max tool-call iterations (default 20, max 40)',
              default: 20,
            },
          },
          required: ['goal'],
        },
      },
      async (input) => {
        const client = this.claude ?? this.gemini;
        if (!client) return { toolCallId: '', content: 'No LLM client configured', isError: true };
        return delegateTask(
          {
            goal: String(input['goal']),
            tools: Array.isArray(input['tools']) ? input['tools'].map(String) : [],
            maxIterations: typeof input['maxIterations'] === 'number' ? Math.min(40, input['maxIterations']) : 20,
          },
          client,
          this.tools,
          this.logger,
        );
      },
    );

    this.tools.register(
      {
        name: 'batch_delegate',
        description: `Spawn multiple subagents in parallel, each with its own goal.
Returns all results combined when every agent completes.
Use when you have 2-10 independent tasks that can run concurrently.`,
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Array of { goal, tools? } objects (max 10)',
              items: {
                type: 'object',
                properties: {
                  goal: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                },
                required: ['goal'],
              },
            },
            maxIterations: { type: 'number', default: 20 },
          },
          required: ['tasks'],
        },
      },
      async (input) => {
        const client = this.claude ?? this.gemini;
        if (!client) return { toolCallId: '', content: 'No LLM client configured', isError: true };
        const tasks = Array.isArray(input['tasks'])
          ? (input['tasks'] as Array<{ goal: string; tools?: string[] }>)
          : [];
        return batchDelegate(
          { tasks, maxIterations: typeof input['maxIterations'] === 'number' ? input['maxIterations'] : 20 },
          client,
          this.tools,
          this.logger,
        );
      },
    );

    // Register planning tools
    this.tools.register({
      name: 'propose_plan',
      description: 'Propose an implementation plan for a complex task. This will enter Planning Mode and wait for user approval.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Clear title for the implementation plan' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Detailed steps of the plan' },
        },
        required: ['title', 'steps'],
      },
    }, async (input) => {
      const plan = this.planningManager.enterPlanMode(input.title as string, input.steps as string[]);
      return {
        toolCallId: '',
        content: `Plan proposed: "${plan.title}" with ${plan.subtasks.length} steps. Waiting for user approval (type "Approve" or "Reject").`,
        isError: false,
      };
    });

    // Register vision tools
    const anthropicKey = this.config.ANTHROPIC_API_KEY;
    for (const def of VISION_TOOL_DEFINITIONS) {
      const defCopy = def;
      this.tools.register(defCopy as import('@agent-os-core/shared').ToolDefinition, (input) => {
        if (defCopy.name === 'analyze_image') return handleAnalyzeImage(input as Record<string, unknown>, anthropicKey);
        return handleDescribeScreenshot(input as Record<string, unknown>, anthropicKey);
      });
    }

    // Register image generation tool
    this.tools.register(IMAGEGEN_TOOL_DEFINITION as import('@agent-os-core/shared').ToolDefinition, handleGenerateImage);
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
      this.logger.info('[SleepCycle] Complete — memory pruned and facts consolidated.');
    } finally {
      this._sleepRunning = false;
    }
  }

  /** Expose the hook runner so tool executors can call toolUsePre/Post hooks. */
  get hooks(): HookRunner { return this._hooks; }

  /** Current session cumulative cost (USD). */
  get sessionCostUsd(): number { return this._sessionCostUsd; }

  /** Number of currently active subagents (for UI display). */
  get activeSubagentCount(): number { return getActiveSubagents().length; }

  async *chat(input: EngineInput): AsyncGenerator<StreamChunk> {
    // Reset the idle timer on every user message so the sleep cycle only fires
    // after a genuine period of inactivity.
    this.resetIdleTimer(input.conversationId);

    // Fire messageReceived hook
    const msgHook = await this._hooks.fire('messageReceived', { message: input.message });
    if (msgHook.promptAddition) {
      input = { ...input, message: `${msgHook.promptAddition}\n\n${input.message}` };
    }

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

    // Extract inline model if present (e.g. "or:gpt-4o ..." → orModel="gpt-4o")
    const inlineModel = this.router.extractInlineModel(input.message);
    const cleanedMessage = this.router.stripPrefix(input.message);
    const parsedModel = this.router.parseForceModel((input.forceModel ?? input.agentProfile?.defaultModel) as string | undefined);
    const provider = await this.router.route(input.message, (parsedModel?.provider ?? input.forceModel) as LLMProvider | undefined) as RoutedProvider;

    // Carry inline model through to client options
    const orModel = inlineModel.orModel ?? parsedModel?.orModel;
    const olModel = inlineModel.olModel ?? parsedModel?.olModel;

    // Auto-select Gemini variant when none is explicitly specified
    let geminiVariant = parsedModel?.variant;
    if (provider === 'gemini' && !geminiVariant && this.gemini) {
      geminiVariant = this.gemini.classifyVariant(cleanedMessage);
      this.logger.debug({ variant: geminiVariant }, 'Gemini auto-variant selected');
    }

    // Emit provider + resolved model so the UI can show which variant is running
    const resolvedModel = provider === 'gemini' ? `gemini:${geminiVariant ?? 'flash'}`
      : provider === 'openrouter' ? `or:${orModel ?? 'gpt-4o-mini'}`
      : provider === 'ollama' ? `ol:${olModel ?? 'llama3.2'}`
      : 'claude';
    yield { type: 'provider', provider, model: resolvedModel };

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
    const CORE_SYSTEM_PROMPT = `You are the cognitive generator for AgentOS — a personal AI companion, not a generic assistant. You remember who the user is, what they're building, and what has happened between you. When provided with companion memory below, treat it as verified personal context and reference it naturally. Use first-person pronouns (I/me/my) as referring to the user, not yourself.

Current working directory: ${process.cwd()}

When working with files:
- Always use absolute paths with the read_file, write_file, and edit tools
- Use read_file before editing any existing file — the edit tool requires it
- Use glob or grep to find files when you don't know the exact path
- Prefer edit over write_file for modifying existing files`;
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

    // Inject USER.md snapshot (frozen — doesn't change mid-session, preserves prefix cache)
    const userModelBlock = getUserModelBlock();

    let systemPrompt = input.agentProfile?.systemPrompt
      ? `${CORE_SYSTEM_PROMPT}\n\n${input.agentProfile.systemPrompt}\n\n---\n\n${baseContext}`
      : `${CORE_SYSTEM_PROMPT}\n\n---\n\n${baseContext}`;

    if (companionBlock) {
      systemPrompt = `${companionBlock}\n\n---\n\n${systemPrompt}`;
    }

    if (userModelBlock) {
      systemPrompt = `${userModelBlock}\n\n---\n\n${systemPrompt}`;
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
      input.message.startsWith('g:') ||
      input.message.startsWith('or:') ||
      input.message.startsWith('ol:');
    // Orchestrator only understands claude/gemini — for or:/ol: fall back to claude path
    const userModelChoice = isExplicitChoice
      ? (provider === 'openrouter' || provider === 'ollama' ? 'claude' : provider as 'claude' | 'gemini')
      : undefined;

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
      // Select the appropriate LLM client
      const client =
        provider === 'gemini' ? this.gemini
        : provider === 'openrouter' ? this.openrouter
        : provider === 'ollama' ? this.ollama
        : this.claude;

      if (client) {
        const executor = new ToolExecutor(client, this.tools, this.logger, this._hooks);
        let unifiedMessages: UnifiedMessage[] = history
          .slice(0, -1)
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }));
        unifiedMessages.push({ role: 'user', content: cleanedMessage });

        // Context compression — shrink history if approaching model limit
        const contextLimitKey = provider === 'gemini' ? `gemini:${geminiVariant ?? 'flash'}`
          : provider === 'openrouter' || provider === 'ollama' ? 'claude' // use Claude limit as proxy
          : 'claude';
        const contextLimit = getContextLimit(contextLimitKey);
        const { messages: compressed, result: compressionResult } = await compressHistory(
          unifiedMessages,
          contextLimit,
          this.logger,
          this.config.GOOGLE_API_KEY,
        );
        if (compressionResult.compressed) {
          unifiedMessages = compressed;
          yield { type: 'status', content: `Context compressed: saved ~${compressionResult.savedTokens} tokens` };
        }

        // Build extra options for OR/OL model selection
        const llmOptions: Record<string, unknown> =
          provider === 'gemini' ? { variant: geminiVariant, useSearch: input.useSearch }
          : provider === 'openrouter' ? { orModel }
          : provider === 'ollama' ? { olModel }
          : {};

        yield* collectChunks(
          executor.runLoop(
            systemPrompt,
            unifiedMessages,
            toolDefs,
            (text, tokens) => {
              this.memory.addMessage(input.conversationId, {
                conversationId: input.conversationId,
                role: 'assistant',
                content: text,
                model: provider,
                tokens,
              });
            },
            llmOptions,
          )
        );
      } else {
        const hint = provider === 'openrouter' ? ' (set OPENROUTER_API_KEY)'
          : provider === 'ollama' ? ' (run: ollama serve)'
          : '';
        yield { type: 'error', content: `${provider} client not configured.${hint}` };
      }
    }

    // ── Auto-title: generate a short conversation title after first exchange ──
    if (fullResponse && this.memory.setTitle) {
      const titleStore = {
        setTitle: (id: string, t: string) => this.memory.setTitle!(id, t),
        getTitle: (id: string) => this.memory.getTitle?.(id) ?? null,
      };
      maybeAutoTitle(
        titleStore,
        input.conversationId,
        cleanedMessage,
        fullResponse,
        history.length,
        this.logger,
        this.config.ANTHROPIC_API_KEY,
      );
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

    // ── responseDone hook ─────────────────────────────────────────────────
    this._hooks.fire('responseDone', { message: fullResponse }).catch(() => {});

    // ── USER.md async extraction (non-blocking) ────────────────────────────
    if (fullResponse && this.config.ANTHROPIC_API_KEY) {
      extractAndUpdateUserModel(cleanedMessage, fullResponse, this.logger, this.config.ANTHROPIC_API_KEY)
        .catch(() => {});
    }

    // ── Skill curator idle check ───────────────────────────────────────────
    if (shouldRunCurator(Date.now() - 3 * 60 * 60 * 1000)) { // if last activity > 3h ago
      runCurator({
        anthropicKey: this.config.ANTHROPIC_API_KEY,
        logger: this.logger,
      }).catch(() => {});
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
    // This method is now effectively deprecated as chat() handles both providers
    // via ToolExecutor. We'll leave a stub or remove if unused elsewhere.
    if (!this.gemini) return;
    
    for await (const chunk of this.gemini.stream(
      [{ role: 'user', content: lastUserMessage }],
      systemPrompt,
      [],
      { variant }
    )) {
      yield chunk;
    }
  }
}
