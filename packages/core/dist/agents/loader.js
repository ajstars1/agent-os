import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentProfileSchema } from './types.js';
function expandPath(p) {
    return p.startsWith('~') ? p.replace('~', homedir()) : p;
}
export class AgentLoader {
    agentsDir;
    logger;
    profiles = new Map();
    constructor(agentsDir, logger) {
        this.agentsDir = agentsDir;
        this.logger = logger;
    }
    async load() {
        const dir = expandPath(this.agentsDir);
        if (!existsSync(dir)) {
            this.logger.info({ dir }, 'Agents directory not found, skipping');
            return;
        }
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch (err) {
            this.logger.warn({ err, dir }, 'Failed to read agents directory');
            return;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json'))
                continue;
            const filePath = join(dir, entry.name);
            try {
                const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
                const result = AgentProfileSchema.safeParse(raw);
                if (!result.success) {
                    this.logger.warn({ file: filePath, issues: result.error.issues }, 'Invalid agent profile');
                    continue;
                }
                this.profiles.set(result.data.name, result.data);
                this.logger.info({ name: result.data.name }, 'Agent profile loaded');
            }
            catch (err) {
                this.logger.warn({ err, file: filePath }, 'Failed to parse agent profile');
            }
        }
    }
    get(name) {
        return this.profiles.get(name);
    }
    list() {
        return Array.from(this.profiles.values());
    }
    registerInline(profile) {
        const result = AgentProfileSchema.safeParse(profile);
        if (!result.success)
            throw new Error(result.error.toString());
        this.profiles.set(result.data.name, result.data);
    }
}
//# sourceMappingURL=loader.js.map