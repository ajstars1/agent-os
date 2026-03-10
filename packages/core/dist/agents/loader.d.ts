import type { Logger } from '@agent-os/shared';
import { type AgentProfile } from './types.js';
export declare class AgentLoader {
    private readonly agentsDir;
    private readonly logger;
    private readonly profiles;
    constructor(agentsDir: string, logger: Logger);
    load(): Promise<void>;
    get(name: string): AgentProfile | undefined;
    list(): AgentProfile[];
    registerInline(profile: AgentProfile): void;
}
//# sourceMappingURL=loader.d.ts.map