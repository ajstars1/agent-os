/**
 * PlannerAgent — goal decomposition and project roadmap generation.
 *
 * Uses Gemini Flash (fast, cheap) — planning tasks are low-complexity
 * reasoning that don't need top-tier model capability.
 *
 * Output is always a structured markdown plan suitable for direct use
 * as a task list or project brief.
 */

import type { GeminiClient } from '../../llm/gemini.js';
import type { ClaudeClient } from '../../llm/claude.js';
import type { Logger } from '@agent-os/shared';

const SYSTEM_PROMPT = `You are a planning agent. Turn goals into concrete, actionable plans.

Output format:
## Goal
[Restate the goal clearly in one sentence]

## Plan
1. [Concrete step with expected outcome]
2. ...

## Dependencies
- [Any external service, tool, or prerequisite needed]

## Risks
- [Key risks or unknowns — only if real, not hypothetical padding]

Rules:
- Maximum 8 steps. Group into phases if more are needed.
- Each step must be specific enough to assign to a developer.
- No vague guidance like "set up the environment" — be exact about what to install/configure.`;

export class PlannerAgent {
  constructor(
    private readonly gemini: GeminiClient | null,
    private readonly claude: ClaudeClient,
    private readonly logger: Logger,
  ) {}

  async run(instruction: string): Promise<string> {
    const start = Date.now();
    try {
      let output = '';
      if (this.gemini) {
        for await (const chunk of this.gemini.stream(
          [{ role: 'user', parts: [{ text: instruction }] }],
          SYSTEM_PROMPT,
          'flash',
        )) {
          if (chunk.type === 'text' && chunk.content) output += chunk.content;
        }
      } else {
        for await (const chunk of this.claude.stream(
          [{ role: 'user', content: instruction }],
          SYSTEM_PROMPT,
        )) {
          if (chunk.type === 'text' && chunk.content) output += chunk.content;
        }
      }
      const duration = Date.now() - start;
      this.logger.debug({ duration, chars: output.length }, 'PlannerAgent complete');
      return output.trim() || '[No plan output]';
    } catch (err) {
      this.logger.warn({ err }, 'PlannerAgent failed');
      return `[PlannerAgent failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
}
