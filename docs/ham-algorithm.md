# HAM — Hierarchical Adaptive Memory

> The memory system powering AgentOS. Reduces prompt token usage by ~80% while preserving contextual depth.

---

## The Problem

Standard AI agents inject all knowledge into every prompt:

```
System prompt: [CLAUDE.md] + [all skills] + [all context]  → 2000–8000 tokens/turn
```

This is wasteful. A user asking "what is your pricing?" doesn't need a deep-dive into your technical architecture.

---

## The Solution: 4-Level Compression

Every piece of knowledge is stored at 4 compression levels:

```
L0  ─  5–10 tokens    "Flat $29/month subscription"
L1  ─  20–50 tokens   "AgentOS costs $29/month, unlimited messages, cancel anytime"
L2  ─  100–200 tokens  Full pricing breakdown with plan details, trial info, annual discount
L3  ─  500+ tokens    Complete pricing page, FAQ, edge cases, enterprise options
```

**L0 is always in memory** (~8 tokens × 10 topics = ~80 tokens total index).
**L1–L3 are loaded on demand** from SQLite, only for the active topic.

---

## Innovation 1: Conversation State Machine (No LLM Cost)

Instead of asking the LLM "what is the user asking about?", HAM classifies intent with zero-cost regex patterns:

```
"what is / who are"          → INTRO    → L1 depth
"problem / struggling / pain"→ PROBLEM  → L2 depth
"how do you / approach"      → SOLUTION → L2 depth
"features / can it"          → FEATURES → L2 depth
"tell me more / explain"     → DEEP_DIVE→ L3 depth
"price / cost / get started" → CTA      → L1 depth
Default                      → GENERAL  → L1 depth
```

Classification: **0ms, 0 tokens, 0 API calls.**

---

## Innovation 2: Active Topic Expansion

```
All messages           →  L0 index always loaded  (~80 tokens)
Topic "pricing" active →  pricing L2 also loaded  (+150 tokens)
Topic "memory" active  →  memory L3 also loaded   (+500 tokens)

Total active memory: 80–600 tokens vs 2000–8000 traditional
```

When the topic changes, the old topic collapses back to L0. The new topic expands.

---

## Innovation 3: Topic Detection Without Embeddings

No vector database, no semantic search, no embedding API calls.

```
User: "tell me about the HAM algorithm"
  → tokenize: ["tell", "about", "ham", "algorithm"]
  → match against chunk topics: "memory" topic has tag "ham" → match!
  → expand "memory" to current retrieval depth
```

Keyword + tag matching: **sub-millisecond, zero cost.**

---

## Innovation 4: Compression Cache

L0/L1/L2 are generated once via Gemini Flash and cached in SQLite forever.

```
First time a skill is loaded:
  rawText → Gemini Flash → {L0, L1, L2} → stored in compression_cache

Every subsequent load:
  SHA-256(rawText) → cache hit → instant retrieval
```

Skills are re-used across sessions without re-compressing.

---

## Innovation 5: Access-Weighted Pruning

When the 400-token hard cap is hit, HAM drops the least-accessed L0 entries:

```
knowledge_chunks sorted by access_count ASC
→ drop from bottom until under budget
→ high-value topics always stay in context
→ unused topics fade naturally
```

Self-organizing memory: frequently useful knowledge stays, stale knowledge compresses away.

---

## Data Flow

```
User message
    │
    ▼
StateRouter.transition(msg) → ConversationState (INTRO/PROBLEM/etc.)
    │
    ▼
HAMRetriever.detectTopic(msg) → matched topic name (or null)
    │
    ▼
getRetrievalDepth(state) → 'L0' | 'L1' | 'L2' | 'L3'
    │
    ▼
assembleMemory(topic, depth):
  ├── getAllL0() → headlines index (always)
  └── getAtDepth(topic, depth) → expanded content (if topic matched)
    │
    ▼
activeMemory string (≤400 tokens)
    │
    ▼
prepend to system prompt → LLM call
    │
    ▼
updateAccessStats(usedChunkIds) → access_count++ in SQLite
```

---

## SQLite Schema

```sql
CREATE TABLE knowledge_chunks (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL UNIQUE,
  l0            TEXT NOT NULL,   -- always in memory
  l1            TEXT NOT NULL,   -- loaded on demand
  l2            TEXT NOT NULL,   -- loaded on demand
  l3            TEXT NOT NULL,   -- loaded on demand
  tags          TEXT NOT NULL,   -- JSON array for topic detection
  last_accessed INTEGER NOT NULL,
  access_count  INTEGER NOT NULL
);

CREATE TABLE compression_cache (
  content_hash TEXT PRIMARY KEY, -- SHA-256(L3)[:16]
  l0           TEXT NOT NULL,
  l1           TEXT NOT NULL,
  l2           TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
```

---

## Token Budget Example

```
10 topics × 8 tokens (L0) =  80 tokens  ← always loaded
1 active topic × L2       = 150 tokens  ← PROBLEM/SOLUTION/FEATURES state
─────────────────────────────────────────
Total active memory        = 230 tokens  (vs 4000+ traditional)

Savings: ~94%
```

---

## Tuning

| Constant | Default | Effect |
|---|---|---|
| `MAX_ACTIVE_MEMORY_TOKENS` | 400 | Hard cap on activeMemory injected per turn |
| `L0_TOKENS` | 8 | Target tokens for headline compression |
| `L1_TOKENS` | 35 | Target tokens for summary compression |
| `L2_TOKENS` | 150 | Target tokens for detail compression |
