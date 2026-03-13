import type { NeuralState } from './interface.js';

// ---------------------------------------------------------------------------
// Dual-process cognitive routing
// ---------------------------------------------------------------------------

/**
 * System 1 — fast, low-surprise, routine response generation.
 * System 2 — slow, high-surprise, deliberative step-by-step reasoning loop.
 */
export type ProcessMode = 'SYSTEM_1' | 'SYSTEM_2';

/**
 * Threshold for the astrocyteLevel above which the router escalates to
 * System 2 (deep-thinking / research) mode.
 * Exposed as a constant so callers and tests can reference the same value.
 */
export const ASTROCYTE_SYSTEM2_THRESHOLD = 0.6;

/**
 * System-prompt fragment injected into the LLM context when routing to System 2.
 * The caller is responsible for prepending this to (or concatenating it with)
 * its existing system prompt before submitting to the model.
 */
export const SYSTEM2_PROMPT =
  'You are operating in deep-thinking mode due to a high-surprise signal from ' +
  'the neural memory layer. Before composing your final answer you MUST:\n' +
  '1. Restate the core question in your own words.\n' +
  '2. Identify the key unknowns or ambiguities.\n' +
  '3. Enumerate the relevant facts or sub-problems you need to resolve.\n' +
  '4. Work through each sub-problem step-by-step, citing your reasoning.\n' +
  '5. Only after completing steps 1–4, compose your final, concise answer.\n' +
  'Do not skip any step. Show your reasoning explicitly.';

/**
 * Result returned by {@link StateRouter.routeByAstrocyte}.
 */
export interface DualProcessDecision {
  /** Which cognitive mode the agent should use for this turn. */
  mode: ProcessMode;
  /**
   * When `mode` is `'SYSTEM_2'`, contains the step-by-step reasoning prompt
   * to prepend to the LLM system prompt. `undefined` when `mode` is `'SYSTEM_1'`.
   */
  systemPromptInjection?: string;
  /** The astrocyte level that triggered this decision (for logging/tracing). */
  astrocyteLevel: number;
}

// ---------------------------------------------------------------------------
// ConversationState
// ---------------------------------------------------------------------------

export type ConversationState =
  | 'INTRO'
  | 'PROBLEM'
  | 'SOLUTION'
  | 'FEATURES'
  | 'DEEP_DIVE'
  | 'CTA'
  | 'GENERAL';

export type RetrievalDepth = 'L0' | 'L1' | 'L2' | 'L3';

interface StatePattern {
  state: ConversationState;
  patterns: RegExp[];
}

// Order matters — evaluate specific patterns before generic ones.
// CTA/DEEP_DIVE/SOLUTION/FEATURES checked before INTRO because
// phrases like "what is the pricing" contain "what is" (INTRO trigger)
// but should resolve to CTA.
const STATE_PATTERNS: StatePattern[] = [
  {
    state: 'CTA',
    patterns: [
      /\bpric(e|ing)\b/i,
      /\bcost\b/i,
      /\bhow much\b/i,
      /\bget started\b/i,
      /\bnext steps?\b/i,
      /\bbook\b/i,
      /\bschedule\b/i,
      /\bsign up\b/i,
      /\btry (it|this|out)\b/i,
      /\bpurchase\b/i,
      /\bsubscri(be|ption)\b/i,
    ],
  },
  {
    state: 'DEEP_DIVE',
    patterns: [
      /\btell me more\b/i,
      /\bmore details?\b/i,
      /\bexplain\b/i,
      /\bdeep.?dive\b/i,
      /\bhow exactly\b/i,
      /\bwalk me through\b/i,
      /\belaborate\b/i,
      /\bspecifically\b/i,
      /\bunder the hood\b/i,
      /\btechnically\b/i,
    ],
  },
  {
    state: 'SOLUTION',
    patterns: [
      /\bhow do(es)? (you|it|this)\b/i,
      /\bhow does .* work\b/i,
      /\bapproach\b/i,
      /\bmethod\b/i,
      /\bsolv(e|ing)\b/i,
      /\bhow (would|do) you handle\b/i,
      /\bwhat'?s? your (approach|method|solution)\b/i,
    ],
  },
  {
    state: 'FEATURES',
    patterns: [
      /\bfeatures?\b/i,
      /\bcapabilit(y|ies)\b/i,
      /\bcan (it|you|this)\b/i,
      /\bdoes (it|this) (support|have|do)\b/i,
      /\bwhat can\b/i,
      /\bfunctionality\b/i,
      /\bwork with\b/i,
    ],
  },
  {
    state: 'PROBLEM',
    patterns: [
      /\bproblem\b/i,
      /\bissue\b/i,
      /\bstruggl(e|ing)\b/i,
      /\bpain\b/i,
      /\bbroken\b/i,
      /\bfail(ing|ed)?\b/i,
      /\bchallenge\b/i,
      /\bfrustrat(ed|ing)?\b/i,
      /\bcan'?t\b/i,
      /\bnot work(ing)?\b/i,
    ],
  },
  {
    state: 'INTRO',
    patterns: [
      /\bwhat is\b/i,
      /\bwho are\b/i,
      /\btell me about\b/i,
      /\bwhat are you\b/i,
      /\bintroduce\b/i,
      /\boverview\b/i,
      /\babout (you|this|your)\b/i,
    ],
  },
];

const DEPTH_MAP: Record<ConversationState, RetrievalDepth> = {
  INTRO: 'L1',
  GENERAL: 'L1',
  PROBLEM: 'L2',
  SOLUTION: 'L2',
  FEATURES: 'L2',
  DEEP_DIVE: 'L3',
  CTA: 'L1',
};

export class StateRouter {
  private _current: ConversationState = 'GENERAL';
  private _previous: ConversationState = 'GENERAL';

  get currentState(): ConversationState {
    return this._current;
  }

  get previousState(): ConversationState {
    return this._previous;
  }

  /** Detect state from message WITHOUT updating internal state */
  detectState(message: string): ConversationState {
    const lower = message.toLowerCase();
    for (const { state, patterns } of STATE_PATTERNS) {
      if (patterns.some((re) => re.test(lower))) {
        return state;
      }
    }
    return 'GENERAL';
  }

  /** Detect and COMMIT the state transition */
  transition(message: string): ConversationState {
    const next = this.detectState(message);
    this._previous = this._current;
    this._current = next;
    return next;
  }

  /** Map state → retrieval depth */
  getRetrievalDepth(state: ConversationState): RetrievalDepth {
    return DEPTH_MAP[state];
  }

  // ── Dual-process routing ──────────────────────────────────────────────────

  /**
   * Inspect the current {@link NeuralState} and decide which cognitive process
   * mode to use for this agent turn.
   *
   * - **System 1** (`astrocyteLevel < 0.6`): Low surprise / routine task.
   *   The agent proceeds directly to response generation without extra scaffolding.
   *
   * - **System 2** (`astrocyteLevel >= 0.6`): High surprise / complex task.
   *   Generation is intercepted. A structured step-by-step reasoning prompt is
   *   returned in `systemPromptInjection` for the caller to prepend to the LLM
   *   system prompt before submitting to the model.
   *
   * @param neuralState - The {@link NeuralState} produced by the current
   *                      retrieval cycle (from `HAMRetriever.retrieve()`).
   * @returns           A {@link DualProcessDecision} describing the routing choice.
   */
  routeByAstrocyte(neuralState: NeuralState): DualProcessDecision {
    const { astrocyteLevel } = neuralState;

    if (astrocyteLevel < ASTROCYTE_SYSTEM2_THRESHOLD) {
      // System 1 — fast path: routine task, respond immediately
      return {
        mode: 'SYSTEM_1',
        astrocyteLevel,
      };
    }

    // System 2 — slow path: high surprise, route to deep-thinking loop
    console.log(
      `[StateRouter] astrocyteLevel=${astrocyteLevel.toFixed(4)} >= ${ASTROCYTE_SYSTEM2_THRESHOLD} ` +
        '— escalating to System 2 (deep-thinking / research loop).',
    );

    return {
      mode: 'SYSTEM_2',
      systemPromptInjection: SYSTEM2_PROMPT,
      astrocyteLevel,
    };
  }
}
