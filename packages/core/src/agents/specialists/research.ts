/**
 * ResearchAgent — web-grounded research using Gemini + Google Search.
 *
 * Uses streamSearch() for real-time facts, not just the model's training data.
 * Falls back to a standard Gemini stream if search is unavailable.
 */

import type { GeminiClient } from '../../llm/gemini.js';
import type { Logger } from '@agent-os-core/shared';

const SYSTEM_PROMPT = `You are a research agent with access to live web search.
Provide factual, current information. Structure your answer with:
- A direct answer to the question (1-2 sentences)
- Supporting detail with specific facts, numbers, or examples
- Sources inline if relevant (e.g. "According to X...")
Be concise. Do not pad. Max 300 words unless depth is explicitly required.`;

export class ResearchAgent {
  constructor(
    private readonly gemini: GeminiClient,
    private readonly logger: Logger,
  ) {}

  async run(instruction: string): Promise<string> {
    const start = Date.now();
    try {
      let output = '';
      for await (const chunk of this.gemini.streamSearch(instruction, SYSTEM_PROMPT)) {
        if (chunk.type === 'text' && chunk.content) output += chunk.content;
      }
      const duration = Date.now() - start;
      this.logger.debug({ duration, chars: output.length }, 'ResearchAgent complete');
      return output.trim() || '[No research results]';
    } catch (err) {
      this.logger.warn({ err }, 'ResearchAgent failed');
      // Fallback: standard stream without search
      let output = '';
      for await (const chunk of this.gemini.stream(
        [{ role: 'user', content: instruction }],
        SYSTEM_PROMPT,
        [],
        { variant: 'pro' },
      )) {
        if (chunk.type === 'text' && chunk.content) output += chunk.content;
      }
      return output.trim() || '[Research unavailable]';
    }
  }
}
