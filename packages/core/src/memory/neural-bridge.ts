/**
 * packages/core/src/memory/neural-bridge.ts
 * ==========================================
 * HTTP client for the AgentOS Neural Engine's `/process_memory` endpoint.
 *
 * Usage:
 * ```ts
 * const bridge = new NeuralBridge("http://localhost:8000");
 *
 * const isUp = await bridge.isAvailable();
 * if (isUp) {
 *   const result = await bridge.processMemory(
 *     "What is the capital of France?",
 *     "session-abc123",
 *   );
 *   console.log(result?.astrocyteState); // [0.0032]
 * }
 * ```
 *
 * Error handling:
 * - Network failures or non-2xx responses return `null` — callers should fall
 *   back to non-neural memory rather than crashing.
 * - Detailed errors are logged to `console.error` so they are visible in
 *   server logs without surfacing to end-users.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Request body sent to POST /process_memory */
export interface NeuralMemoryRequest {
  /** The working-context text to process. */
  text: string;
  /** Opaque session identifier; the server maintains astrocyte state per key. */
  session_id: string;
}

/** Successful response from POST /process_memory */
export interface NeuralMemoryResponse {
  session_id: string;
  /** 3-D shape of the ASE output tensor: [batch, seq_len, d_model] */
  output_shape: [number, number, number];
  /** Updated astrocyte state — one float per sample in the batch */
  astrocyte_state: number[];
}

/**
 * Normalised result returned by {@link NeuralBridge.processMemory}.
 * Field names are camelCased for idiomatic TypeScript.
 */
export interface NeuralMemoryResult {
  sessionId: string;
  /** [batch, seq_len, d_model] */
  outputShape: [number, number, number];
  /** Per-sample astrocyte state values */
  astrocyteState: number[];
}

/** Status response from GET /health */
interface HealthResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// NeuralBridge
// ---------------------------------------------------------------------------

export class NeuralBridge {
  /** Base URL of the Python FastAPI engine (no trailing slash). */
  readonly baseUrl: string;

  /**
   * @param baseUrl - URL of the Python engine. Defaults to `http://localhost:8000`.
   *                  Override for staging/production deployments.
   */
  constructor(baseUrl = 'http://localhost:8000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ping the engine's health endpoint.
   *
   * @returns `true` if the engine is reachable and healthy, `false` otherwise.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000), // 3 second timeout
      });
      if (!res.ok) return false;
      const body = (await res.json()) as HealthResponse;
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Send `text` to the neural engine for memory processing.
   *
   * The engine embeds the text character-by-character, runs it through the
   * {@link AstroSymbolicEpisodicLayer}, and returns the output shape and the
   * updated astrocyte state for this session.
   *
   * @param text      - Working context (conversation text, page content, etc.)
   * @param sessionId - Session key; the engine persists astrocyte state per key.
   * @returns         Parsed {@link NeuralMemoryResult}, or `null` on any error.
   */
  async processMemory(
    text: string,
    sessionId: string,
  ): Promise<NeuralMemoryResult | null> {
    if (!text.trim()) {
      console.warn('[NeuralBridge] processMemory called with empty text — skipping.');
      return null;
    }

    const payload: NeuralMemoryRequest = { text, session_id: sessionId };

    try {
      const res = await fetch(`${this.baseUrl}/process_memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000), // 10 second timeout
      });

      if (!res.ok) {
        const errorBody = await res.text();
        console.error(
          `[NeuralBridge] POST /process_memory failed: ${res.status} ${res.statusText}\n${errorBody}`,
        );
        return null;
      }

      const data = (await res.json()) as NeuralMemoryResponse;
      return this._toResult(data);
    } catch (err) {
      console.error('[NeuralBridge] Network error in processMemory:', err);
      return null;
    }
  }

  /**
   * Convenience wrapper: send the current working context and retrieve the
   * neural state. Equivalent to {@link processMemory} with a descriptive name
   * matching the intended use-case in the agent memory pipeline.
   *
   * @param context   - Current working context string (e.g. conversation history).
   * @param sessionId - Session identifier.
   */
  async retrieveNeuralState(
    context: string,
    sessionId: string,
  ): Promise<NeuralMemoryResult | null> {
    return this.processMemory(context, sessionId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Convert snake_case API response to camelCase TypeScript result. */
  private _toResult(raw: NeuralMemoryResponse): NeuralMemoryResult {
    return {
      sessionId: raw.session_id,
      outputShape: raw.output_shape,
      astrocyteState: raw.astrocyte_state,
    };
  }
}
