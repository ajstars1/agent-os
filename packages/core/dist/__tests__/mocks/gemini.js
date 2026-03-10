export class MockGeminiClient {
    classifyResult;
    constructor(classifyResult = 'claude') {
        this.classifyResult = classifyResult;
    }
    async *stream(_messages, _systemPrompt) {
        yield { type: 'text', content: 'mock gemini response' };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 10 } };
        yield { type: 'done' };
    }
    async classify(_message) {
        return this.classifyResult;
    }
}
//# sourceMappingURL=gemini.js.map