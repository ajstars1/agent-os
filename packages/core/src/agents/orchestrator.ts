/**
 * Orchestrator — the brain of the multi-agent runtime.
 *
 * Flow:
 *   1. classify()  → decides if the request is simple or multi-step
 *   2. decompose() → splits complex requests into typed sub-tasks
 *   3. dispatch()  → runs workers in parallel, bounded concurrency
 *   4. reduce()    → synthesizes worker outputs into a coherent response
 *
 * The Orchestrator emits progress events so the caller (engine.ts) can
 * stream status back to the user in real time.
 *
 * Memory isolation:
 * - Workers get instruction only — no shared conversation history.
 * - The Reducer sees all worker outputs, plus the original request.
 * - Significant findings are written to episodic memory by the engine.
 */

import type { ClaudeClient } from '../llm/claude.js';
import type { GeminiClient, GeminiVariant } from '../llm/gemini.js';
import type { EpisodicStore } from '../memory/episodic-store.js';
import type { Logger } from '@agent-os/shared';
import { WorkerAgent } from './worker.js';
import type { WorkerResult } from './worker.js';
import type { TaskType } from './task-queue.js';
import { ResearchAgent } from './specialists/research.js';
import { CodeAgent } from './specialists/code.js';
import { PlannerAgent } from './specialists/planner.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type RequestComplexity = 'simple' | 'complex';

export interface SubTask {
  type: TaskType;
  instruction: string;
}

export interface OrchestratorEvent {
  type: 'classified' | 'decomposed' | 'worker_start' | 'worker_done' | 'reducing' | 'done';
  complexity?: RequestComplexity;
  taskCount?: number;
  workerType?: TaskType;
  workerIndex?: number;
  result?: string;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const CLASSIFY_PROMPT = `Classify this user request. Return ONLY one word: "simple" or "complex".

simple = a single focused question, one piece of code, one explanation, quick lookup.
complex = requires research + code + planning, multiple distinct sub-topics, a project/feature build, "build me X from scratch", needs several expert perspectives.

Request: `;

const DECOMPOSE_PROMPT = `You are a task decomposer. Break this user request into focused sub-tasks for specialist agents.

Available agent types and when to use them:
- research: finding facts, comparisons, API docs, market info, technical explanations
- code: writing/reviewing/debugging code, architecture decisions, file-level changes
- plan: project plans, step-by-step roadmaps, workflow design, feature specs
- general: anything that doesn't fit the above

Rules:
- Max 4 sub-tasks. Do NOT add tasks just to fill the count.
- Each instruction must be self-contained — the worker has no context other than what you write here.
- Write instructions as direct imperatives: "Explain X", "Write Y that does Z", "Create a plan for A".
- Return ONLY valid JSON. No markdown, no explanation.

Schema: { "tasks": [{ "type": "research"|"code"|"plan"|"general", "instruction": string }] }

User request: `;

const REDUCE_PROMPT = `You are a synthesis agent. You have received outputs from specialist workers.
Your job is to combine them into one clear, well-structured response for the user.

Rules:
- Preserve all important information from each worker.
- Remove redundancy. Merge overlapping sections.
- Use markdown: headers to separate major sections, code blocks for code, bullets for lists.
- Write in second person ("you" = the user) unless responding to first-person statements.
- Do NOT add a meta-section explaining what the agents did — just deliver the answer.
- If any worker output is marked as "[Worker X failed...]", note the gap briefly and continue.

Original user request:
{REQUEST}

Worker outputs:
{OUTPUTS}

Synthesize into a complete response:`;

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator {
  private static readonly MAX_CONCURRENCY = 3;

  constructor(
    private readonly claude: ClaudeClient,
    private readonly gemini: GeminiClient | null,
    private readonly episodicStore: EpisodicStore | undefined,
    private readonly logger: Logger,
  ) {}

  /**
   * Main entry point. Yields progress events, resolves with the final response.
   * The caller (engine.ts) converts events to stream chunks.
   */
  async *run(userMessage: string, conversationId: string, preferredProvider?: 'claude' | 'gemini'): AsyncGenerator<OrchestratorEvent> {
    // ── Step 1: Classify ────────────────────────────────────────────────────
    const complexity = await this.classify(userMessage, preferredProvider);
    yield { type: 'classified', complexity };

    if (complexity === 'simple') {
      // Let engine handle with its standard path — signal done immediately
      yield { type: 'done', result: '' };
      return;
    }

    // ── Step 2: Decompose ────────────────────────────────────────────────────
    const subTasks = await this.decompose(userMessage, preferredProvider);
    if (subTasks.length === 0) {
      // Decompose failed or returned empty — fall back to simple path
      yield { type: 'done', result: '' };
      return;
    }
    yield { type: 'decomposed', taskCount: subTasks.length };

    // ── Step 3: Dispatch (bounded parallel) ──────────────────────────────────
    const results: WorkerResult[] = [];
    const chunks = this.chunk(subTasks, Orchestrator.MAX_CONCURRENCY);

    let workerIndex = 0;
    for (const batch of chunks) {
      // Signal starts for this batch
      for (const task of batch) {
        yield { type: 'worker_start', workerType: task.type, workerIndex };
        workerIndex++;
      }

      // Run batch in parallel — route to specialist agents where available
      const batchResults = await Promise.all(
        batch.map((task) => this.runTask(task, preferredProvider)),
      );

      for (const res of batchResults) {
        results.push(res);
        yield { type: 'worker_done', workerType: res.type };
      }
    }

    // ── Step 4: Reduce ───────────────────────────────────────────────────────
    yield { type: 'reducing' };
    const synthesized = await this.reduce(userMessage, results, preferredProvider);

    // ── Side-effect: write to episodic memory if result is substantial ───────
    if (synthesized.length > 200 && this.episodicStore) {
      this.episodicStore.add({
        summary: `Multi-agent task completed: ${userMessage.slice(0, 120)}`,
        topics: subTasks.map((t) => t.type),
        importance: 0.6,
        tone: 'neutral',
        occurredAt: Date.now(),
        conversationId,
      });
    }

    yield { type: 'done', result: synthesized };
  }

  // ── Task runner — routes to specialist or generic worker ───────────────────

  private async runTask(task: SubTask, preferredProvider?: 'claude' | 'gemini'): Promise<WorkerResult> {
    const start = Date.now();

    try {
      let output: string;

      // If user explicitly chose a provider, route all tasks through WorkerAgent
      // which respects the preference — no hardcoded model overrides.
      if (preferredProvider) {
        const worker = new WorkerAgent(
          { type: task.type, preferredProvider },
          this.claude, this.gemini, this.logger,
        );
        return worker.run(task.instruction);
      }

      // Auto mode: use specialist agents with optimised per-type routing
      if (task.type === 'research' && this.gemini) {
        const agent = new ResearchAgent(this.gemini, this.logger);
        output = await agent.run(task.instruction);
      } else if (task.type === 'code') {
        const agent = new CodeAgent(this.claude, this.logger);
        output = await agent.run(task.instruction);
      } else if (task.type === 'plan') {
        const agent = new PlannerAgent(this.gemini, this.claude, this.logger);
        output = await agent.run(task.instruction);
      } else {
        // General or fallback — generic worker
        const worker = new WorkerAgent({ type: task.type }, this.claude, this.gemini, this.logger);
        return worker.run(task.instruction);
      }

      return {
        type: task.type,
        output,
        partial: false,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: task.type,
        output: `[Worker ${task.type} failed: ${message}]`,
        partial: true,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async classify(message: string, preferredProvider?: 'claude' | 'gemini'): Promise<RequestComplexity> {
    try {
      const prompt = `${CLASSIFY_PROMPT}${message.slice(0, 600)}`;
      const text = await this.streamText(prompt, '', preferredProvider, 'flash-lite');
      const answer = text.trim().toLowerCase();
      return answer.includes('complex') ? 'complex' : 'simple';
    } catch (err) {
      this.logger.warn({ err }, 'Orchestrator classify failed — defaulting to simple');
      return 'simple';
    }
  }

  private async decompose(message: string, preferredProvider?: 'claude' | 'gemini'): Promise<SubTask[]> {
    try {
      const prompt = `${DECOMPOSE_PROMPT}${message.slice(0, 800)}`;
      const text = await this.streamText(prompt, '', preferredProvider, 'flash');

      const cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '');

      const parsed = JSON.parse(cleaned) as { tasks?: Array<{ type: string; instruction: string }> };
      if (!Array.isArray(parsed.tasks)) return [];

      return parsed.tasks
        .filter((t) => t && typeof t.type === 'string' && typeof t.instruction === 'string')
        .slice(0, 4)
        .map((t) => ({
          type: (['research', 'code', 'plan', 'general'] as const).includes(t.type as TaskType)
            ? (t.type as TaskType)
            : 'general',
          instruction: t.instruction,
        }));
    } catch (err) {
      this.logger.warn({ err }, 'Orchestrator decompose failed');
      return [];
    }
  }

  private async reduce(originalRequest: string, results: WorkerResult[], preferredProvider?: 'claude' | 'gemini'): Promise<string> {
    const outputsBlock = results
      .map((r, i) => `### Worker ${i + 1} (${r.type})\n${r.output}`)
      .join('\n\n');

    const prompt = REDUCE_PROMPT
      .replace('{REQUEST}', originalRequest.slice(0, 600))
      .replace('{OUTPUTS}', outputsBlock);

    const synthesized = await this.streamText(prompt, '', preferredProvider);
    return synthesized.trim() || results.map((r) => r.output).join('\n\n');
  }

  /**
   * Route an LLM call through the user's preferred provider.
   *
   * - `'gemini'` → use Gemini if configured, otherwise fall back to Claude
   * - `'claude'` → always Claude
   * - `undefined` (auto) → prefer Gemini (cheaper / faster for internal tasks)
   */
  private async streamText(
    prompt: string,
    systemPrompt: string,
    preferredProvider?: 'claude' | 'gemini',
    geminiVariant: GeminiVariant = 'flash',
  ): Promise<string> {
    const useGemini = preferredProvider === 'gemini'
      ? !!this.gemini
      : preferredProvider === 'claude'
        ? false
        : !!this.gemini;

    let text = '';
    if (useGemini && this.gemini) {
      for await (const chunk of this.gemini.stream(
        [{ role: 'user', parts: [{ text: prompt }] }],
        systemPrompt,
        geminiVariant,
      )) {
        if (chunk.type === 'text' && chunk.content) text += chunk.content;
      }
    } else {
      for await (const chunk of this.claude.stream(
        [{ role: 'user', content: prompt }],
        systemPrompt,
      )) {
        if (chunk.type === 'text' && chunk.content) text += chunk.content;
      }
    }
    return text;
  }

  /** Split array into chunks of at most `size`. */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}
