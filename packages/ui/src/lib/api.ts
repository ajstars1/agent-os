const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ConversationSummary {
  id: string;
  channel: string;
  channelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageItem {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  model?: string;
  tokens?: number;
  createdAt: string;
}

export interface ChunkSummary {
  id: string;
  topic: string;
  L0: string;
  tags: string[];
  accessCount: number;
  lastAccessed: number;
}

export interface ChunkDetail extends ChunkSummary {
  L1: string;
  L2: string;
  L3: string;
}

export interface StreamParams {
  message: string;
  conversationId?: string;
  agentName?: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore parse failure
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const data = await apiFetch<{ conversations: ConversationSummary[] }>('/conversations');
  return data.conversations;
}

export async function getMessages(convId: string): Promise<MessageItem[]> {
  const data = await apiFetch<{ messages: MessageItem[] }>(`/conversations/${convId}/messages`);
  return data.messages;
}

export async function listChunks(): Promise<ChunkSummary[]> {
  const data = await apiFetch<{ chunks: ChunkSummary[] }>('/memory/chunks');
  return data.chunks;
}

export async function getChunk(id: string): Promise<ChunkDetail> {
  const data = await apiFetch<{ chunk: ChunkDetail }>(`/memory/chunks/${id}`);
  return data.chunk;
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/conversations/${id}`, { method: 'DELETE' });
}

export function streamChat(
  params: StreamParams,
  onChunk: (content: string) => void,
  onDone: (conversationId: string, provider: string) => void,
  onError: (err: Error) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (!res.ok) {
        let message = `Stream error ${res.status}`;
        try {
          const body = await res.json() as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        onError(new Error(message));
        return;
      }

      if (!res.body) {
        onError(new Error('No response body'));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as {
              type: 'chunk' | 'done';
              content?: string;
              conversationId?: string;
              provider?: string;
            };
            if (parsed.type === 'chunk' && parsed.content) {
              onChunk(parsed.content);
            } else if (parsed.type === 'done') {
              onDone(parsed.conversationId ?? '', parsed.provider ?? 'claude');
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => controller.abort();
}
