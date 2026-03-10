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
}
