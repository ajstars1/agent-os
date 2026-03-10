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
export { SkillLoader } from './skills/loader.js';
export { ToolRegistry } from './tools/registry.js';
export { MCPClient } from './tools/mcp-client.js';
export type { MCPServerConfig } from './tools/mcp-client.js';
export { registerBuiltinTools } from './tools/builtin.js';
export { AgentLoader } from './agents/loader.js';
export type { AgentProfile } from './agents/types.js';

import type { Config } from '@agent-os/shared';
import { ClaudeClient } from './llm/claude.js';
import { GeminiClient } from './llm/gemini.js';
import { LLMRouter } from './llm/router.js';
import { SQLiteMemoryStore } from './memory/sqlite.js';
import { TieredStore } from './memory/tiered-store.js';
import { HAMRetriever } from './memory/retriever.js';
import { HAMCompressor } from './memory/compressor.js';
import { ingestSkillsToHAM } from './memory/ham-skill-ingester.js';
import { SkillLoader } from './skills/loader.js';
import { ToolRegistry } from './tools/registry.js';
import { AgentEngine } from './engine.js';
import { AgentLoader } from './agents/loader.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { createLogger } from '@agent-os/shared';

export interface BootstrapResult {
  engine: AgentEngine;
  memory: SQLiteMemoryStore;
  skills: SkillLoader;
  tools: ToolRegistry;
  agents: AgentLoader;
  hamStore: TieredStore;
  hamCompressor: HAMCompressor | null;
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
  registerBuiltinTools(tools, logger, allowedDirs);

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

  // ── HAM memory layer ──────────────────────────────────────────────────────
  const hamStore = new TieredStore(config.DB_PATH);
  const hamRetriever = new HAMRetriever(hamStore);
  const hamCompressor = config.GOOGLE_API_KEY
    ? new HAMCompressor(config.GOOGLE_API_KEY, hamStore)
    : null;

  // Auto-ingest skills into HAM (only if Gemini available for compression)
  if (hamCompressor) {
    ingestSkillsToHAM(config.SKILLS_DIR, hamStore, hamCompressor, logger).catch((err: unknown) => {
      logger.warn({ err }, 'HAM skill ingestion failed');
    });
  }

  const engine = new AgentEngine(
    config, memory, skills, tools, claude, gemini, router, logger,
    hamRetriever, hamStore,
  );

  return { engine, memory, skills, tools, agents, hamStore, hamCompressor };
}
