import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor } from '@agent-os/core';
export interface CommandContext {
    engine: AgentEngine;
    skills: SkillLoader;
    conversationId: string;
    currentModel: {
        value: string;
    };
    hamStore?: TieredStore;
    hamCompressor?: HAMCompressor | null;
}
export declare const commands: Record<string, (args: string, ctx: CommandContext) => void | Promise<void>>;
export declare function isCommand(input: string): boolean;
export declare function handleCommand(input: string, ctx: CommandContext): Promise<void>;
//# sourceMappingURL=index.d.ts.map