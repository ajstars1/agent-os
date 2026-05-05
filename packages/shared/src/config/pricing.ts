/**
 * LLM pricing constants (USD per million tokens).
 * Update when Anthropic / Google change their rates.
 */

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude models (Anthropic)
  'claude-sonnet-4-6': { inputPerM: 3.00, outputPerM: 15.00, cacheReadPerM: 0.30 },
  'claude-opus-4-7':   { inputPerM: 15.00, outputPerM: 75.00, cacheReadPerM: 1.50 },
  'claude-haiku-4-5':  { inputPerM: 0.80, outputPerM: 4.00, cacheReadPerM: 0.08 },
  // Legacy / common aliases
  'claude':            { inputPerM: 3.00, outputPerM: 15.00, cacheReadPerM: 0.30 },

  // Gemini models (Google)
  'gemini-2.5-flash':  { inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.02 },
  'gemini-2.5-pro':    { inputPerM: 1.25, outputPerM: 5.00, cacheReadPerM: 0.32 },
  'gemini:flash':      { inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.02 },
  'gemini:pro':        { inputPerM: 1.25, outputPerM: 5.00, cacheReadPerM: 0.32 },
  'gemini:thinking':   { inputPerM: 3.50, outputPerM: 10.50, cacheReadPerM: 0.35 },
  'gemini':            { inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.02 },

  // OpenRouter (rough average — per-model lookup preferred)
  'openrouter':        { inputPerM: 1.00, outputPerM: 4.00, cacheReadPerM: 0.10 },

  // Ollama (local = free)
  'ollama':            { inputPerM: 0.00, outputPerM: 0.00, cacheReadPerM: 0.00 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerM: 3.00, outputPerM: 15.00, cacheReadPerM: 0.30 };

export function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? PRICING[model.split(':')[0]!] ?? DEFAULT_PRICING;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number {
  const p = getPricing(model);
  return (
    (inputTokens / 1_000_000) * p.inputPerM +
    (outputTokens / 1_000_000) * p.outputPerM +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerM
  );
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
