import type { Message } from '@agent-os/shared';
import { type ConversationState } from './state-router.js';
import type { TieredStore } from './tiered-store.js';
export interface RetrievalResult {
    activeMemory: string;
    tokenCount: number;
    state: ConversationState;
    expandedTopics: string[];
    usedChunkIds: string[];
}
export declare class HAMRetriever {
    private readonly store;
    private readonly routers;
    constructor(store: TieredStore);
    retrieve(userMessage: string, _history: Message[], conversationId: string): RetrievalResult;
    private getRouter;
    /**
     * Keyword-match user message against chunk topics + tags.
     * Returns the first matching topic name, or null.
     */
    private detectTopic;
    /**
     * Build the activeMemory string:
     * 1. All L0 headlines (always included)
     * 2. Active topic expanded to requested depth
     * 3. Hard cap at MAX_ACTIVE_MEMORY_TOKENS — drop lowest-access L0s if needed
     */
    private assembleMemory;
    /**
     * Drop lowest-access L0 entries until under the token cap.
     * Always keeps the active topic section.
     */
    private trimToTokenBudget;
}
//# sourceMappingURL=retriever.d.ts.map