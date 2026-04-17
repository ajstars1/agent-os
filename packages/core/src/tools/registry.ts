import { readFileSync, existsSync } from 'node:fs';
import type { ToolDefinition, ToolResult, Logger } from '@agent-os-core/shared';
import { MCPClient, type MCPServerConfig } from './mcp-client.js';

interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>;
}

type BuiltinHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly clients = new Map<string, MCPClient>();
  private readonly handlers = new Map<string, BuiltinHandler>();

  constructor(private readonly logger: Logger) {}

  /** Register a built-in tool with an inline handler (no MCP process needed) */
  register(definition: ToolDefinition, handler: BuiltinHandler): void {
    this.tools.set(definition.name, definition);
    this.handlers.set(definition.name, handler);
  }

  async loadFromMCPConfig(mcpConfigPath: string): Promise<void> {
    if (!existsSync(mcpConfigPath)) {
      this.logger.info({ path: mcpConfigPath }, 'No MCP config found, skipping tool loading');
      return;
    }

    let config: MCPConfig;
    try {
      const raw = readFileSync(mcpConfigPath, 'utf-8');
      config = JSON.parse(raw) as MCPConfig;
    } catch (err: unknown) {
      this.logger.warn({ err, path: mcpConfigPath }, 'Failed to parse MCP config');
      return;
    }

    const servers = config.mcpServers ?? {};
    for (const [name, serverConfig] of Object.entries(servers)) {
      try {
        const client = new MCPClient(name, serverConfig, this.logger);
        await client.connect();
        const tools = await client.listTools();
        for (const tool of tools) {
          this.tools.set(tool.name, tool);
        }
        this.clients.set(name, client);
        this.logger.info({ server: name, toolCount: tools.length }, 'MCP tools loaded');
      } catch (err: unknown) {
        this.logger.debug({ err, server: name }, 'Failed to connect MCP server');
      }
    }
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    // Check built-in handlers first
    const handler = this.handlers.get(name);
    if (handler) return handler(input);

    // Find which MCP client owns this tool (by prefix)
    const serverName = name.split('__')[0];
    const client = this.clients.get(serverName ?? '');

    if (!client) {
      return {
        toolCallId: '',
        content: `No handler found for tool: ${name}`,
        isError: true,
      };
    }

    return client.callTool(name, input);
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.tools.clear();
  }
}
