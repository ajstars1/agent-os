import type { LLMProvider } from '@agent-os/shared';
/** Minimal interface LLMRouter needs from GeminiClient — allows mock injection in tests */
export interface IClassifier {
    classify(message: string): Promise<'claude' | 'gemini'>;
}
export declare class LLMRouter {
    private readonly geminiClient;
    private readonly defaultModel;
    constructor(geminiClient: IClassifier | null, defaultModel: LLMProvider);
    route(message: string, forceModel?: LLMProvider): Promise<'claude' | 'gemini'>;
    /** Strip routing prefix from message before sending to LLM */
    stripPrefix(message: string): string;
}
//# sourceMappingURL=router.d.ts.map