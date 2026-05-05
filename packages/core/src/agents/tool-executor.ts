/**
 * Smart ToolExecutor — the core agent loop.
 *
 * Improvements over the naive counter loop:
 *
 *  1. Iteration budget   — shared pool with grace call at 85% usage
 *  2. Stall detection    — same tool + same args × 2 → replanning prompt injected
 *  3. Error accumulation — 3+ consecutive tool errors → strategy change prompt
 *  4. Activity events    — emits agent_update chunks for live UI
 *  5. Grace call         — at 85% budget, injects "wrap up" message before final turn
 *  6. Planning prefix    — complex tasks get a lightweight "plan first" addendum
 */

import type { LLMClient, UnifiedMessage } from '../llm/base.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger, ToolResult, StreamChunk, ToolCall, AgentUpdate } from '@agent-os-core/shared';
import type { HookRunner } from '../hooks/runner.js';
import { randomUUID } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 40;
const GRACE_THRESHOLD = 0.82;   // inject wrap-up at 82% of budget consumed
const STALL_LIMIT = 2;           // identical tool+args in a row → replanning
const ERROR_LIMIT = 3;           // consecutive tool errors → strategy change

// ─── Injected messages ────────────────────────────────────────────────────────

const STALL_PROMPT =
  '[System notice: You have called the same tool with identical arguments multiple times ' +
  'without making progress. Step back. Try a different tool, different arguments, or ' +
  'break the problem into smaller pieces. Do not repeat the same call again.]';

const ERROR_ACCUMULATION_PROMPT =
  '[System notice: Multiple consecutive tool errors detected. The current approach is not ' +
  'working. Consider: (1) reading relevant files first to understand context, ' +
  '(2) trying simpler alternatives, (3) verifying assumptions with a quick check tool, ' +
  '(4) breaking the task into smaller verifiable steps.]';

const GRACE_PROMPT =
  '[System notice: You are approaching the iteration limit. Please wrap up your work: ' +
  'deliver your best current answer, summarise what was accomplished, and note anything ' +
  'that remains for a follow-up session.]';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolHash(name: string, input: Record<string, unknown>): string {
  try {
    return `${name}::${JSON.stringify(input)}`;
  } catch {
    return name;
  }
}

function argPreview(input: Record<string, unknown>): string {
  const keys = ['path', 'file_path', 'command', 'pattern', 'url', 'query', 'topic', 'old_string'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 60 ? t.slice(0, 57) + '…' : t;
    }
  }
  return '';
}

/** Extract the user's task from the last user message for display. */
function extractTask(messages: UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.filter((c) => c.type === 'text').map((c) => (c as { type: 'text'; text: string }).text).join(' ');
    const first = text.replace(/\[System.*?\]/gs, '').trim().split('\n')[0]?.trim() ?? '';
    return first.length > 70 ? first.slice(0, 67) + '…' : first;
  }
  return 'Working…';
}

// ─── ToolExecutor ─────────────────────────────────────────────────────────────

export class ToolExecutor {
  private readonly agentId: string;

  constructor(
    private readonly client: LLMClient,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
    private readonly hookRunner?: HookRunner,
    agentId?: string,
  ) {
    this.agentId = agentId ?? 'nova';
  }

  public async *runLoop(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    onFinalAssistantMessage?: (text: string, tokens: number) => void,
    options?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    const messages: UnifiedMessage[] = [...initialMessages];
    const startMs = Date.now();
    const task = extractTask(messages);

    // ── Budget & state tracking ───────────────────────────────────────────────
    let iteration = 0;
    let graceCallInjected = false;
    let lastToolHash = '';
    let stallCount = 0;
    let consecutiveErrors = 0;
    let fullAssistantText = '';
    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    const emit = (update: Partial<AgentUpdate>): StreamChunk => ({
      type: 'agent_update',
      agentUpdate: {
        agentId: this.agentId,
        label: this.agentId,
        status: 'thinking',
        task,
        iteration,
        maxIterations: MAX_ITERATIONS,
        elapsedMs: Date.now() - startMs,
        ...update,
      },
    });

    // Announce start
    yield emit({ status: 'thinking' });

    // ── Main loop ─────────────────────────────────────────────────────────────
    while (iteration < MAX_ITERATIONS) {

      // Grace call: inject wrap-up prompt before the last ~18% of budget
      if (!graceCallInjected && iteration / MAX_ITERATIONS >= GRACE_THRESHOLD) {
        messages.push({ role: 'user', content: GRACE_PROMPT });
        graceCallInjected = true;
        yield emit({ status: 'thinking', note: 'Wrapping up (budget limit approaching)' });
        this.logger.debug({ iteration, max: MAX_ITERATIONS }, '[ToolExecutor] Grace call injected');
      }

      // ── LLM call ──────────────────────────────────────────────────────────
      const pendingToolCalls: ToolCall[] = [];
      let iterText = '';

      yield emit({ status: 'thinking' });

      for await (const chunk of this.client.stream(messages, systemPrompt, toolDefs, options)) {
        if (chunk.type === 'text' && chunk.content) {
          iterText += chunk.content;
          yield chunk;
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          yield chunk;
        } else if (chunk.type === 'usage' && chunk.usage) {
          lastUsage = chunk.usage;
          yield chunk;
        } else if (chunk.type === 'provider') {
          yield chunk;
        } else if (chunk.type === 'done') {
          break;
        } else if (chunk.type === 'error') {
          yield chunk;
          break;
        }
      }

      fullAssistantText += iterText;

      // No tool calls → model is done
      if (pendingToolCalls.length === 0) {
        break;
      }

      // ── Tool execution ────────────────────────────────────────────────────

      // Stall detection: check if all tool calls are identical to last round
      const currentHash = pendingToolCalls.map((tc) => toolHash(tc.name, tc.input)).join('|');
      if (currentHash === lastToolHash) {
        stallCount++;
        if (stallCount >= STALL_LIMIT) {
          messages.push({ role: 'user', content: STALL_PROMPT });
          stallCount = 0;
          lastToolHash = '';
          yield emit({ status: 'thinking', note: 'Stall detected — replanning' });
          this.logger.warn({ tool: pendingToolCalls[0]?.name, iteration }, '[ToolExecutor] Stall detected');
          continue; // retry without executing stuck tool
        }
      } else {
        stallCount = 0;
        lastToolHash = currentHash;
      }

      const toolResults: ToolResult[] = [];
      let errorThisTurn = false;

      for (const toolCall of pendingToolCalls) {
        this.logger.debug({ tool: toolCall.name, iter: iteration }, '[ToolExecutor] calling tool');

        // Emit running status for UI
        yield emit({
          status: 'running',
          tool: toolCall.name,
          toolPreview: argPreview(toolCall.input),
        });

        // Pre-hook (can block)
        if (this.hookRunner) {
          const pre = await this.hookRunner.fire('toolUsePre', {
            toolName: toolCall.name,
            toolInput: toolCall.input,
          });
          if (pre.blocked) {
            const blocked: ToolResult = {
              toolCallId: toolCall.id,
              content: `Tool blocked by hook: ${pre.output ?? 'no reason given'}`,
              isError: true,
            };
            toolResults.push(blocked);
            yield { type: 'hook_blocked', content: pre.output ?? `Hook blocked ${toolCall.name}` };
            yield { type: 'tool_result', toolResult: blocked };
            continue;
          }
        }

        // Execute tool
        let result: ToolResult;
        try {
          result = await this.tools.callTool(toolCall.name, toolCall.input);
          result.toolCallId = toolCall.id;
        } catch (err) {
          result = {
            toolCallId: toolCall.id,
            content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }

        if (result.isError) {
          errorThisTurn = true;
          consecutiveErrors++;
        } else {
          consecutiveErrors = 0;
        }

        // Post-hook (fire-and-forget)
        if (this.hookRunner) {
          this.hookRunner.fire(result.isError ? 'toolUseError' : 'toolUsePost', {
            toolName: toolCall.name,
            toolInput: toolCall.input,
            output: result.content,
            isError: result.isError,
          }).catch(() => {});
        }

        toolResults.push(result);
        yield { type: 'tool_result', toolResult: result };
      }

      // Error accumulation guard
      if (consecutiveErrors >= ERROR_LIMIT) {
        messages.push({ role: 'user', content: ERROR_ACCUMULATION_PROMPT });
        consecutiveErrors = 0;
        yield emit({ status: 'thinking', note: 'Errors detected — changing strategy' });
        this.logger.warn({ iteration }, '[ToolExecutor] Error accumulation limit hit');
      }

      // ── Append round to history ───────────────────────────────────────────
      const assistantContent: UnifiedMessage['content'] = [];
      if (iterText) assistantContent.push({ type: 'text', text: iterText });
      for (const tc of pendingToolCalls) {
        assistantContent.push({
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          input: tc.input,
          thoughtSignature: tc.thoughtSignature,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          toolCallId: r.toolCallId,
          name: pendingToolCalls.find((tc) => tc.id === r.toolCallId)?.name ?? '',
          content: r.content,
          isError: r.isError,
        })),
      });

      iteration++;
    }

    if (iteration >= MAX_ITERATIONS) {
      this.logger.warn({ iterations: MAX_ITERATIONS }, '[ToolExecutor] Hit max iterations');
    }

    // Done
    yield emit({ status: 'done', task });

    if (onFinalAssistantMessage && fullAssistantText) {
      onFinalAssistantMessage(fullAssistantText, lastUsage.inputTokens + lastUsage.outputTokens);
    }

    yield { type: 'done' };
  }

  public async *runLoopAndReturnChunks(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    options?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    yield* this.runLoop(systemPrompt, initialMessages, toolDefs, undefined, options);
  }

  public async runLoopAndReturnString(
    systemPrompt: string,
    initialMessages: UnifiedMessage[],
    toolDefs: ReturnType<ToolRegistry['getTools']>,
    options?: Record<string, unknown>,
  ): Promise<string> {
    let output = '';
    for await (const chunk of this.runLoop(systemPrompt, initialMessages, toolDefs, undefined, options)) {
      if (chunk.type === 'text' && chunk.content) output += chunk.content;
    }
    return output;
  }
}

// Re-export for subagent usage
export { randomUUID };
