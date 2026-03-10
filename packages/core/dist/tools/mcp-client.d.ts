import type { ToolDefinition, ToolResult, Logger } from '@agent-os/shared';
export interface MCPServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
export declare class MCPClient {
    private readonly name;
    private readonly config;
    private readonly logger;
    private process;
    private readonly pending;
    constructor(name: string, config: MCPServerConfig, logger: Logger);
    connect(): Promise<void>;
    listTools(): Promise<ToolDefinition[]>;
    callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
    disconnect(): void;
    private call;
    private sendNotification;
}
//# sourceMappingURL=mcp-client.d.ts.map