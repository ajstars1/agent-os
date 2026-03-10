export type ConversationState = 'INTRO' | 'PROBLEM' | 'SOLUTION' | 'FEATURES' | 'DEEP_DIVE' | 'CTA' | 'GENERAL';
export type RetrievalDepth = 'L0' | 'L1' | 'L2' | 'L3';
export declare class StateRouter {
    private _current;
    private _previous;
    get currentState(): ConversationState;
    get previousState(): ConversationState;
    /** Detect state from message WITHOUT updating internal state */
    detectState(message: string): ConversationState;
    /** Detect and COMMIT the state transition */
    transition(message: string): ConversationState;
    /** Map state → retrieval depth */
    getRetrievalDepth(state: ConversationState): RetrievalDepth;
}
//# sourceMappingURL=state-router.d.ts.map