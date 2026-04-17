# HAM — Hierarchical Adaptive Memory

> The memory system powering AgentOS. Reduces prompt token usage by ~82% while preserving contextual depth on demand.

---

## The Problem

Standard AI agents inject all knowledge into every prompt:

```
System prompt: [all skills] + [all context] + [all history]  → 2,000–8,000 tokens/turn
```

This is wasteful. A user asking "what is your pricing?" doesn't need a deep-dive into your technical architecture. And the cost compounds: every turn in every conversation pays the full context tax.

---

## The Solution: 4-Level Compression

Every piece of knowledge is stored at 4 compression levels:

```
L0  ─  5–10 tokens     "Flat $29/month subscription"
L1  ─  20–50 tokens    "AgentOS costs $29/month, unlimited messages, cancel anytime"
L2  ─  100–200 tokens  Full pricing breakdown with plan details, trial info, annual discount
L3  ─  500+ tokens     Complete pricing page, FAQ, edge cases, enterprise options
```

**L0 is always in context** (~8 tokens × N topics = tiny constant overhead).  
**L1–L3 are loaded on demand** from SQLite, only for the active topic.  
**L4 self-learning** — when no memory hit occurs, the LLM answers from its own knowledge and the response is automatically compressed and stored as a new L0–L3 chunk.

---

## Innovation 1: Conversation State Machine (Zero LLM Cost)

Instead of asking the LLM "what is the user asking about?", HAM classifies intent with zero-cost regex patterns:

```
"what is / who are"           → INTRO     → L1 depth
"problem / struggling / pain" → PROBLEM   → L2 depth
"how do you / approach"       → SOLUTION  → L2 depth
"features / can it"           → FEATURES  → L2 depth
"tell me more / explain"      → DEEP_DIVE → L3 depth
"price / cost / get started"  → CTA       → L1 depth
Default                       → GENERAL   → L1 depth
```

Classification: **0ms, 0 tokens, 0 API calls.**

The state machine is implemented in `packages/core/src/memory/state-router.ts`. States transition based on the incoming message; the active state determines how deep to expand the matched topic.

---

## Innovation 2: Active Topic Expansion

Only the active topic expands. All other topics stay at L0:

```
All messages           →  L0 index always loaded  (~80 tokens)
Topic "pricing" active →  pricing L2 also loaded  (+150 tokens)
Topic "memory" active  →  memory L3 also loaded   (+500 tokens)

Total active memory: 80–600 tokens vs 2,000–8,000 traditional
```

When the conversation moves to a new topic, the old topic collapses back to L0. The new topic expands to the depth dictated by the current conversation state.

---

## Innovation 3: Topic Detection Without Embeddings

No vector database, no embedding API calls, no semantic search.

```
User: "tell me about the HAM algorithm"
  → tokenize: ["tell", "about", "ham", "algorithm"]
  → match against chunk topics: "memory" topic has tag "ham" → match!
  → expand "memory" to current retrieval depth
```

Keyword + tag matching: **sub-millisecond, zero cost.** Each knowledge chunk stores a JSON array of tags alongside the topic name. Detection is a simple set intersection.

---

## Innovation 4: Compression Cache

L0/L1/L2 are generated once via Gemini Flash and cached in SQLite forever. Re-compressing the same skill file across sessions wastes API calls.

```
First load of a skill file:
  rawText → SHA-256 → cache miss
  rawText → Gemini Flash → {L0, L1, L2}
  {L0, L1, L2} → stored in compression_cache with SHA-256 key

Every subsequent load (same file, unchanged content):
  rawText → SHA-256 → cache hit → instant retrieval
```

If the file changes, the SHA-256 changes, the cache misses, and a fresh compression runs.

---

## Innovation 5: Access-Weighted Pruning

When the 400-token hard cap on active memory is exceeded, HAM prunes the least-accessed topics first:

```
knowledge_chunks sorted by access_count ASC
→ drop L0 entries from the bottom until under budget
→ high-value topics always stay in context
→ unused topics fade naturally
```

Access counts are updated in SQLite after every turn (`updateAccessStats`). Topics that are frequently useful rise to the top; stale knowledge compresses away without any manual curation.

---

## L4 Self-Learning

When no knowledge chunk matches the user's question:

```
1. No topic match → no L1–L3 expansion
2. LLM answers from its own training knowledge
3. Agent detects this was a new fact (no memory hit)
4. HAMCompressor calls Gemini Flash: compress this response into L0/L1/L2/L3
5. New chunk stored: topic = slug from response, tags = extracted keywords
6. CLI shows: ◆ learned "elon-musk" → saved to memory
7. Next time this topic comes up: matched, expanded, served from memory
```

The agent grows its knowledge base automatically. No manual curation required.

---

## Data Flow

```
User message
    │
    ▼
StateRouter.transition(msg) → ConversationState (INTRO/PROBLEM/SOLUTION/etc.)
    │
    ▼
HAMRetriever.detectTopic(msg) → matched topic name (or null)
    │
    ▼
getRetrievalDepth(state) → 'L1' | 'L2' | 'L3'
    │
    ▼
assembleMemory(topic, depth):
  ├── getAllL0()               → headlines index (always, ~80 tokens)
  └── getAtDepth(topic, depth) → expanded content (only if topic matched)
    │
    ▼
activeMemory string (≤ 400 tokens hard cap)
    │
    ▼
prepend to system prompt → LLM call
    │
    ▼
Unknown topic? → HAMCompressor.compressChunk(response) → store new chunk
    │
    ▼
updateAccessStats(usedChunkIds) → access_count++ in SQLite
```

---

## SQLite Schema

```sql
-- Primary knowledge store
CREATE TABLE knowledge_chunks (
  id            TEXT    PRIMARY KEY,
  topic         TEXT    NOT NULL UNIQUE,
  l0            TEXT    NOT NULL,   -- always in context (8 tokens)
  l1            TEXT    NOT NULL,   -- loaded at INTRO/CTA depth (35 tokens)
  l2            TEXT    NOT NULL,   -- loaded at PROBLEM/SOLUTION/FEATURES depth (150 tokens)
  l3            TEXT    NOT NULL,   -- loaded at DEEP_DIVE depth (500+ tokens)
  tags          TEXT    NOT NULL,   -- JSON array for topic detection
  last_accessed INTEGER NOT NULL,
  access_count  INTEGER NOT NULL
);

-- Compression cache — avoids re-compressing unchanged skills
CREATE TABLE compression_cache (
  content_hash TEXT PRIMARY KEY, -- SHA-256(rawText)[:16]
  l0           TEXT NOT NULL,
  l1           TEXT NOT NULL,
  l2           TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
```

---

## Token Budget Example

```
10 topics × 8 tokens (L0)  =   80 tokens  ← always loaded
1 active topic × L2        =  150 tokens  ← PROBLEM / SOLUTION / FEATURES state
──────────────────────────────────────────
Total active memory         =  230 tokens  (vs 4,000–8,000 traditional)

Savings: ~94% in this example
         ~82% in the benchmark (8-turn mixed conversation)
```

---

## Benchmark

```
                      Naive (full context)    AgentOS HAM
Tokens / conversation      ~6,825                ~1,205
Cost / 1,000 convs         $20.47                 $3.61
State detection latency    ~200ms                   0ms
Vector DB required         sometimes                 no
```

Run: `npm run benchmark`

---

## State Machine Transition Table

| State | Trigger keywords (regex) | Retrieved depth |
|---|---|---|
| `INTRO` | `what is`, `who are`, `tell me about`, `introduce` | L1 |
| `PROBLEM` | `problem`, `issue`, `struggling`, `pain`, `challenge` | L2 |
| `SOLUTION` | `how do you`, `how does`, `approach`, `solve` | L2 |
| `FEATURES` | `features`, `capabilities`, `can it`, `does it support` | L2 |
| `DEEP_DIVE` | `tell me more`, `explain`, `detail`, `deep dive`, `technical` | L3 |
| `CTA` | `price`, `cost`, `pricing`, `get started`, `sign up`, `buy` | L1 |
| `GENERAL` | _(default — no match)_ | L1 |

---

## Tuning Constants

| Constant | Default | Effect |
|---|---|---|
| `MAX_ACTIVE_MEMORY_TOKENS` | 400 | Hard cap on memory injected per turn. Exceeded → access-weighted pruning. |
| `L0_TOKENS` | 8 | Target token count for headline (L0) compression |
| `L1_TOKENS` | 35 | Target token count for summary (L1) compression |
| `L2_TOKENS` | 150 | Target token count for detail (L2) compression |
| `PASTE_TRUNCATION_THRESHOLD` | 10,000 chars | CLI paste truncation threshold |
| `PASTE_PREVIEW_LENGTH` | 500 chars | Characters shown from start/end of truncated paste |

These are defined in `packages/core/src/memory/constants.ts` and `packages/cli/src/ui/PromptInput.tsx`.
