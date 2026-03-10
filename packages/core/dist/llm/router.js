const CLAUDE_PREFIX = 'cc:';
const GEMINI_PREFIX = 'g:';
export class LLMRouter {
    geminiClient;
    defaultModel;
    constructor(geminiClient, defaultModel) {
        this.geminiClient = geminiClient;
        this.defaultModel = defaultModel;
    }
    async route(message, forceModel) {
        if (forceModel === 'claude')
            return 'claude';
        if (forceModel === 'gemini')
            return 'gemini';
        // Prefix-based routing
        if (message.startsWith(CLAUDE_PREFIX))
            return 'claude';
        if (message.startsWith(GEMINI_PREFIX))
            return 'gemini';
        // Default model override
        if (this.defaultModel === 'claude')
            return 'claude';
        if (this.defaultModel === 'gemini')
            return 'gemini';
        // No Gemini client — always use Claude
        if (!this.geminiClient)
            return 'claude';
        // Auto: classify via Gemini Flash
        try {
            return await this.geminiClient.classify(message);
        }
        catch {
            return 'claude';
        }
    }
    /** Strip routing prefix from message before sending to LLM */
    stripPrefix(message) {
        if (message.startsWith(CLAUDE_PREFIX))
            return message.slice(CLAUDE_PREFIX.length).trim();
        if (message.startsWith(GEMINI_PREFIX))
            return message.slice(GEMINI_PREFIX.length).trim();
        return message;
    }
}
//# sourceMappingURL=router.js.map