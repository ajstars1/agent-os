import type { StreamChunk } from '@agent-os/shared';
export type GeminiMessage = {
    role: 'user' | 'model';
    parts: Array<{
        text: string;
    }>;
};
export declare class GeminiClient {
    private readonly genAI;
    constructor(apiKey: string);
    stream(messages: GeminiMessage[], systemPrompt: string): AsyncGenerator<StreamChunk>;
    classify(message: string): Promise<'claude' | 'gemini'>;
}
//# sourceMappingURL=gemini.d.ts.map