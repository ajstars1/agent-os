/**
 * CodeAgent — Claude-powered code generation, review, and analysis.
 *
 * Always uses Claude (Sonnet) — superior code generation vs Gemini.
 * Supports three modes driven by the instruction's intent:
 *   - generate: write new code
 *   - review:   analyse existing code for bugs/quality
 *   - explain:  explain what code does in plain language
 */

import type { ClaudeClient } from '../../llm/claude.js';
import type { Logger } from '@agent-os/shared';

const SYSTEM_PROMPT = `You are an expert software engineer agent (TypeScript/Node.js specialist, also fluent in Python, Go, Rust).

When writing code:
- Use TypeScript strict mode. ESM imports with .js extensions in NodeNext projects.
- No \`any\` types. No default exports except pages. No console.log in production.
- Return code in fenced blocks with correct language tags.
- Explain key decisions in 1-2 sentences per block.

When reviewing code:
- Return a structured markdown report: Bugs, Security Issues, Performance, Style (only non-empty sections).
- Be specific — line-level or function-level callouts, not vague advice.

When explaining code:
- Write for a senior developer audience. Assume they can read syntax; explain intent and design choices.`;

export class CodeAgent {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly logger: Logger,
  ) {}

  async run(instruction: string): Promise<string> {
    const start = Date.now();
    try {
      let output = '';
      for await (const chunk of this.claude.stream(
        [{ role: 'user', content: instruction }],
        SYSTEM_PROMPT,
      )) {
        if (chunk.type === 'text' && chunk.content) output += chunk.content;
      }
      const duration = Date.now() - start;
      this.logger.debug({ duration, chars: output.length }, 'CodeAgent complete');
      return output.trim() || '[No code output]';
    } catch (err) {
      this.logger.warn({ err }, 'CodeAgent failed');
      return `[CodeAgent failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
}
