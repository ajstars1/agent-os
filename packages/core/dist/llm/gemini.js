import { GoogleGenerativeAI } from '@google/generative-ai';
export class GeminiClient {
    genAI;
    constructor(apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
    }
    async *stream(messages, systemPrompt) {
        const model = this.genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            systemInstruction: systemPrompt,
        });
        const history = messages.slice(0, -1).map((m) => ({
            role: m.role,
            parts: m.parts,
        }));
        const lastMessage = messages[messages.length - 1];
        const userInput = lastMessage?.parts.map((p) => p.text).join('') ?? '';
        const chat = model.startChat({ history });
        const result = await chat.sendMessageStream(userInput);
        for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
                yield { type: 'text', content: text };
            }
        }
        const finalResponse = await result.response;
        const usageMeta = finalResponse.usageMetadata;
        if (usageMeta) {
            yield {
                type: 'usage',
                usage: {
                    inputTokens: usageMeta.promptTokenCount ?? 0,
                    outputTokens: usageMeta.candidatesTokenCount ?? 0,
                },
            };
        }
        yield { type: 'done' };
    }
    async classify(message) {
        const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `You are a routing classifier. Reply with exactly one word: "claude" or "gemini".
Route to "claude" for: code generation, architecture, writing, analysis, complex reasoning, debugging, system design.
Route to "gemini" for: quick lookups, search, simple Q&A, scheduling, conversions, calculations, brief summaries.
Message: ${message}`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim().toLowerCase();
        return text.startsWith('gemini') ? 'gemini' : 'claude';
    }
}
//# sourceMappingURL=gemini.js.map