export type LLMProvider = 'claude' | 'gemini' | 'auto';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type ChannelType = 'cli' | 'discord' | 'whatsapp' | 'web';

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  model?: string;
  tokens?: number;
  createdAt: string;
}

export interface Conversation {
  id: string;
  channel: ChannelType;
  channelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfig {
  name: string;
  systemPrompt?: string;
  defaultModel: LLMProvider;
  skills: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'usage' | 'provider' | 'memory_saved' | 'done' | 'thinking';
  content?: string;
  provider?: LLMProvider;
  /** Resolved Gemini variant (e.g. 'gemini:flash-thinking') when auto-routing selects one. */
  model?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Config {
  ANTHROPIC_API_KEY: string;
  GOOGLE_API_KEY?: string;
  DISCORD_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  SKILLS_DIR: string;
  CLAUDE_MD_PATH: string;
  DB_PATH: string;
  DEFAULT_MODEL: LLMProvider;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  NODE_ENV: 'development' | 'production' | 'test';
  // Phase 2 additions
  WEB_PORT: number;
  WEB_CORS_ORIGIN: string;
  AGENTS_DIR: string;
  ALLOWED_DIRS?: string;
  NEURAL_ENGINE_URL: string;
}
