import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
export class MCPClient {
    name;
    config;
    logger;
    process = null;
    pending = new Map();
    constructor(name, config, logger) {
        this.name = name;
        this.config = config;
        this.logger = logger;
    }
    async connect() {
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
            if (!trimmed.startsWith('{'))
                return;
            try {
                const msg = JSON.parse(trimmed);
                const handler = this.pending.get(msg.id);
                if (!handler)
                    return;
                this.pending.delete(msg.id);
                if (msg.error) {
                    handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                }
                else {
                    handler.resolve(msg.result);
                }
            }
            catch {
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
    async listTools() {
        const result = await this.call('tools/list', {});
        const tools = result.tools ?? [];
        return tools.map((t) => ({
            name: `${this.name}__${t.name}`,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }));
    }
    async callTool(name, input) {
        // Strip server prefix from tool name for the actual MCP call
        const actualName = name.startsWith(`${this.name}__`)
            ? name.slice(`${this.name}__`.length)
            : name;
        try {
            const result = await this.call('tools/call', { name: actualName, arguments: input });
            const content = JSON.stringify(result);
            return { toolCallId: '', content, isError: false };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { toolCallId: '', content: message, isError: true };
        }
    }
    disconnect() {
        this.process?.kill();
        this.process = null;
    }
    async call(method, params) {
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const req = { jsonrpc: '2.0', id, method, params };
            this.pending.set(id, { resolve, reject });
            this.process?.stdin?.write(JSON.stringify(req) + '\n');
        });
    }
    sendNotification(method, params) {
        const msg = { jsonrpc: '2.0', method, params };
        this.process?.stdin?.write(JSON.stringify(msg) + '\n');
    }
}
//# sourceMappingURL=mcp-client.js.map