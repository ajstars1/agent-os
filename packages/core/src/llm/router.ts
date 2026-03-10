import type { LLMProvider } from '@agent-os/shared';

/** Minimal interface LLMRouter needs from GeminiClient — allows mock injection in tests */
export interface IClassifier {
  classify(message: string): Promise<'claude' | 'gemini'>;
}

const CLAUDE_PREFIX = 'cc:';
const GEMINI_PREFIX = 'g:';

export class LLMRouter {
  constructor(
    private readonly geminiClient: IClassifier | null,
    private readonly defaultModel: LLMProvider,
  ) {}

  async route(message: string, forceModel?: LLMProvider): Promise<'claude' | 'gemini'> {
    if (forceModel === 'claude') return 'claude';
    if (forceModel === 'gemini') return 'gemini';

    // Prefix-based routing
    if (message.startsWith(CLAUDE_PREFIX)) return 'claude';
    if (message.startsWith(GEMINI_PREFIX)) return 'gemini';

    // Default model override
    if (this.defaultModel === 'claude') return 'claude';
    if (this.defaultModel === 'gemini') return 'gemini';

    // No Gemini client — always use Claude
    if (!this.geminiClient) return 'claude';

    // Auto: classify via Gemini Flash
    try {
      return await this.geminiClient.classify(message);
    } catch {
      return 'claude';
    }
  }

  /** Strip routing prefix from message before sending to LLM */
  stripPrefix(message: string): string {
    if (message.startsWith(CLAUDE_PREFIX)) return message.slice(CLAUDE_PREFIX.length).trim();
    if (message.startsWith(GEMINI_PREFIX)) return message.slice(GEMINI_PREFIX.length).trim();
    return message;
  }
}
