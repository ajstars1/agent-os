import type { ClaudeClient } from '../../llm/claude.js';
import type { GeminiClient } from '../../llm/gemini.js';
import type { Logger } from '@agent-os-core/shared';
import type { ToolRegistry } from '../../tools/registry.js';
import { ToolExecutor } from '../tool-executor.js';
import type { UnifiedMessage } from '../../llm/base.js';

function buildSystemPrompt(): string {
  return `You are a high-performance Software Engineer Agent for AgentOS, operating autonomously.
Given the user's message, you should use the tools available to carefully plan, research, and execute the final changes.
Complete the task fully—don't gold-plate, but don't leave it half-done.
When you complete the task, respond with a concise report covering what was done and any key findings — the orchestrator will relay this to the user, so it only needs the essentials.

Current working directory: ${process.cwd()}

File editing workflow (CRITICAL — follow this exactly):
1. Use glob or grep to find the file if you don't know its exact path
2. Use read_file with the ABSOLUTE path before editing — the edit tool will fail without a prior read
3. Use edit to make targeted string replacements — never recreate a file from scratch when editing
4. Use write_file only for brand-new files, never to overwrite an existing one

Guidelines:
- All file paths must be absolute (start with / or ~)
- For file searches: search broadly when you don't know where something lives. Use read_file when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless absolutely necessary. ALWAYS prefer editing an existing file.
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested.
- When writing code, use strict TypeScript. No 'any' types. No default exports except pages. No console.log in production.`;
}

export class CodeAgent {
  private readonly executor: ToolExecutor | null = null;
  
  constructor(
    private readonly claude: ClaudeClient | null,
    private readonly gemini: GeminiClient | null,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
    private readonly preferredProvider: 'claude' | 'gemini' = 'claude',
  ) {
    const client = preferredProvider === 'gemini' ? gemini : claude;
    if (client) {
      this.executor = new ToolExecutor(client, tools, logger);
    } else if (claude || gemini) {
      // Fallback if preferred is missing
      this.executor = new ToolExecutor((claude || gemini)!, tools, logger);
    }
  }

  async run(instruction: string): Promise<string> {
    if (!this.executor) return '[Provider not configured — set ANTHROPIC_API_KEY or GOOGLE_API_KEY]';
    const start = Date.now();
    try {
      const output = await this.executor.runLoopAndReturnString(
        buildSystemPrompt(),
        [{ role: 'user', content: instruction }],
        this.tools.getTools(),
        this.preferredProvider === 'gemini' ? { variant: 'pro' } : {}
      );
      
      const duration = Date.now() - start;
      this.logger.debug({ duration, chars: output.length }, 'CodeAgent complete');
      return output.trim() || '[No code output]';
    } catch (err) {
      this.logger.warn({ err }, 'CodeAgent failed');
      return `[CodeAgent failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
}
