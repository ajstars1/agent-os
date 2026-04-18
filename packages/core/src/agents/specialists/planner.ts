import type { ClaudeClient } from '../../llm/claude.js';
import type { GeminiClient } from '../../llm/gemini.js';
import type { Logger } from '@agent-os-core/shared';
import type { ToolRegistry } from '../../tools/registry.js';
import { ToolExecutor } from '../tool-executor.js';

const SYSTEM_PROMPT = `You are a software architect and planning specialist for AgentOS. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no write commands)
- Modifying existing files (no edit operations)
- Deleting files
- Moving or copying files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided.
2. **Explore Thoroughly**:
   - Use glob and grep to find existing patterns.
   - Use read_file to understand the current architecture.
   - Trace through relevant code paths thoroughly before designing.
3. **Design Solution**:
   - Create an implementation approach based on your findings.
   - Consider trade-offs and architectural decisions.
   - Follow existing patterns where appropriate.
4. **Detail the Plan**:
   - Provide step-by-step implementation strategy.
   - Identify dependencies and sequencing.
   - Anticipate potential challenges.

## Required Output
When you are done exploring, output a clear, structured markdown implementation plan detailing your findings and step-by-step execution strategy. The orchestrator will parse this and pass it to execution agents.`;

export class PlannerAgent {
  private readonly executor: ToolExecutor | null = null;
  
  constructor(
    private readonly gemini: GeminiClient | null,
    private readonly claude: ClaudeClient | null,
    private readonly tools: ToolRegistry,
    private readonly logger: Logger,
    private readonly preferredProvider: 'claude' | 'gemini' = 'claude',
  ) {
    const client = preferredProvider === 'gemini' ? gemini : claude;
    if (client) {
      this.executor = new ToolExecutor(client, tools, logger);
    } else if (claude || gemini) {
      this.executor = new ToolExecutor((claude || gemini)!, tools, logger);
    }
  }

  async run(instruction: string): Promise<string> {
    const start = Date.now();

    if (!this.executor) return '[No LLM provider configured for Planning]';

    try {
      // Restrict to read-only tools
      const readOnlyTools = this.tools.getTools().filter(t => 
        ['read_file', 'glob', 'grep', 'ls', 'bash', 'web_fetch'].includes(t.name)
      );
      
      const output = await this.executor.runLoopAndReturnString(
        SYSTEM_PROMPT,
        [{ role: 'user', content: instruction }],
        readOnlyTools,
        this.preferredProvider === 'gemini' ? { variant: 'pro' } : {}
      );
      
      const duration = Date.now() - start;
      this.logger.debug({ duration, chars: output.length }, 'PlannerAgent complete');
      return output.trim() || '[No plan output]';
    } catch (err) {
      this.logger.warn({ err }, 'PlannerAgent failed');
      return `[PlannerAgent failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
}
