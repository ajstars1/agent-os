import type { Message } from '@agent-os/shared';
import { StateRouter, type ConversationState, type RetrievalDepth } from './state-router.js';
import type { TieredStore, L0Entry } from './tiered-store.js';

const MAX_ACTIVE_MEMORY_TOKENS = 400;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface RetrievalResult {
  activeMemory: string;
  tokenCount: number;
  state: ConversationState;
  expandedTopics: string[];
  usedChunkIds: string[];
}

export class HAMRetriever {
  private readonly routers = new Map<string, StateRouter>();

  constructor(private readonly store: TieredStore) {}

  retrieve(
    userMessage: string,
    _history: Message[],
    conversationId: string,
  ): RetrievalResult {
    const router = this.getRouter(conversationId);
    const state = router.transition(userMessage);
    const depth = router.getRetrievalDepth(state);

    const activeTopic = this.detectTopic(userMessage);
    const { text, ids } = this.assembleMemory(activeTopic, depth);

    return {
      activeMemory: text,
      tokenCount: estimateTokens(text),
      state,
      expandedTopics: activeTopic ? [activeTopic] : [],
      usedChunkIds: ids,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private getRouter(conversationId: string): StateRouter {
    let router = this.routers.get(conversationId);
    if (!router) {
      router = new StateRouter();
      this.routers.set(conversationId, router);
    }
    return router;
  }

  /**
   * Keyword-match user message against chunk topics + tags.
   * Returns the first matching topic name, or null.
   */
  private detectTopic(userMessage: string): string | null {
    const lower = userMessage.toLowerCase();
    const entries = this.store.getAllL0();

    // Score each entry: topic name match scores 2, tag match scores 1
    let bestTopic: string | null = null;
    let bestScore = 0;

    for (const entry of entries) {
      let score = 0;
      const topicWords = entry.topic.toLowerCase().split(/[\s-_]+/);
      if (topicWords.some((w) => w.length > 2 && lower.includes(w))) {
        score += 2;
      }
      for (const tag of entry.tags) {
        if (tag.length > 2 && lower.includes(tag.toLowerCase())) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestTopic = entry.topic;
      }
    }

    return bestTopic;
  }

  /**
   * Build the activeMemory string:
   * 1. All L0 headlines (always included)
   * 2. Active topic expanded to requested depth
   * 3. Hard cap at MAX_ACTIVE_MEMORY_TOKENS — drop lowest-access L0s if needed
   */
  private assembleMemory(
    activeTopic: string | null,
    depth: RetrievalDepth,
  ): { text: string; ids: string[] } {
    const usedIds: string[] = [];
    const parts: string[] = [];

    // 1. All L0 headlines
    const all: L0Entry[] = this.store.getAllL0();
    if (all.length > 0) {
      const headlines = all.map((e) => `• ${e.topic}: ${e.l0}`).join('\n');
      parts.push(`### Knowledge Index\n${headlines}`);
    }

    // 2. Expand active topic at requested depth
    if (activeTopic) {
      const expanded = this.store.getAtDepth(activeTopic, depth);
      if (expanded) {
        parts.push(`### Active Topic: ${activeTopic} (${depth})\n${expanded}`);
        const entry = this.store.getAllL0().find((e) => e.topic === activeTopic);
        if (entry) usedIds.push(entry.id);
      }
    }

    let text = parts.join('\n\n');

    // 3. Enforce hard token cap — trim L0 headlines if needed
    if (estimateTokens(text) > MAX_ACTIVE_MEMORY_TOKENS) {
      text = this.trimToTokenBudget(text, activeTopic);
    }

    return { text, ids: usedIds };
  }

  /**
   * Drop lowest-access L0 entries until under the token cap.
   * Always keeps the active topic section.
   */
  private trimToTokenBudget(fullText: string, activeTopic: string | null): string {
    // Split into active-topic section and headlines section
    const sections = fullText.split('\n\n');
    const activeSection = sections.find((s) => s.startsWith('### Active Topic'));
    const activeTokens = activeSection ? estimateTokens(activeSection) : 0;
    const budget = MAX_ACTIVE_MEMORY_TOKENS - activeTokens;

    // Sort entries by accessCount ascending (drop least-accessed first)
    const entries = this.store.getAllL0();
    const sorted = [...entries].sort((a, b) => {
      const chunkA = this.store.getByTopic(a.topic);
      const chunkB = this.store.getByTopic(b.topic);
      return (chunkA?.accessCount ?? 0) - (chunkB?.accessCount ?? 0);
    });

    const kept: string[] = [];
    let tokensUsed = 0;
    for (const entry of sorted.reverse()) {
      if (entry.topic === activeTopic) continue; // already in active section
      const line = `• ${entry.topic}: ${entry.l0}`;
      const lineTokens = estimateTokens(line);
      if (tokensUsed + lineTokens > budget) break;
      kept.push(line);
      tokensUsed += lineTokens;
    }

    const parts: string[] = [];
    if (kept.length > 0) {
      parts.push(`### Knowledge Index\n${kept.join('\n')}`);
    }
    if (activeSection) parts.push(activeSection);

    return parts.join('\n\n');
  }
}
