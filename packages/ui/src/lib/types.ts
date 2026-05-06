// Shared types used across the v3 UI

export type AgentStatus = 'thinking' | 'planning' | 'running' | 'waiting' | 'done' | 'error';

export interface AgentUpdate {
  agentId: string;
  label: string;
  status: AgentStatus;
  task?: string;
  tool?: string;
  toolPreview?: string;
  iteration: number;
  maxIterations: number;
  elapsedMs: number;
  note?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  preview: string;
  result?: string;
  isError?: boolean;
  elapsedMs?: number;
  startedAt: number;
  finishedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  createdAt: number;
  elapsedMs?: number;
  /** Tool calls executed during this assistant message */
  toolCalls?: ToolCallRecord[];
}

export type StreamEventType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'agent_update'
  | 'usage'
  | 'provider'
  | 'memory_saved'
  | 'status'
  | 'thinking'
  | 'error'
  | 'done';

export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  provider?: string;
  model?: string;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { toolCallId: string; content: string; isError?: boolean };
  agentUpdate?: AgentUpdate;
  usage?: { inputTokens: number; outputTokens: number };
}
