import type { StreamChunk, LLMProvider, ChannelType, Conversation, Config } from '@agent-os/shared';
import type { IMemoryStore } from './memory/interface.js';
import type { SkillLoader } from './skills/loader.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ClaudeClient } from './llm/claude.js';
import type { GeminiClient } from './llm/gemini.js';
import type { LLMRouter } from './llm/router.js';
import type { Logger } from '@agent-os/shared';
import type { AgentProfile } from './agents/types.js';
import type { HAMRetriever } from './memory/retriever.js';
import type { TieredStore } from './memory/tiered-store.js';
export interface EngineInput {
    conversationId: string;
    message: string;
    forceModel?: LLMProvider;
    agentProfile?: AgentProfile;
}
export declare class AgentEngine {
    private readonly config;
    private readonly memory;
    private readonly skills;
    private readonly tools;
    private readonly claude;
    private readonly gemini;
    private readonly router;
    private readonly logger;
    private readonly hamRetriever?;
    private readonly hamStore?;
    constructor(config: Config, memory: IMemoryStore, skills: SkillLoader, tools: ToolRegistry, claude: ClaudeClient, gemini: GeminiClient | null, router: LLMRouter, logger: Logger, hamRetriever?: HAMRetriever | undefined, hamStore?: TieredStore | undefined);
    getOrCreateConversation(channel: ChannelType, channelId: string): Conversation;
    clearConversation(conversationId: string): void;
    chat(input: EngineInput): AsyncGenerator<StreamChunk>;
    private claudeLoop;
    private geminiStream;
}
//# sourceMappingURL=engine.d.ts.map