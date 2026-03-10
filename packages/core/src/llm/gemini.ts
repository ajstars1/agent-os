import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import type { StreamChunk } from '@agent-os/shared';

export type GeminiMessage = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

export class GeminiClient {
  private readonly genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async *stream(
    messages: GeminiMessage[],
    systemPrompt: string,
  ): AsyncGenerator<StreamChunk> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
    });

    const history: Content[] = messages.slice(0, -1).map((m) => ({
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

  async classify(message: string): Promise<'claude' | 'gemini'> {
    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `You are a routing classifier. Reply with exactly one word: "claude" or "gemini".

Default to "claude". Only route to "gemini" when the task is clearly large-context or token-heavy:
Route to "gemini" for: summarising very long documents, processing large files, bulk data extraction, tasks where input or output exceeds ~4000 tokens, translation of long texts.
Route to "claude" for: everything else — reasoning, coding, debugging, writing, analysis, short Q&A, planning, system design, math, logic.

Message: ${message}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().toLowerCase();
    return text.startsWith('gemini') ? 'gemini' : 'claude';
  }
}
