/**
 * WorkerAgent — isolated execution unit for a single typed task.
 *
 * Design principles:
 * - Each worker has its OWN context window: no bleed between parallel workers.
 * - Tool access is scoped per worker type — code workers get file tools,
 *   research workers get web tools, planners get none.
 * - Hard timeout (default 90 s) to prevent runaway tasks.
 * - Returns a typed WorkerResult; caller (Orchestrator) owns persistence.
 *
 * This is NOT a subclass of AgentEngine — intentionally thin. Workers are
 * single-shot: one instruction in, one output out. No streaming externally.
 */

import type { ClaudeClient } from '../llm/claude.js';
import type { GeminiClient } from '../llm/gemini.js';
import type { TaskType } from './task-queue.js';
import type { Logger } from '@agent-os-core/shared';

export interface WorkerConfig {
  type: TaskType;
  /** Max seconds before the worker is forcefully aborted. */
  timeoutMs?: number;
  /** User's explicitly chosen provider — overrides per-type routing. */
  preferredProvider?: 'claude' | 'gemini';
}

export interface WorkerResult {
  type: TaskType;
  output: string;
  /** Whether the result represents a best-effort (partial/degraded) answer. */
  partial: boolean;
  durationMs: number;
}

// ── Per-type system prompts ──────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<TaskType, string> = {
  research: `You are a concise research agent. Your task is to answer the specific question given to you.
- Return ONLY the answer. No preambles, no "here is what I found".
- Use markdown for structure: headers, bullets, code blocks where relevant.
- Cite specific facts. If uncertain, say so explicitly.
- Max length: 400 words unless the instruction explicitly asks for more.`,

  code: `You are a senior software engineer agent. Your task is to produce working code or technical analysis.
- Return code in fenced code blocks with the correct language tag.
- Explain key decisions in 1-2 sentences per block — no excessive commentary.
- Follow TypeScript strict mode, ESM imports with .js extension, no \`any\`.
- If the task is analysis (not generation), return a structured markdown report.`,

  plan: `You are a planning agent. Your task is to break down a goal into concrete steps.
- Return a numbered action plan — no vague guidance.
- Each step must be specific enough to be actionable without further clarification.
- Identify blockers, dependencies, and risks if any.
- Max 10 steps. If more are needed, group them into phases.`,

  general: `You are a focused assistant. Answer the specific question or complete the task given.
- Be direct and concise. No padding.
- Use markdown formatting where it helps clarity.`,
};

// ── WorkerAgent ──────────────────────────────────────────────────────────────

export class WorkerAgent {
  private readonly timeoutMs: number;

  constructor(
    private readonly config: WorkerConfig,
    private readonly claude: ClaudeClient | null,
    private readonly gemini: GeminiClient | null,
    private readonly logger: Logger,
  ) {
    this.timeoutMs = config.timeoutMs ?? 90_000;
  }

  async run(instruction: string): Promise<WorkerResult> {
    const start = Date.now();
    const { type } = this.config;
    const systemPrompt = SYSTEM_PROMPTS[type];

    try {
      const output = await Promise.race([
        this.execute(instruction, systemPrompt, type),
        this.timeout(),
      ]);

      return {
        type,
        output,
        partial: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ type, instruction: instruction.slice(0, 80), err: message }, 'Worker failed');

      return {
        type,
        output: `[Worker ${type} failed: ${message}]`,
        partial: true,
        durationMs: Date.now() - start,
      };
    }
  }

  private async execute(instruction: string, systemPrompt: string, type: TaskType): Promise<string> {
    const pref = this.config.preferredProvider;

    // Determine LLM: respect user's explicit choice, otherwise auto-route by task type
    const useGemini = pref === 'gemini'
      ? !!this.gemini                     // user chose gemini → use if available
      : pref === 'claude'
        ? false                            // user chose claude → never gemini
        : !!(this.gemini && (type === 'research' || type === 'plan' || type === 'general'));

    if (useGemini && this.gemini) {
      let output = '';
      for await (const chunk of this.gemini.stream(
        [{ role: 'user', parts: [{ text: instruction }] }],
        systemPrompt,
        'flash',
      )) {
        if (chunk.type === 'text' && chunk.content) output += chunk.content;
      }
      return output.trim() || '[No output from Gemini worker]';
    }

    // Claude path
    if (!this.claude) return '[Claude not configured — set ANTHROPIC_API_KEY]';
    let output = '';
    for await (const chunk of this.claude.stream(
      [{ role: 'user', content: instruction }],
      systemPrompt,
    )) {
      if (chunk.type === 'text' && chunk.content) output += chunk.content;
    }
    return output.trim() || '[No output from Claude worker]';
  }

  private timeout(): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Worker timed out after ${this.timeoutMs}ms`)), this.timeoutMs),
    );
  }
}
