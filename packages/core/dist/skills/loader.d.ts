import type { Logger } from '@agent-os/shared';
export declare class SkillLoader {
    private readonly skillsDir;
    private readonly claudeMdPath;
    private readonly logger;
    private cachedContext;
    private watcher;
    private readonly reloadCallbacks;
    constructor(skillsDir: string, claudeMdPath: string, logger: Logger);
    load(): Promise<void>;
    getSystemContext(): string;
    startWatching(): void;
    stopWatching(): void;
    onReload(callback: () => void): void;
}
//# sourceMappingURL=loader.d.ts.map