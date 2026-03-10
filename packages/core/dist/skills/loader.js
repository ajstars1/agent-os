import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir as getHomedir } from 'node:os';
import { watch } from 'chokidar';
function expandPath(p) {
    return p.startsWith('~') ? p.replace('~', getHomedir()) : p;
}
export class SkillLoader {
    skillsDir;
    claudeMdPath;
    logger;
    cachedContext = null;
    watcher = null;
    reloadCallbacks = [];
    constructor(skillsDir, claudeMdPath, logger) {
        this.skillsDir = skillsDir;
        this.claudeMdPath = claudeMdPath;
        this.logger = logger;
    }
    async load() {
        const parts = [];
        const skillsPath = expandPath(this.skillsDir);
        const claudePath = expandPath(this.claudeMdPath);
        // Load CLAUDE.md
        try {
            if (existsSync(claudePath)) {
                const content = readFileSync(claudePath, 'utf-8');
                parts.push(`# Agent Identity & Rules\n\n${content}`);
            }
        }
        catch {
            this.logger.warn({ path: claudePath }, 'Could not read CLAUDE.md');
        }
        // Walk skills directory
        try {
            if (existsSync(skillsPath)) {
                const entries = readdirSync(skillsPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const skillMd = join(skillsPath, entry.name, 'SKILL.md');
                        if (existsSync(skillMd)) {
                            const content = readFileSync(skillMd, 'utf-8');
                            parts.push(`# Skill: ${entry.name}\n\n${content}`);
                        }
                    }
                    else if (entry.isFile() && entry.name.endsWith('.md')) {
                        const content = readFileSync(join(skillsPath, entry.name), 'utf-8');
                        parts.push(`# Skill: ${entry.name.replace('.md', '')}\n\n${content}`);
                    }
                }
            }
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT') {
                this.logger.warn({ skillsDir: skillsPath, err }, 'Error reading skills directory');
            }
        }
        this.cachedContext = parts.join('\n\n---\n\n');
        this.logger.info({ count: parts.length - 1 }, 'Skills loaded');
    }
    getSystemContext() {
        return this.cachedContext ?? '';
    }
    startWatching() {
        const skillsPath = expandPath(this.skillsDir);
        const claudePath = expandPath(this.claudeMdPath);
        const watchPaths = [skillsPath, claudePath].filter(existsSync);
        if (watchPaths.length === 0)
            return;
        this.watcher = watch(watchPaths, {
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        });
        this.watcher.on('all', (_event, changedPath) => {
            this.logger.info({ path: changedPath }, 'Skills changed, reloading');
            this.load()
                .then(() => {
                for (const cb of this.reloadCallbacks)
                    cb();
            })
                .catch((err) => {
                this.logger.error({ err }, 'Skill reload failed');
            });
        });
    }
    stopWatching() {
        this.watcher?.close().catch(() => { });
        this.watcher = null;
    }
    onReload(callback) {
        this.reloadCallbacks.push(callback);
    }
}
//# sourceMappingURL=loader.js.map