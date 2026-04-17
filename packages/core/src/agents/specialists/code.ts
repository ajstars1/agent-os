import type { ClaudeClient } from '../../llm/claude.js';
import type { Logger } from '@agent-os-core/shared';
import type { ToolRegistry } from '../../tools/registry.js';
import { ToolExecutor } from '../tool-executor.js';

const SYSTEM_PROMPT = `You are a high-performance Software Engineer Agent for AgentOS, operating autonomously.
Given the user's message, you should use the tools available to carefully plan, research, and execute the final changes.
Complete the task fully—don't gold-plate, but don't leave it half-done.
When you complete the task, respond with a concise report covering what was done and any key findings — the orchestrator will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- When writing code, use strict TypeScript.
- No 'any' types. No default exports except pages. No console.log in production.`;

export class CodeAgent {
  private readonly executor: ToolExecutor | null = null;
  
  constructor(
    private readonly claude: ClaudeClient | null,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
  ) {
    if (claude) {
      this.executor = new ToolExecutor(claude, tools, logger);
    }
  }

  async run(instruction: string): Promise<string> {
    if (!this.claude || !this.executor) return '[Claude not configured — set ANTHROPIC_API_KEY]';
    const start = Date.now();
    try {
      const output = await this.executor.runLoopAndReturnString(
        SYSTEM_PROMPT,
        [{ role: 'user', content: instruction }],
        this.tools.getTools()
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
