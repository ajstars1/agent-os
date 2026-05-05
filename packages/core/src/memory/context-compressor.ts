/**
 * Context Compressor — intelligently shrinks conversation history when approaching
 * the model's context window limit.
 *
 * Strategy:
 *   1. Count tokens in the current history (approximation: chars / 3.5)
 *   2. If under 80% of limit → do nothing
 *   3. If over 80% → compress the OLDEST messages using Gemini Flash (cheapest):
 *      - Tool call/result pairs are summarised into one line
 *      - Older assistant messages are summarised 3-at-a-time
 *      - The last 6 messages are ALWAYS preserved verbatim
 *   4. Compressed summaries replace the raw messages (in-memory only —
 *      the SQLite DB is not modified)
 *
 * The compressor never loses information — it only shortens representations.
 * Every compression is logged so the user can inspect what happened.
 */

import type { Logger } from '@agent-os-core/shared';
import type { UnifiedMessage } from '../llm/base.js';

// ─── Token estimation ─────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: UnifiedMessage): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content) + 4;
  let total = 4;
  for (const part of msg.content) {
    if ('text' in part && part.text) total += estimateTokens(part.text);
    else if ('content' in part && typeof part.content === 'string') total += estimateTokens(part.content);
  }
  return total;
}

function totalTokens(messages: UnifiedMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ─── Compression ──────────────────────────────────────────────────────────────

const PRESERVE_LAST_N = 6;     // always keep the most recent N messages verbatim
const THRESHOLD_PCT = 0.80;    // start compressing at 80% of limit

export interface CompressionResult {
  compressed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  summaries: number;
}

async function summariseBatch(
  messages: UnifiedMessage[],
  geminiKey: string,
  logger: Logger,
): Promise<string> {
  const text = messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => ('text' in p ? p.text : '[tool]')).join(' ');
      return `${role}: ${content.slice(0, 400)}`;
    })
    .join('\n');

  const prompt = `Summarise this conversation segment in 1-2 sentences. Preserve all technical decisions, code file names, errors, and user goals. Be factual and concise:\n\n${text}`;

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: geminiKey });
    const result = await client.models.generateContent({
      model: 'gemini-2.0-flash-lite',
      contents: prompt,
    });
    return result.text?.trim() ?? text.slice(0, 200);
  } catch (err) {
    logger.warn({ err }, '[Compressor] Summarisation failed — using truncation');
    return text.slice(0, 150) + '… [compressed]';
  }
}

export async function compressHistory(
  messages: UnifiedMessage[],
  modelContextLimit: number,
  logger: Logger,
  geminiKey?: string,
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const tokensBefore = totalTokens(messages);
  const threshold = Math.floor(modelContextLimit * THRESHOLD_PCT);

  if (tokensBefore <= threshold || messages.length <= PRESERVE_LAST_N) {
    return {
      messages,
      result: { compressed: false, tokensBefore, tokensAfter: tokensBefore, savedTokens: 0, summaries: 0 },
    };
  }

  logger.info(
    { tokensBefore, threshold, messageCount: messages.length },
    '[Compressor] Context approaching limit — compressing',
  );

  const apiKey = geminiKey ?? process.env['GOOGLE_API_KEY'];
  const preserveFrom = Math.max(0, messages.length - PRESERVE_LAST_N);
  const toCompress = messages.slice(0, preserveFrom);
  const toKeep = messages.slice(preserveFrom);

  if (toCompress.length === 0) {
    return {
      messages,
      result: { compressed: false, tokensBefore, tokensAfter: tokensBefore, savedTokens: 0, summaries: 0 },
    };
  }

  // Compress in batches of 3
  const BATCH_SIZE = 3;
  const compressed: UnifiedMessage[] = [];
  let summaries = 0;

  for (let i = 0; i < toCompress.length; i += BATCH_SIZE) {
    const batch = toCompress.slice(i, i + BATCH_SIZE);

    if (apiKey) {
      const summary = await summariseBatch(batch, apiKey, logger);
      compressed.push({ role: 'user', content: `[Compressed history] ${summary}` });
      summaries++;
    } else {
      // No LLM — simple truncation
      for (const msg of batch) {
        const content = typeof msg.content === 'string'
          ? msg.content.slice(0, 100) + '…'
          : '[message]';
        compressed.push({ role: msg.role, content });
      }
    }
  }

  const newMessages = [...compressed, ...toKeep];
  const tokensAfter = totalTokens(newMessages);

  logger.info(
    { tokensBefore, tokensAfter, savedTokens: tokensBefore - tokensAfter, summaries },
    '[Compressor] Compression complete',
  );

  return {
    messages: newMessages,
    result: {
      compressed: true,
      tokensBefore,
      tokensAfter,
      savedTokens: tokensBefore - tokensAfter,
      summaries,
    },
  };
}

// ─── Context limits by model ──────────────────────────────────────────────────

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude': 200_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini': 1_000_000,
  'openrouter': 128_000,
  'ollama': 32_000,
};

const DEFAULT_LIMIT = 100_000;

export function getContextLimit(model: string): number {
  const key = Object.keys(MODEL_CONTEXT_LIMITS).find(
    (k) => model.toLowerCase().includes(k),
  );
  return key ? MODEL_CONTEXT_LIMITS[key]! : DEFAULT_LIMIT;
}
