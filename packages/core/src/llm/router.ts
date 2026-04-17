import type { LLMProvider } from '@agent-os-core/shared';
import type { GeminiVariant } from './gemini.js';

/** Minimal interface LLMRouter needs from GeminiClient — allows mock injection in tests */
export interface IClassifier {
  classify(message: string): Promise<'claude' | 'gemini'>;
}

const CLAUDE_PREFIX = 'cc:';
const GEMINI_PREFIX = 'g:';

export interface ParsedModel {
  provider: 'claude' | 'gemini';
  variant?: GeminiVariant;
}

const VALID_GEMINI_VARIANTS: GeminiVariant[] = ['flash', 'pro', 'flash-thinking', 'pro-thinking'];

export class LLMRouter {
  constructor(
    private readonly geminiClient: IClassifier | null,
    private readonly defaultModel: LLMProvider,
  ) {}

  /** Parse a model string like 'gemini:flash' or 'claude' into provider + variant. */
  parseForceModel(model: string | undefined): ParsedModel | undefined {
    if (!model || model === 'auto') return undefined;
    if (model === 'claude') return { provider: 'claude' };
    if (model === 'gemini') return { provider: 'gemini', variant: 'flash' };
    if (model.startsWith('gemini:')) {
      const variant = model.slice('gemini:'.length) as GeminiVariant;
      if (VALID_GEMINI_VARIANTS.includes(variant)) {
        return { provider: 'gemini', variant };
      }
      return { provider: 'gemini', variant: 'flash' };
    }
    return undefined;
  }

  async route(message: string, forceModel?: LLMProvider): Promise<'claude' | 'gemini'> {
    if (forceModel === 'claude') return 'claude';
    if (forceModel === 'gemini') return 'gemini';
    // gemini:* variants also force gemini
    if (typeof forceModel === 'string' && forceModel.startsWith('gemini:')) return 'gemini';

    if (message.startsWith(CLAUDE_PREFIX)) return 'claude';
    if (message.startsWith(GEMINI_PREFIX)) return 'gemini';

    if (this.defaultModel === 'claude') return 'claude';
    if (this.defaultModel === 'gemini') return 'gemini';
    // defaultModel is a gemini variant
    if (typeof this.defaultModel === 'string' && (this.defaultModel as string).startsWith('gemini:')) return 'gemini';

    if (!this.geminiClient) return 'claude';

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
