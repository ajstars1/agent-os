'use client';

import { useState, useCallback, useRef } from 'react';
import type { ChatMessage, AgentUpdate, ToolCallRecord, StreamEvent } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ─── Stable ID helpers ────────────────────────────────────────────────────────
let _idCounter = 0;
function makeId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter}-${Date.now()}`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseChatReturn {
  messages: ChatMessage[];
  workers: Map<string, AgentUpdate>;
  streaming: { content: string; provider: string; model: string } | null;
  isStreaming: boolean;
  sessionTokens: { input: number; output: number };
  conversationId: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  newConversation: () => void;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workers, setWorkers] = useState<Map<string, AgentUpdate>>(new Map());
  const [streaming, setStreaming] = useState<{ content: string; provider: string; model: string } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sessionTokens, setSessionTokens] = useState({ input: 0, output: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const workerClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setWorkers(new Map());
    setStreaming(null);
    setIsStreaming(false);
    setConversationId(null);
    setSessionTokens({ input: 0, output: 0 });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreaming(null);
  }, []);

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Optimistic user message
    const userMsg: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Stream state
    const abort = new AbortController();
    abortRef.current = abort;
    setIsStreaming(true);

    let acc = '';
    let provider = 'claude';
    let model = '';
    let convId = conversationId;
    let inputTokens = 0;
    let outputTokens = 0;
    const inflightTools = new Map<string, { name: string; preview: string; startedAt: number }>();
    const completedTools: ToolCallRecord[] = [];

    // Reset workers map for new turn
    if (workerClearTimer.current) clearTimeout(workerClearTimer.current);
    setWorkers(new Map());

    try {
      const reqBody: Record<string, unknown> = { message: trimmed };
      if (convId) reqBody.conversationId = convId;

      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE: split on double newline; each frame starts with "event: X\ndata: {...}"
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame.split('\n');
          let eventName = '';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;

          try {
            const evt = JSON.parse(data) as StreamEvent;
            const t = evt.type ?? eventName;

            if (t === 'provider') {
              if (evt.provider) provider = evt.provider;
              if (evt.model)    model = evt.model;
              setStreaming({ content: acc, provider, model });
            } else if (t === 'text' && evt.content) {
              acc += evt.content;
              setStreaming({ content: acc, provider, model });
            } else if (t === 'agent_update' && evt.agentUpdate) {
              const u = evt.agentUpdate;
              setWorkers((prev) => {
                const next = new Map(prev);
                next.set(u.agentId, u);
                return next;
              });
            } else if (t === 'tool_call' && evt.toolCall) {
              const tc = evt.toolCall;
              const preview = extractPreview(tc.input);
              inflightTools.set(tc.id, { name: tc.name, preview, startedAt: Date.now() });
            } else if (t === 'tool_result' && evt.toolResult) {
              const tr = evt.toolResult;
              const inflight = inflightTools.get(tr.toolCallId);
              if (inflight) {
                completedTools.push({
                  id: tr.toolCallId,
                  name: inflight.name,
                  preview: inflight.preview,
                  result: extractFirstLine(tr.content),
                  isError: tr.isError,
                  elapsedMs: Date.now() - inflight.startedAt,
                  startedAt: inflight.startedAt,
                  finishedAt: Date.now(),
                });
                inflightTools.delete(tr.toolCallId);
              }
            } else if (t === 'usage' && evt.usage) {
              inputTokens = evt.usage.inputTokens;
              outputTokens = evt.usage.outputTokens;
            } else if (t === 'done') {
              const cid = (JSON.parse(data) as { conversationId?: string }).conversationId;
              if (cid && cid !== convId) { convId = cid; setConversationId(cid); }
            }
          } catch {
            /* malformed SSE frame */
          }
        }
      }

      // Conversation ID from response header (fallback)
      const headerCid = res.headers.get('X-Conversation-Id');
      if (headerCid && !convId) { convId = headerCid; setConversationId(headerCid); }

    } catch (err) {
      if (!abort.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        acc = acc || `Error: ${msg}`;
      }
    } finally {
      // Commit assistant message
      if (acc) {
        setMessages((prev) => [...prev, {
          id: makeId('assistant'),
          role: 'assistant',
          content: acc,
          provider,
          model,
          createdAt: Date.now(),
          elapsedMs: undefined,
          toolCalls: completedTools.length > 0 ? completedTools : undefined,
        }]);
      }

      setSessionTokens((prev) => ({
        input:  prev.input + inputTokens,
        output: prev.output + outputTokens,
      }));

      // Hide workers after a delay
      workerClearTimer.current = setTimeout(() => setWorkers(new Map()), 900);

      setStreaming(null);
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, conversationId]);

  return {
    messages,
    workers,
    streaming,
    isStreaming,
    sessionTokens,
    conversationId,
    send,
    cancel,
    newConversation,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPreview(input: Record<string, unknown>): string {
  const keys = ['path', 'file_path', 'command', 'pattern', 'url', 'query', 'topic', 'old_string', 'goal'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 56 ? t.slice(0, 53) + '…' : t;
    }
  }
  return '';
}

function extractFirstLine(content: string): string {
  const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  const t = first.trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}
