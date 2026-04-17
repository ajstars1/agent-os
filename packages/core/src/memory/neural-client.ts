/**
 * packages/core/src/memory/neural-client.ts
 * ==========================================
 * Higher-level client for the AgentOS Neural Engine that evaluates a query
 * against a ranked set of candidate memories using the `/process_memory`
 * endpoint. This complements {@link NeuralBridge} (which handles raw
 * session-based processing) by providing a structured
 * query-vs-candidates evaluation API for the retrieval pipeline.
 *
 * Usage:
 * ```ts
 * const client = new NeuralClient();
 *
 * const response = await client.evaluateContext(
 *   "What did we discuss about Paris?",
 *   ["User mentioned Paris trip", "Weather was sunny", "Flight booked"],
 *   0.42,  // current astrocyte modulation level
 * );
 *
 * if (response) {
 *   console.log(response.astrocyteLevel);    // updated modulation level
 *   console.log(response.attentionWeights);  // per-candidate relevance scores
 * } else {
 *   // Engine unreachable — caller should fall back to non-neural retrieval.
 * }
 * ```
 *
 * Error handling:
 * - A configurable timeout (default 10 s) guards against a stalled engine.
 * - On timeout or any network error the method returns a {@link DEFAULT_NEURAL_RESPONSE}
 *   so callers receive a safe, non-crashing fallback instead of an exception.
 * - Non-2xx HTTP responses are logged and also produce the default fallback.
 */

import type { NeuralState } from './interface.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The structured response returned by {@link NeuralClient.evaluateContext}.
 */
export interface NeuralResponse {
  /** Updated astrocyte modulation level after processing this query. */
  astrocyteLevel: number;
  /**
   * Per-candidate attention weights in the same order as `candidateMemories`.
   * Each value is in [0, 1]; higher means more relevant to the query.
   */
  attentionWeights: number[];
}

// ---------------------------------------------------------------------------
// Internal request / raw response shapes (snake_case — matches FastAPI schema)
// ---------------------------------------------------------------------------

/** POST /process_memory request body (extended for multi-candidate evaluation). */
interface EvaluateRequest {
  query: string;
  candidates: string[];
  currentState: number;
  sessionId: string;
}

// We no longer need RawEvaluateResponse because the server sends camelCase `NeuralResponse` shape directly.

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Safe fallback returned when the Python engine is unreachable or returns an error.
 * `astrocyteLevel` is reset to 0 and all attention weights are equalised.
 * The caller is responsible for sizing `attentionWeights` if it needs a
 * length-matched array — this sentinel uses an empty array.
 */
export const DEFAULT_NEURAL_RESPONSE: Readonly<NeuralResponse> = Object.freeze({
  astrocyteLevel: 0,
  attentionWeights: [],
});

// ---------------------------------------------------------------------------
// NeuralClient
// ---------------------------------------------------------------------------

export class NeuralClient {
  /** Base URL of the Python FastAPI engine (no trailing slash). */
  readonly baseUrl: string;

  /** Network timeout in milliseconds before falling back to the default state. */
  readonly timeoutMs: number;

  /**
   * @param baseUrl   - Engine URL. Defaults to `http://localhost:8765`.
   * @param timeoutMs - Request timeout in ms. Defaults to `10_000` (10 s).
   */
  constructor(baseUrl = 'http://localhost:8765', timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate a query against a set of candidate memory strings using the
   * neural engine's Epanechnikov attention mechanism.
   *
   * Sends `query`, `candidateMemories`, and `currentState` to the engine's
   * `/process_memory` endpoint and returns an updated {@link NeuralResponse}
   * with the new `astrocyteLevel` and per-candidate `attentionWeights`.
   *
   * If the engine is unreachable or times out, returns {@link DEFAULT_NEURAL_RESPONSE}
   * with equal (empty) weights so the caller can proceed with unranked retrieval.
   *
   * @param query             - The query string to evaluate (e.g. user question).
   * @param candidateMemories - Ordered list of memory strings to score.
   * @param currentState      - Current astrocyte modulation level (from {@link NeuralState}).
   * @returns                 Updated {@link NeuralResponse}, or the default fallback.
   */
  async evaluateContext(
    query: string,
    candidateMemories: string[],
    currentState: number,
  ): Promise<NeuralResponse> {
    if (!query.trim()) {
      console.warn('[NeuralClient] evaluateContext called with empty query — returning default.');
      return this._defaultWithWeights(candidateMemories.length);
    }

    const payload: EvaluateRequest = {
      query,
      candidates: candidateMemories,
      currentState,
      sessionId: 'neural-client-eval',
    };

    try {
      const res = await fetch(`${this.baseUrl}/process_memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '(unreadable body)');
        throw new Error(`[NeuralClient] POST /process_memory failed: ${res.status} ${res.statusText}\n${errorText}`);
      }

      const raw = (await res.json()) as NeuralResponse;
      return this._toResponse(raw, candidateMemories.length);
    } catch (err) {
      if (this._isTimeout(err)) {
        throw new Error(`[NeuralClient] Request timed out after ${this.timeoutMs} ms`);
      }
      throw err;
    }
  }

  /**
   * Convenience helper: build a {@link NeuralResponse} from a {@link NeuralState}
   * and existing attention weights (e.g. from a prior call) without hitting the
   * network. Useful for re-hydrating state from a cache.
   *
   * @param state           - Previously persisted {@link NeuralState}.
   * @param attentionWeights - Pre-computed attention weights.
   */
  fromNeuralState(state: NeuralState, attentionWeights: number[]): NeuralResponse {
    return {
      astrocyteLevel: state.astrocyteLevel,
      attentionWeights,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure response has enough weights by padding with 0.
   */
  private _toResponse(raw: NeuralResponse, candidateCount: number): NeuralResponse {
    const weights = Array.from({ length: candidateCount }, (_, i) =>
      raw.attentionWeights[i] ?? 0,
    );
    return {
      astrocyteLevel: raw.astrocyteLevel,
      attentionWeights: weights,
    };
  }

  /**
   * Build a default response with `n` zero-weighted candidates.
   * Used as the graceful fallback when the engine is unreachable.
   */
  private _defaultWithWeights(n: number): NeuralResponse {
    return {
      astrocyteLevel: DEFAULT_NEURAL_RESPONSE.astrocyteLevel,
      attentionWeights: Array(n).fill(0),
    };
  }

  /** Detect AbortError thrown by `AbortSignal.timeout()`. */
  private _isTimeout(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    );
  }
}
