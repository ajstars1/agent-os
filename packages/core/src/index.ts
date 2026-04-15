export { AgentEngine } from './engine.js';
export type { EngineInput } from './engine.js';
export { ClaudeClient } from './llm/claude.js';
export { GeminiClient } from './llm/gemini.js';
export type { GeminiMessage } from './llm/gemini.js';
export { LLMRouter } from './llm/router.js';
export type { IClassifier } from './llm/router.js';
export type { IMemoryStore } from './memory/interface.js';
export { SQLiteMemoryStore } from './memory/sqlite.js';
export { TieredStore } from './memory/tiered-store.js';
export type { KnowledgeChunk, L0Entry } from './memory/tiered-store.js';
export { StateRouter } from './memory/state-router.js';
export type { ConversationState, RetrievalDepth } from './memory/state-router.js';
export { HAMRetriever } from './memory/retriever.js';
export type { RetrievalResult } from './memory/retriever.js';
export { HAMCompressor } from './memory/compressor.js';
export { ingestSkillsToHAM } from './memory/ham-skill-ingester.js';
export { EpisodicStore } from './memory/episodic-store.js';
export type { Episode, EpisodeTone } from './memory/episodic-store.js';
export { UserProfileStore } from './memory/user-profile-store.js';
export type { UserProfile, UserProject, PartialUserProfile } from './memory/user-profile-store.js';
export { ProfileExtractor } from './memory/profile-extractor.js';
export { buildContext } from './memory/context-builder.js';
export type { ContextInput, BuiltContext } from './memory/context-builder.js';
export { SkillLoader } from './skills/loader.js';
export { SkillRecommender } from './skills/recommender.js';
export type { SkillSuggestion } from './skills/recommender.js';
export { ToolRegistry } from './tools/registry.js';
export { MCPClient } from './tools/mcp-client.js';
export type { MCPServerConfig } from './tools/mcp-client.js';
export { registerBuiltinTools } from './tools/builtin.js';
export { AgentLoader } from './agents/loader.js';
export type { AgentProfile } from './agents/types.js';
export { TaskQueue } from './agents/task-queue.js';
export type { Task, TaskType, TaskStatus } from './agents/task-queue.js';
export { WorkerAgent } from './agents/worker.js';
export type { WorkerConfig, WorkerResult } from './agents/worker.js';
export { Orchestrator } from './agents/orchestrator.js';
export type { OrchestratorEvent, RequestComplexity, SubTask } from './agents/orchestrator.js';
export { ResearchAgent } from './agents/specialists/research.js';
export { CodeAgent } from './agents/specialists/code.js';
export { PlannerAgent } from './agents/specialists/planner.js';
export { LearnerClient } from './memory/learner-client.js';
export type { Prediction, HotTopic, LearnerWarmup } from './memory/learner-client.js';

import type { Config } from '@agent-os/shared';
import { ClaudeClient } from './llm/claude.js';
import { GeminiClient } from './llm/gemini.js';
import { LLMRouter } from './llm/router.js';
import { SQLiteMemoryStore } from './memory/sqlite.js';
import { TieredStore } from './memory/tiered-store.js';
import { HAMRetriever } from './memory/retriever.js';
import { HAMCompressor } from './memory/compressor.js';
import { ingestSkillsToHAM } from './memory/ham-skill-ingester.js';
import { EpisodicStore } from './memory/episodic-store.js';
import { UserProfileStore } from './memory/user-profile-store.js';
import { ProfileExtractor } from './memory/profile-extractor.js';
import { SkillLoader } from './skills/loader.js';
import { ToolRegistry } from './tools/registry.js';
import { AgentEngine } from './engine.js';
import { AgentLoader } from './agents/loader.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { createLogger } from '@agent-os/shared';
import { NeuralClient } from './memory/neural-client.js';
import { LearnerClient } from './memory/learner-client.js';
import { join, dirname } from 'node:path';

/** Derive episodic/profile DB path alongside the main DB. */
function companionDbPath(mainDbPath: string): string {
  const dir = dirname(mainDbPath);
  return join(dir, 'companion.db');
}

export interface BootstrapResult {
  engine: AgentEngine;
  memory: SQLiteMemoryStore;
  skills: SkillLoader;
  tools: ToolRegistry;
  agents: AgentLoader;
  hamStore: TieredStore;
  hamCompressor: HAMCompressor | null;
  episodicStore: EpisodicStore;
  userProfileStore: UserProfileStore;
  learnerClient: LearnerClient;
}

export async function bootstrap(config: Config): Promise<BootstrapResult> {
  const logger = createLogger('agent-os', config.LOG_LEVEL);

  const memory = new SQLiteMemoryStore(config.DB_PATH);

  const skills = new SkillLoader(config.SKILLS_DIR, config.CLAUDE_MD_PATH, logger);
  await skills.load();
  skills.startWatching();

  const tools = new ToolRegistry(logger);

  const allowedDirs = config.ALLOWED_DIRS
    ? config.ALLOWED_DIRS.split(':').filter(Boolean)
    : [];

  // ── HAM memory layer ──────────────────────────────────────────────────────
  const hamStore = new TieredStore(config.DB_PATH);
  const neuralClient = new NeuralClient(config.NEURAL_ENGINE_URL);
  const hamRetriever = new HAMRetriever(hamStore, neuralClient);
  const hamCompressor = config.GOOGLE_API_KEY
    ? new HAMCompressor(config.GOOGLE_API_KEY, hamStore)
    : null;

  registerBuiltinTools(tools, logger, allowedDirs, hamStore, hamCompressor ?? undefined);

  try {
    await tools.loadFromMCPConfig('./.mcp.json');
  } catch (err: unknown) {
    logger.warn({ err }, 'Failed to load MCP config');
  }

  const claude = new ClaudeClient(config.ANTHROPIC_API_KEY);
  const gemini = config.GOOGLE_API_KEY ? new GeminiClient(config.GOOGLE_API_KEY) : null;
  const router = new LLMRouter(gemini, config.DEFAULT_MODEL);

  const agents = new AgentLoader(config.AGENTS_DIR, logger);
  await agents.load();

  // ── Companion memory layer ────────────────────────────────────────────────
  const compDbPath = companionDbPath(config.DB_PATH);
  const episodicStore = new EpisodicStore(compDbPath);
  const userProfileStore = new UserProfileStore(compDbPath);

  // ── Background learner warmup ─────────────────────────────────────────────
  // Reads predictions/hot-topics written by the Python bg_learner daemon.
  // If the learner hasn't run yet (first boot), returns empty — no crash.
  const learnerClient = new LearnerClient(compDbPath);
  const learnerWarmup = learnerClient.warmup();
  const learnerTopics = learnerClient.getContextTopics(learnerWarmup);
  if (learnerWarmup.hasData) {
    logger.info(
      { predictions: learnerWarmup.predictions.length, hotTopics: learnerWarmup.hotTopics.length },
      'Learner warmup complete',
    );
  }

  // Increment session count each bootstrap (= each CLI/Discord session)
  userProfileStore.recordSession();

  const profileExtractor = config.GOOGLE_API_KEY
    ? new ProfileExtractor(config.GOOGLE_API_KEY, userProfileStore, episodicStore)
    : undefined;

  // Auto-ingest skills into HAM (only if Gemini available for compression)
  if (hamCompressor) {
    ingestSkillsToHAM(config.SKILLS_DIR, hamStore, hamCompressor, logger).catch((err: unknown) => {
      logger.warn({ err }, 'HAM skill ingestion failed');
    });
  }

  const engine = new AgentEngine(
    config, memory, skills, tools, claude, gemini, router, logger,
    hamRetriever, hamStore, hamCompressor,
    undefined,              // semanticGraph (uses default)
    episodicStore,
    userProfileStore,
    profileExtractor,
    learnerTopics,          // pre-loaded hot topics from bg learner
  );

  return { engine, memory, skills, tools, agents, hamStore, hamCompressor, episodicStore, userProfileStore, learnerClient };
}
