export class MockClaudeClient {
    responses;
    callIndex = 0;
    constructor(responses = []) {
        this.responses = responses;
    }
    async *stream(_messages, _system, _tools) {
        const chunks = this.responses[this.callIndex] ?? [
            { type: 'text', content: 'mock claude response' },
            { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
            { type: 'done' },
        ];
        this.callIndex++;
        for (const chunk of chunks) {
            yield chunk;
        }
    }
}
//# sourceMappingURL=anthropic.js.map