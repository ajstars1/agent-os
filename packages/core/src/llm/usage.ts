export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** Official pricing snapshot (USD per 1M tokens). Keep in sync with Anthropic docs. */
const CLAUDE_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-20250514':    { inputPerM: 15.00, outputPerM: 75.00,  cacheReadPerM: 1.50,  cacheWritePerM: 18.75 },
  'claude-opus-4-5':           { inputPerM: 15.00, outputPerM: 75.00,  cacheReadPerM: 1.50,  cacheWritePerM: 18.75 },
  'claude-sonnet-4-20250514':  { inputPerM: 3.00,  outputPerM: 15.00,  cacheReadPerM: 0.30,  cacheWritePerM: 3.75  },
  'claude-sonnet-4-6':         { inputPerM: 3.00,  outputPerM: 15.00,  cacheReadPerM: 0.30,  cacheWritePerM: 3.75  },
  'claude-sonnet-4-5':         { inputPerM: 3.00,  outputPerM: 15.00,  cacheReadPerM: 0.30,  cacheWritePerM: 3.75  },
  'claude-haiku-4-5-20251001': { inputPerM: 0.80,  outputPerM: 4.00,   cacheReadPerM: 0.08,  cacheWritePerM: 1.00  },
  'claude-haiku-4-5':          { inputPerM: 0.80,  outputPerM: 4.00,   cacheReadPerM: 0.08,  cacheWritePerM: 1.00  },
};

/** Estimate USD cost for a single API call. Returns 0 for unknown models. */
export function estimateCost(usage: CanonicalUsage, model: string): number {
  const pricing = CLAUDE_PRICING[model];
  if (!pricing) return 0;

  const M = 1_000_000;
  let cost = (usage.inputTokens / M) * pricing.inputPerM
           + (usage.outputTokens / M) * pricing.outputPerM;

  if (usage.cacheReadTokens && pricing.cacheReadPerM) {
    cost += (usage.cacheReadTokens / M) * pricing.cacheReadPerM;
  }
  if (usage.cacheWriteTokens && pricing.cacheWritePerM) {
    cost += (usage.cacheWriteTokens / M) * pricing.cacheWritePerM;
  }
  return cost;
}

/** Format cost as a human-readable string (e.g. "$0.0042"). */
export function formatCost(usd: number): string {
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
}

/** Running session cost accumulator. */
export class SessionCostTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCostUsd = 0;
  private callCount = 0;

  record(usage: CanonicalUsage, model: string): number {
    const cost = estimateCost(usage, model);
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.totalCostUsd += cost;
    this.callCount++;
    return cost;
  }

  summary(): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostUsd: number;
  } {
    return {
      calls: this.callCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cacheReadTokens: this.totalCacheReadTokens,
      cacheWriteTokens: this.totalCacheWriteTokens,
      totalCostUsd: this.totalCostUsd,
    };
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.totalCostUsd = 0;
    this.callCount = 0;
  }
}
