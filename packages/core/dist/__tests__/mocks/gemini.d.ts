import type { StreamChunk } from '@agent-os/shared';
import type { GeminiMessage } from '../../llm/gemini.js';
export declare class MockGeminiClient {
    private classifyResult;
    constructor(classifyResult?: 'claude' | 'gemini');
    stream(_messages: GeminiMessage[], _systemPrompt: string): AsyncGenerator<StreamChunk>;
    classify(_message: string): Promise<'claude' | 'gemini'>;
}
//# sourceMappingURL=gemini.d.ts.map