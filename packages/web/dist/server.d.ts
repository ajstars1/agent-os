import { Hono } from 'hono';
import type { AgentEngine, AgentLoader, SQLiteMemoryStore, ToolRegistry } from '@agent-os/core';
import type { Config, Logger } from '@agent-os/shared';
export interface ServerDeps {
    engine: AgentEngine;
    agents: AgentLoader;
    memory: SQLiteMemoryStore;
    tools: ToolRegistry;
    config: Config;
    logger: Logger;
}
export declare function createServer(deps: ServerDeps): Hono;
//# sourceMappingURL=server.d.ts.map