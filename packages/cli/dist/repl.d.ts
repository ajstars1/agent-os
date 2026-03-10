import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor } from '@agent-os/core';
export declare class Repl {
    private readonly engine;
    private readonly skills;
    private readonly hamStore?;
    private readonly hamCompressor?;
    private readonly rl;
    private readonly currentModel;
    private conversationId;
    constructor(engine: AgentEngine, skills: SkillLoader, channelId: string, hamStore?: TieredStore | undefined, hamCompressor?: (HAMCompressor | null) | undefined);
    run(): Promise<void>;
    private chat;
}
//# sourceMappingURL=repl.d.ts.map