import type { LLMProvider } from '@agent-os-core/shared';
import type { GeminiVariant } from './gemini.js';

/** Minimal interface LLMRouter needs from GeminiClient — allows mock injection in tests */
export interface IClassifier {
  classify(message: string): Promise<'claude' | 'gemini'>;
}

const CLAUDE_PREFIX = 'cc:';
const GEMINI_PREFIX = 'g:';
const OR_PREFIX = 'or:';
const OL_PREFIX = 'ol:';

export type RoutedProvider = 'claude' | 'gemini' | 'openrouter' | 'ollama';

export interface ParsedModel {
  provider: 'claude' | 'gemini' | 'openrouter' | 'ollama';
  variant?: GeminiVariant;
  /** OpenRouter model ID (e.g. "openai/gpt-4o") */
  orModel?: string;
  /** Ollama model name (e.g. "llama3.2") */
  olModel?: string;
}

const VALID_GEMINI_VARIANTS: GeminiVariant[] = ['flash', 'pro', 'flash-thinking', 'pro-thinking'];

export class LLMRouter {
  constructor(
    private readonly geminiClient: IClassifier | null,
    private readonly defaultModel: LLMProvider,
  ) {}

  /** Parse a model string like 'gemini:flash', 'or:gpt-4o', or 'ol:llama3.2' into provider + variant. */
  parseForceModel(model: string | undefined): ParsedModel | undefined {
    if (!model || model === 'auto') return undefined;
    if (model === 'claude') return { provider: 'claude' };
    if (model === 'gemini') return { provider: 'gemini', variant: 'flash' };
    if (model === 'openrouter') return { provider: 'openrouter' };
    if (model === 'ollama') return { provider: 'ollama' };
    if (model.startsWith('gemini:')) {
      const variant = model.slice('gemini:'.length) as GeminiVariant;
      if (VALID_GEMINI_VARIANTS.includes(variant)) {
        return { provider: 'gemini', variant };
      }
      return { provider: 'gemini', variant: 'flash' };
    }
    if (model.startsWith('or:')) {
      const orModel = model.slice('or:'.length).trim() || undefined;
      return { provider: 'openrouter', orModel };
    }
    if (model.startsWith('ol:')) {
      const olModel = model.slice('ol:'.length).trim() || undefined;
      return { provider: 'ollama', olModel };
    }
    return undefined;
  }

  /**
   * Route a message to a provider. Checks prefix first, then forceModel,
   * then defaultModel, then auto-classifies.
   */
  async route(message: string, forceModel?: LLMProvider): Promise<RoutedProvider> {
    // Inline prefix overrides everything
    if (message.startsWith(CLAUDE_PREFIX)) return 'claude';
    if (message.startsWith(GEMINI_PREFIX)) return 'gemini';
    if (message.startsWith(OR_PREFIX)) return 'openrouter';
    if (message.startsWith(OL_PREFIX)) return 'ollama';

    if (forceModel === 'claude') return 'claude';
    if (forceModel === 'gemini') return 'gemini';
    if (forceModel === 'openrouter') return 'openrouter';
    if (forceModel === 'ollama') return 'ollama';
    if (typeof forceModel === 'string' && forceModel.startsWith('gemini:')) return 'gemini';
    if (typeof forceModel === 'string' && forceModel.startsWith('or:')) return 'openrouter';
    if (typeof forceModel === 'string' && forceModel.startsWith('ol:')) return 'ollama';

    if (this.defaultModel === 'claude') return 'claude';
    if (this.defaultModel === 'gemini') return 'gemini';
    if (this.defaultModel === 'openrouter') return 'openrouter';
    if (this.defaultModel === 'ollama') return 'ollama';
    if (typeof this.defaultModel === 'string' && (this.defaultModel as string).startsWith('gemini:')) return 'gemini';

    if (!this.geminiClient) return 'claude';

    try {
      return await this.geminiClient.classify(message);
    } catch {
      return 'claude';
    }
  }

  /**
   * Extract the OR/OL model name from an inline prefix.
   * "or:gpt-4o tell me..." → { orModel: "gpt-4o" }
   * "ol:llama3.2 tell me..." → { olModel: "llama3.2" }
   * "or: tell me..." → {} (use default)
   */
  extractInlineModel(message: string): { orModel?: string; olModel?: string } {
    if (message.startsWith(OR_PREFIX)) {
      const rest = message.slice(OR_PREFIX.length);
      // If next token has no space it may be a model name, e.g. "or:gpt-4o something"
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx > 0 && spaceIdx < 40) {
        const candidate = rest.slice(0, spaceIdx);
        // A model name contains letters, digits, hyphens, dots, slashes
        if (/^[\w./-]+$/.test(candidate)) {
          return { orModel: candidate };
        }
      }
      return {};
    }
    if (message.startsWith(OL_PREFIX)) {
      const rest = message.slice(OL_PREFIX.length);
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx > 0 && spaceIdx < 40) {
        const candidate = rest.slice(0, spaceIdx);
        if (/^[\w.:/-]+$/.test(candidate)) {
          return { olModel: candidate };
        }
      }
      return {};
    }
    return {};
  }

  /** Strip routing prefix (and optional inline model name) from message */
  stripPrefix(message: string): string {
    if (message.startsWith(CLAUDE_PREFIX)) return message.slice(CLAUDE_PREFIX.length).trim();
    if (message.startsWith(GEMINI_PREFIX)) return message.slice(GEMINI_PREFIX.length).trim();

    if (message.startsWith(OR_PREFIX)) {
      const rest = message.slice(OR_PREFIX.length);
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx > 0 && spaceIdx < 40) {
        const candidate = rest.slice(0, spaceIdx);
        if (/^[\w./-]+$/.test(candidate)) return rest.slice(spaceIdx).trim();
      }
      return rest.trim();
    }

    if (message.startsWith(OL_PREFIX)) {
      const rest = message.slice(OL_PREFIX.length);
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx > 0 && spaceIdx < 40) {
        const candidate = rest.slice(0, spaceIdx);
        if (/^[\w.:/-]+$/.test(candidate)) return rest.slice(spaceIdx).trim();
      }
      return rest.trim();
    }

    return message;
  }
}
