import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolResult, Logger } from '@agent-os/shared';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly name: string,
    private readonly config: MCPServerConfig,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    const proc = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.process = proc;

    if (!proc.stdout) {
      throw new Error(`MCP server ${this.name} has no stdout`);
    }

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          handler.resolve(msg.result);
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    proc.on('exit', (code) => {
      this.logger.warn({ server: this.name, code }, 'MCP server process exited');
      for (const [, handler] of this.pending) {
        handler.reject(new Error(`MCP server ${this.name} exited`));
      }
      this.pending.clear();
    });

    // MCP handshake
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-os', version: '0.1.0' },
    });
    this.sendNotification('notifications/initialized', {});
    this.logger.info({ server: this.name }, 'MCP server connected');
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.call('tools/list', {});
    const tools = (result as { tools?: MCPToolSchema[] }).tools ?? [];
    return tools.map((t) => ({
      name: `${this.name}__${t.name}`,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    // Strip server prefix from tool name for the actual MCP call
    const actualName = name.startsWith(`${this.name}__`)
      ? name.slice(`${this.name}__`.length)
      : name;

    try {
      const result = await this.call('tools/call', { name: actualName, arguments: input });
      const content = JSON.stringify(result);
      return { toolCallId: '', content, isError: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { toolCallId: '', content: message, isError: true };
    }
  }

  disconnect(): void {
    this.process?.kill();
    this.process = null;
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, { resolve, reject });
      this.process?.stdin?.write(JSON.stringify(req) + '\n');
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = { jsonrpc: '2.0', method, params };
    this.process?.stdin?.write(JSON.stringify(msg) + '\n');
  }
}
