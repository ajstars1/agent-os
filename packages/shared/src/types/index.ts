export type LLMProvider = 'claude' | 'gemini' | 'openrouter' | 'ollama' | 'auto';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type ChannelType = 'cli' | 'discord' | 'telegram' | 'slack' | 'whatsapp' | 'signal' | 'matrix' | 'email' | 'web';

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

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Estimated USD cost for this turn. */
  usdEstimate: number;
  /** Cumulative USD cost for the full session. */
  sessionUsdTotal: number;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'usage' | 'provider' | 'memory_saved' | 'done' | 'thinking' | 'status' | 'permission_request' | 'error' | 'hook_blocked';
  content?: string;
  provider?: LLMProvider;
  /** Resolved model label (e.g. 'gemini:flash-thinking', 'or:gpt-4o'). */
  model?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  cost?: SessionCost;
  permissionRequest?: {
    toolName: string;
    input: Record<string, unknown>;
    preview: string;
  };
}

export type PermissionDecision = 'allow' | 'always' | 'deny';
export type PermissionCallback = (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Config {
  ANTHROPIC_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  DISCORD_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SKILLS_DIR: string;
  CLAUDE_MD_PATH: string;
  DB_PATH: string;
  DEFAULT_MODEL: LLMProvider;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  NODE_ENV: 'development' | 'production' | 'test';
  WEB_PORT: number;
  WEB_CORS_ORIGIN: string;
  AGENTS_DIR: string;
  ALLOWED_DIRS?: string;
  NEURAL_ENGINE_URL: string;
  CONFIG_UI_PORT: number;
  /** Hooks loaded from settings.json. Not in .env — populated by loadSettings(). */
  hooks?: import('./hooks.js').HookBinding[];
}
