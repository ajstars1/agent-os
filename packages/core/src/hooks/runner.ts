import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '@agent-os-core/shared';
import type { HookBinding as SharedHookBinding } from '@agent-os-core/shared';
import type { HookEvent, HookPayload, HookResult } from './types.js';

// Accept either the shared (optional fields) or the Zod-inferred (required fields) shape
type HookBinding = SharedHookBinding;

const execAsync = promisify(exec);

/** Fired hooks that have `once: true` — keyed by binding index. */
const _firedOnce = new Set<number>();

function matchesTool(match: string | undefined, toolName: string | undefined): boolean {
  if (!match || !toolName) return true;
  if (match === '*') return true;
  // pipe-delimited alternatives: "bash|edit|write_file"
  const alts = match.split('|').map((s) => s.trim());
  return alts.some((alt) => {
    if (alt.endsWith('*')) return toolName.startsWith(alt.slice(0, -1));
    return alt === toolName;
  });
}

function interpolate(template: string, payload: HookPayload): string {
  return template
    .replace(/\{toolName\}/g, payload.toolName ?? '')
    .replace(/\{toolInput\}/g, payload.toolInput ? JSON.stringify(payload.toolInput) : '')
    .replace(/\{output\}/g, payload.output ?? '')
    .replace(/\{message\}/g, payload.message ?? '')
    .replace(/\{event\}/g, payload.event);
}

async function runCommandHook(
  command: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  payload: HookPayload,
  logger: Logger,
): Promise<HookResult> {
  const interpolated = interpolate(command, payload);
  try {
    const { stdout } = await execAsync(interpolated, {
      timeout: timeoutMs,
      env: { ...process.env, ...(env ?? {}), HOOK_EVENT: payload.event },
      maxBuffer: 512 * 1024,
    });
    return { blocked: false, output: stdout.trim() || undefined };
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ command: interpolated, code }, '[Hook] command hook failed');
    // Non-zero exit from a toolUsePre hook blocks the tool call
    return {
      blocked: payload.event === 'toolUsePre' && code !== 0,
      output: [msg, stderr].filter(Boolean).join('\n') || undefined,
    };
  }
}

async function runHttpHook(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  payload: HookPayload,
  logger: Logger,
): Promise<HookResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, '[Hook] HTTP hook returned non-2xx');
    }
    return { blocked: false };
  } catch (err: unknown) {
    logger.warn({ url, err }, '[Hook] HTTP hook error');
    return { blocked: false };
  }
}

export class HookRunner {
  constructor(
    private readonly bindings: HookBinding[],
    private readonly logger: Logger,
  ) {}

  /**
   * Fire all hooks matching the given event. Returns a merged HookResult.
   * For `toolUsePre`: if any command hook exits non-zero, `blocked` is true.
   */
  async fire(event: HookEvent, payload: Omit<HookPayload, 'event' | 'timestamp'>): Promise<HookResult> {
    const fullPayload: HookPayload = { ...payload, event, timestamp: Date.now() };
    const merged: HookResult = { blocked: false };

    for (let i = 0; i < this.bindings.length; i++) {
      const binding = this.bindings[i]!;

      if (!binding.events.includes(event)) continue;
      if (!matchesTool(binding.match, payload.toolName)) continue;

      // once semantics
      const isOnce = binding.hook.once ?? false;
      if (isOnce && _firedOnce.has(i)) continue;
      if (isOnce) _firedOnce.add(i);

      let result: HookResult;

      switch (binding.hook.type) {
        case 'command':
          result = await runCommandHook(
            binding.hook.command,
            binding.hook.env,
            binding.hook.timeoutMs ?? 30_000,
            fullPayload,
            this.logger,
          );
          break;
        case 'http':
          result = await runHttpHook(
            binding.hook.url,
            binding.hook.headers,
            binding.hook.timeoutMs ?? 10_000,
            fullPayload,
            this.logger,
          );
          break;
        case 'prompt':
          result = {
            blocked: false,
            promptAddition: interpolate(binding.hook.content, fullPayload),
          };
          break;
        default:
          result = { blocked: false };
      }

      if (result.blocked) merged.blocked = true;
      if (result.output) merged.output = [merged.output, result.output].filter(Boolean).join('\n');
      if (result.promptAddition) {
        merged.promptAddition = [merged.promptAddition, result.promptAddition]
          .filter(Boolean)
          .join('\n');
      }
    }

    return merged;
  }

  /** Convenience: returns true only if the caller should abort the tool call. */
  async shouldBlock(toolName: string, toolInput: Record<string, unknown>): Promise<{ block: boolean; reason?: string }> {
    const result = await this.fire('toolUsePre', { toolName, toolInput });
    return { block: result.blocked, reason: result.output };
  }
}
