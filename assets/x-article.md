# I built a memory system for AI agents. It reduced token costs by 82%.

Here's what I learned about how memory actually works — and why most AI agents are doing it wrong.

---

## The problem no one talks about

Every AI agent has a memory problem.

Not the kind where it forgets things. The kind where it remembers *everything*, all at once, on every message.

Full conversation history. Appended to every prompt. Every. Single. Turn.

It works — until it doesn't. The context window fills. Costs compound. You're paying to re-send the same conversation repeatedly, just to answer a simple follow-up question.

I built six AI projects last year. Every single one had this problem. I kept patching it. Adding truncation here, summarization there. Nothing felt right.

So I stopped patching and started thinking.

---

## The insight that changed everything

I asked myself: how do *people* actually remember things?

You don't replay your entire life to answer a question. You retrieve what's relevant. Usually just a few facts. Detail only surfaces when you actually need it.

Memory isn't a tape recorder. It's compression.

That realization became **HAM** — Hierarchical Adaptive Memory. The core idea: store memory in tiers, retrieve only the tier you need.

---

## How it works

Four compression tiers, each progressively more detailed:

| Tier | Size | What it stores |
|------|------|---------------|
| L0 | 8 tokens | Topic slug — always in context |
| L1 | 35 tokens | Key facts — retrieved on topic match |
| L2 | 150 tokens | Full summary — retrieved when relevant |
| L3 | 500+ tokens | Raw detail — only on deep queries |

When a message arrives, the retriever scores it against stored topics. It pulls only the tier it needs. Nothing more.

A follow-up question on something you discussed yesterday costs **35 tokens** of memory context. The naive approach costs 1,890.

---

## The numbers

I ran a benchmark across 5 topics, 8 questions each. Real retrieval. Real compression. Reproducible — anyone can run `npm run benchmark` and get the same output.

| Approach | Avg tokens | Cost per 1,000 convos |
|----------|-----------|----------------------|
| Naive replay | 6,825 | $20.47 |
| HAM | 1,205 | $3.61 |
| **Reduction** | **82.3%** | **82.4%** |

Same answers. A fraction of the cost.

---

## The part I didn't plan

Here's where it got interesting.

What happens when the agent gets a question it has *no memory for*?

It answers using the LLM. That's expected. But then I added a step: it asks itself — *is this response worth keeping?*

If the answer is longer than 180 characters and isn't conversational filler, it compresses the response into the tier structure and saves it.

The agent learns from what it didn't know.

Ask it something obscure today. It answers. It saves. Ask again tomorrow — it already knows. No manual seeding. No human curation. The gaps fill themselves.

I called this **L4**. It wasn't in the original design. It emerged from thinking about what should happen at the boundary of memory.

---

## What's still unsolved

Compression quality at L1 and L2 depends on the summarization model. Fast models like Gemini Flash work well for most content. But on highly technical topics, they sometimes drop edge-case detail in the summary.

You're trading token cost for precision. How much precision is acceptable? At what scale does that tradeoff break down?

I don't have a clean answer. This feels like an open problem in memory system design — and I'd be curious whether others have hit it.

---

## Try it yourself

AgentOS is fully open-source. MIT licensed. Runs local. No SaaS, no cloud lock-in beyond your API keys.

```bash
git clone https://github.com/ajstars1/agent-os
npm install && npm run build
npm run seed-memory
npm run cli
```

The full stack is in one repo: CLI, Discord bot, HTTP/SSE API, Next.js dashboard, MCP tool support.

If you build something with it — or find a better answer to the compression tradeoff — I'd genuinely like to know.

**GitHub:** https://github.com/ajstars1/agent-os
