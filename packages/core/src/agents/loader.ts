import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from '@agent-os-core/shared';
import { AgentProfileSchema, type AgentProfile } from './types.js';

function expandPath(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export class AgentLoader {
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(
    private readonly agentsDir: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    const dir = expandPath(this.agentsDir);
    if (!existsSync(dir)) {
      this.logger.info({ dir }, 'Agents directory not found, skipping');
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      this.logger.warn({ err, dir }, 'Failed to read agents directory');
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(dir, entry.name);
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
        const result = AgentProfileSchema.safeParse(raw);
        if (!result.success) {
          this.logger.warn(
            { file: filePath, issues: result.error.issues },
            'Invalid agent profile',
          );
          continue;
        }
        this.profiles.set(result.data.name, result.data);
        this.logger.info({ name: result.data.name }, 'Agent profile loaded');
      } catch (err: unknown) {
        this.logger.warn({ err, file: filePath }, 'Failed to parse agent profile');
      }
    }
  }

  get(name: string): AgentProfile | undefined {
    return this.profiles.get(name);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  registerInline(profile: AgentProfile): void {
    const result = AgentProfileSchema.safeParse(profile);
    if (!result.success) throw new Error(result.error.toString());
    this.profiles.set(result.data.name, result.data);
  }
}
