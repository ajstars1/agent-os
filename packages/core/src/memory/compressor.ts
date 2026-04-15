import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import type { TieredStore, KnowledgeChunk } from './tiered-store.js';

const MODEL = 'gemini-3.1-flash-lite-preview';

const L0_TOKENS = 8;    // 5–10 tokens target
const L1_TOKENS = 35;   // 20–50 tokens target
const L2_TOKENS = 150;  // 100–200 tokens target

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class HAMCompressor {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly store: TieredStore,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Compress raw text into all 4 levels.
   * Caches L0/L1/L2 in SQLite — will never re-compress the same content.
   */
  async compressChunk(
    rawText: string,
    topic: string,
    tags: string[] = [],
  ): Promise<Omit<KnowledgeChunk, 'id' | 'lastAccessed' | 'accessCount'>> {
    const hash = contentHash(rawText);
    const cached = this.store.getCachedCompression(hash);

    if (cached) {
      return { topic, tags, L0: cached.l0, L1: cached.l1, L2: cached.l2, L3: rawText };
    }

    const [L0, L1, L2] = await Promise.all([
      this.compress(rawText, L0_TOKENS, 'headline (5-10 words)'),
      this.compress(rawText, L1_TOKENS, 'summary (20-50 words)'),
      this.compress(rawText, L2_TOKENS, 'detailed summary (100-200 words)'),
    ]);

    this.store.setCachedCompression(hash, L0, L1, L2);
    return { topic, tags, L0, L1, L2, L3: rawText };
  }

  private async compress(
    text: string,
    targetTokens: number,
    description: string,
  ): Promise<string> {
    const prompt = `Compress the following text into a ${description} of approximately ${targetTokens} tokens.
Write ONLY the compressed output — no preamble, no labels, no quotes.

Text to compress:
${text.slice(0, 8000)}`;

    try {
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt,
      });
      return (response.text ?? '').trim();
    } catch {
      const words = text.split(/\s+/).slice(0, Math.ceil(targetTokens * 0.75));
      return words.join(' ').slice(0, targetTokens * 4);
    }
  }
}
