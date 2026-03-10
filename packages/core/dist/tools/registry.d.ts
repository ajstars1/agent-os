import type { ToolDefinition, ToolResult, Logger } from '@agent-os/shared';
type BuiltinHandler = (input: Record<string, unknown>) => Promise<ToolResult>;
export declare class ToolRegistry {
    private readonly logger;
    private readonly tools;
    private readonly clients;
    private readonly handlers;
    constructor(logger: Logger);
    /** Register a built-in tool with an inline handler (no MCP process needed) */
    register(definition: ToolDefinition, handler: BuiltinHandler): void;
    loadFromMCPConfig(mcpConfigPath: string): Promise<void>;
    getTools(): ToolDefinition[];
    callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
    disconnectAll(): void;
}
export {};
//# sourceMappingURL=registry.d.ts.map