import { readFileSync, existsSync } from 'node:fs';
import { MCPClient } from './mcp-client.js';
export class ToolRegistry {
    logger;
    tools = new Map();
    clients = new Map();
    handlers = new Map();
    constructor(logger) {
        this.logger = logger;
    }
    /** Register a built-in tool with an inline handler (no MCP process needed) */
    register(definition, handler) {
        this.tools.set(definition.name, definition);
        this.handlers.set(definition.name, handler);
    }
    async loadFromMCPConfig(mcpConfigPath) {
        if (!existsSync(mcpConfigPath)) {
            this.logger.info({ path: mcpConfigPath }, 'No MCP config found, skipping tool loading');
            return;
        }
        let config;
        try {
            const raw = readFileSync(mcpConfigPath, 'utf-8');
            config = JSON.parse(raw);
        }
        catch (err) {
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
            }
            catch (err) {
                this.logger.warn({ err, server: name }, 'Failed to connect MCP server');
            }
        }
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    async callTool(name, input) {
        // Check built-in handlers first
        const handler = this.handlers.get(name);
        if (handler)
            return handler(input);
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
    disconnectAll() {
        for (const client of this.clients.values()) {
            client.disconnect();
        }
        this.clients.clear();
        this.tools.clear();
    }
}
//# sourceMappingURL=registry.js.map