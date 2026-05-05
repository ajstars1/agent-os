/**
 * Bridge client — typed HTTP client for the AgentOS bridge server.
 * Reads the bridge secret from disk and attaches it to every request.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

export interface BridgeStatus {
  ok: boolean;
  version: string;
  cwd: string;
  secretFile: string;
  ideContext: { file: string; language?: string; hasSelection: boolean; ageMs: number } | null;
}

export interface IDEContext {
  file?: string;
  language?: string;
  selection?: string;
  visibleRange?: string;
  workspaceRoot?: string;
}

export interface ChatResponse {
  conversationId: string;
  response: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type StreamChunkType = 'text' | 'tool_call' | 'tool_result' | 'usage' | 'provider' | 'status' | 'done' | 'error';

export interface StreamChunk {
  type: StreamChunkType;
  content?: string;
  provider?: string;
  model?: string;
}

export class BridgeClient {
  private secret: string | null = null;

  constructor(
    private baseUrl: string,
    private secretFilePath: string,
  ) {}

  private loadSecret(): string {
    if (this.secret) return this.secret;
    try {
      this.secret = fs.readFileSync(this.secretFilePath, 'utf-8').trim();
      return this.secret;
    } catch {
      throw new Error(`Bridge secret not found at ${this.secretFilePath}. Is AgentOS running?`);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.loadSecret()}`,
      'Content-Type': 'application/json',
    };
  }

  /** Forget cached secret so the next call re-reads from disk. */
  invalidateSecret(): void {
    this.secret = null;
  }

  async status(): Promise<BridgeStatus> {
    const res = await fetch(`${this.baseUrl}/bridge/status`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Bridge status check failed: ${res.status}`);
    return res.json() as Promise<BridgeStatus>;
  }

  async pushContext(ctx: IDEContext): Promise<void> {
    await fetch(`${this.baseUrl}/bridge/context`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(ctx),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async chat(message: string, conversationId?: string, includeFileContext = true): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/bridge/chat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ message, conversationId, includeFileContext }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Bridge chat failed: ${err}`);
    }
    return res.json() as Promise<ChatResponse>;
  }

  /**
   * Stream a chat request. Calls onChunk for each SSE event, resolves when done.
   * Uses Node's http/https module for streaming (fetch body streaming is not
   * available in all VS Code Node versions).
   */
  async streamChat(
    message: string,
    conversationId: string | undefined,
    includeFileContext: boolean,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const secret = this.loadSecret();
    const url = new URL(`${this.baseUrl}/bridge/stream`);
    const body = JSON.stringify({ message, conversationId, includeFileContext });
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${secret}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/event-stream',
          },
        },
        (res) => {
          let buf = '';
          let fullText = '';

          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as StreamChunk;
                onChunk(parsed);
                if (parsed.type === 'text' && parsed.content) fullText += parsed.content;
                if (parsed.type === 'done') {
                  res.destroy();
                  resolve(fullText);
                }
                if (parsed.type === 'error') {
                  reject(new Error(parsed.content ?? 'Bridge stream error'));
                }
              } catch {
                // Malformed SSE line — skip
              }
            }
          });

          res.on('end', () => resolve(fullText));
          res.on('error', reject);
        },
      );

      signal?.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ─── Default secret file path (mirrors packages/web/src/bridge-secret.ts) ────

export function defaultSecretPath(configured?: string): string {
  if (configured && configured.trim()) return configured;
  return path.join(os.homedir(), '.agent-os', '.bridge-secret');
}
