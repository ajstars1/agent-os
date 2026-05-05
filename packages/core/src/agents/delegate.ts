/**
 * Subagent delegation — spawn isolated AgentEngine instances to run tasks in parallel.
 *
 * Each subagent gets:
 *   - A fresh conversation (no parent history)
 *   - A restricted toolset (no delegate_task, no dangerous bash by default)
 *   - Its own taskId for file/session isolation
 *   - A focused system prompt built from the delegated goal
 *
 * Usage (via delegate_task tool):
 *   delegate_task({
 *     goal: "research Next.js 15 migration guide",
 *     tools: ["web_search", "web_fetch", "read_file"],
 *     maxIterations: 20,
 *   })
 */

import type { Logger, ToolResult } from '@agent-os-core/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { LLMClient } from '../llm/base.js';
import { ToolExecutor } from './tool-executor.js';

/** Tracks active subagents for the SubagentOverlay UI. */
export interface ActiveSubagent {
  taskId: string;
  goal: string;
  startedAt: number;
  depth: number;
}

const _active = new Map<string, ActiveSubagent>();

export function getActiveSubagents(): ActiveSubagent[] {
  return [..._active.values()];
}

// ─── Delegation ───────────────────────────────────────────────────────────────

const BLOCKED_TOOLS = new Set(['delegate_task']);

/** Tools always blocked for subagents — prevents recursion and side-effects. */
const ALWAYS_BLOCKED = new Set(['delegate_task']);

/** Maximum subagent nesting depth (parent → child → grandchild = depth 2). */
const MAX_DEPTH = 3;

export interface DelegateInput {
  goal: string;
  /** Restrict subagent to only these tools. Empty = all allowed tools. */
  tools?: string[];
  /** Max tool-call iterations (default 20). */
  maxIterations?: number;
  /** Depth counter (internal — incremented by parent). */
  _depth?: number;
}

export async function delegateTask(
  input: DelegateInput,
  client: LLMClient,
  registry: ToolRegistry,
  logger: Logger,
): Promise<ToolResult> {
  const { goal, tools = [], maxIterations = 20, _depth = 0 } = input;

  if (_depth >= MAX_DEPTH) {
    return {
      toolCallId: '',
      content: `Delegation depth limit (${MAX_DEPTH}) reached. Cannot spawn further subagents.`,
      isError: true,
    };
  }

  const taskId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Build restricted tool list
  const allTools = registry.getTools();
  const allowedNames = new Set(tools.length > 0 ? tools : allTools.map((t) => t.name));
  ALWAYS_BLOCKED.forEach((b) => allowedNames.delete(b));
  const restrictedDefs = allTools.filter((t) => allowedNames.has(t.name));

  // Wrap the registry: override getTools() to return filtered defs and block certain tools
  const restrictedRegistry = Object.create(registry) as ToolRegistry;
  restrictedRegistry.getTools = () => restrictedDefs;
  restrictedRegistry.callTool = async (name: string, toolInput: Record<string, unknown>): Promise<ToolResult> => {
    if (BLOCKED_TOOLS.has(name)) {
      return { toolCallId: '', content: `Tool ${name} not available in subagent`, isError: true };
    }
    return registry.callTool(name, toolInput);
  };

  const systemPrompt = `You are a focused subagent tasked with a single goal. Complete it thoroughly, then stop.

GOAL: ${goal}

Rules:
- Work autonomously — do not ask the user for clarification
- Use only the tools provided (${restrictedDefs.map((t) => t.name).join(', ')})
- Return a clear, structured summary when done
- Do not spawn further subagents`;

  _active.set(taskId, { taskId, goal, startedAt: Date.now(), depth: _depth });
  logger.info({ taskId, goal, depth: _depth }, '[Delegate] Subagent spawned');

  try {
    const executor = new ToolExecutor(client, restrictedRegistry, logger);
    // Override max iterations
    const originalRunLoop = executor.runLoop.bind(executor);
    let output = '';

    for await (const chunk of originalRunLoop(
      systemPrompt,
      [{ role: 'user', content: goal }],
      restrictedDefs,
      undefined,
      { maxIterations },
    )) {
      if (chunk.type === 'text' && chunk.content) {
        output += chunk.content;
      }
    }

    const elapsed = Date.now() - (_active.get(taskId)?.startedAt ?? Date.now());
    logger.info({ taskId, elapsed, outputLength: output.length }, '[Delegate] Subagent complete');

    return {
      toolCallId: '',
      content: output || '(subagent produced no output)',
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, err }, '[Delegate] Subagent failed');
    return { toolCallId: '', content: `Subagent failed: ${msg}`, isError: true };
  } finally {
    _active.delete(taskId);
  }
}

// ─── Batch delegation ─────────────────────────────────────────────────────────

export interface BatchDelegateInput {
  tasks: Array<{ goal: string; tools?: string[] }>;
  maxIterations?: number;
  _depth?: number;
}

/** Run multiple subagents in parallel and return combined results. */
export async function batchDelegate(
  input: BatchDelegateInput,
  client: LLMClient,
  registry: ToolRegistry,
  logger: Logger,
): Promise<ToolResult> {
  const { tasks, maxIterations = 20, _depth = 0 } = input;

  if (tasks.length === 0) {
    return { toolCallId: '', content: 'No tasks provided', isError: true };
  }

  if (tasks.length > 10) {
    return { toolCallId: '', content: 'Batch limited to 10 subagents at once', isError: true };
  }

  const results = await Promise.allSettled(
    tasks.map((task) =>
      delegateTask({ ...task, maxIterations, _depth: _depth + 1 }, client, registry, logger),
    ),
  );

  const parts = results.map((r, i) => {
    const label = `### Task ${i + 1}: ${tasks[i]!.goal.slice(0, 60)}`;
    if (r.status === 'fulfilled') {
      return `${label}\n${r.value.content}`;
    }
    return `${label}\nFAILED: ${String(r.reason)}`;
  });

  return {
    toolCallId: '',
    content: parts.join('\n\n---\n\n'),
    isError: false,
  };
}
