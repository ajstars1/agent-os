import { GoogleGenAI } from '@google/genai';
import type { StreamChunk } from '@agent-os/shared';

export type GeminiVariant =
  | 'flash'
  | 'flash-lite'
  | 'pro'
  | 'flash-thinking'
  | 'pro-thinking';

const GEMINI_MODEL_IDS: Record<GeminiVariant, string> = {
  'flash':          'gemini-3-flash-preview',
  'flash-lite':     'gemini-3.1-flash-lite-preview',
  'pro':            'gemini-3.1-pro-preview',
  'flash-thinking': 'gemini-3-flash-preview',
  'pro-thinking':   'gemini-3.1-pro-preview',
};

export type GeminiMessage = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

export class GeminiClient {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(
    messages: GeminiMessage[],
    systemPrompt: string,
    variant: GeminiVariant = 'flash',
  ): AsyncGenerator<StreamChunk> {
    const modelId = GEMINI_MODEL_IDS[variant];

    const stream = await this.ai.models.generateContentStream({
      model: modelId,
      contents: messages.map((m) => ({ role: m.role, parts: m.parts })),
      config: { systemInstruction: systemPrompt },
    });

    let lastResponse = null;

    for await (const chunk of stream) {
      // Thinking parts (2.5 models emit thought: true parts)
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (!('text' in part) || !part.text) continue;
        const raw = part as { text: string; thought?: boolean };
        if (raw.thought) {
          yield { type: 'thinking', content: raw.text };
        }
      }

      // Normal text
      if (chunk.text) yield { type: 'text', content: chunk.text };

      lastResponse = chunk;
    }

    if (lastResponse) {
      const usage = lastResponse.usageMetadata;
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
          },
        };
      }
    }

    yield { type: 'done' };
  }

  /** One-shot question with Google Search grounding. Streams text + sources. */
  async *streamSearch(
    question: string,
    systemInstruction?: string,
  ): AsyncGenerator<StreamChunk | { type: 'sources'; sources: Array<{ title: string; uri: string }> }> {
    const stream = await this.ai.models.generateContentStream({
      model: GEMINI_MODEL_IDS['flash'],
      contents: question,
      config: {
        tools: [{ googleSearch: {} }],
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    });

    let lastResponse = null;

    for await (const chunk of stream) {
      if (chunk.text) yield { type: 'text', content: chunk.text };
      lastResponse = chunk;
    }

    if (lastResponse) {
      // Grounding sources
      const groundingMeta = lastResponse.candidates?.[0]?.groundingMetadata as
        | {
            groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
          }
        | undefined;

      if (groundingMeta?.groundingChunks && groundingMeta.groundingChunks.length > 0) {
        const sources = groundingMeta.groundingChunks
          .filter((c) => c.web?.uri)
          .map((c) => ({ title: c.web?.title ?? c.web?.uri ?? '', uri: c.web?.uri ?? '' }));
        if (sources.length > 0) yield { type: 'sources', sources };
      }

      const usage = lastResponse.usageMetadata;
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
          },
        };
      }
    }

    yield { type: 'done' };
  }

  /**
   * Zero-latency heuristic: pick the best Gemini variant for a message.
   *
   * Tiers (cheapest → most capable):
   *   flash           — simple Q&A, short tasks
   *   flash-thinking  — medium reasoning, why/how/compare/plan
   *   pro             — long-context, research, summarisation
   *   pro-thinking    — hard math, architecture, proofs, multi-step analysis
   */
  classifyVariant(message: string): GeminiVariant {
    const lower = message.toLowerCase().trim();
    const len   = message.length;

    const hardSignals = [
      'prove', 'proof', 'theorem', 'algorithm', 'design system',
      'architecture', 'trade-off', 'tradeoff', 'optimize',
      'step by step', 'explain why', 'how does.*work',
      'debug', 'root cause', 'performance issue',
    ];
    if (hardSignals.some((s) => lower.includes(s))) {
      return len > 150 ? 'pro-thinking' : 'flash-thinking';
    }

    const thinkSignals = [
      'think', 'reason', 'plan', 'strategy', 'compare', 'versus', ' vs ',
      'should i', 'best way', 'which is better', 'difference between',
      'recommend', 'decide', 'evaluate', 'review',
    ];
    if (thinkSignals.some((s) => lower.includes(s))) {
      return 'flash-thinking';
    }

    const proSignals = ['research', 'comprehensive', 'thorough', 'summarize', 'summary', 'analyze all'];
    if (proSignals.some((s) => lower.includes(s)) || len > 600) {
      return 'pro';
    }

    return 'flash';
  }

  async classify(message: string): Promise<'claude' | 'gemini'> {
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL_IDS['flash'],
      contents: `You are a routing classifier. Reply with exactly one word: "claude" or "gemini".

Default to "claude". Only route to "gemini" when the task is clearly large-context or token-heavy:
Route to "gemini" for: summarising very long documents, processing large files, bulk data extraction, tasks where input or output exceeds ~4000 tokens, translation of long texts.
Route to "claude" for: everything else — reasoning, coding, debugging, writing, analysis, short Q&A, planning, system design, math, logic.

Message: ${message}`,
    });
    const text = (response.text ?? '').trim().toLowerCase();
    return text.startsWith('gemini') ? 'gemini' : 'claude';
  }
}
