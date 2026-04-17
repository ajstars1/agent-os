import { describe, it, expect, beforeEach } from 'vitest';
import { TieredStore } from '../memory/tiered-store.js';
import { HAMRetriever } from '../memory/retriever.js';

function makeStore(): TieredStore {
  const store = new TieredStore(':memory:');
  store.addChunk({
    topic: 'pricing',
    L0: 'Flat $29/month subscription',
    L1: 'AgentOS costs $29/month flat rate. Unlimited messages. Cancel anytime.',
    L2: 'AgentOS is priced at $29/month with no per-token charges. Includes all channels (CLI, Discord, web), unlimited conversations, and priority support. Annual plan available at $290/year (2 months free). Free 14-day trial, no credit card required.',
    L3: 'Full pricing page content...',
    tags: ['price', 'cost', 'subscription', 'billing'],
    lastAccessed: 0,
    accessCount: 0,
  });
  store.addChunk({
    topic: 'memory',
    L0: 'HAM: token-efficient tiered memory',
    L1: 'HAM uses 4 compression levels (L0–L3). Only loads context depth needed per conversation state. Reduces prompt tokens by 80%.',
    L2: 'Hierarchical Adaptive Memory stores knowledge at 4 compression levels. L0 (8 tokens) is always in-context. L1–L3 loaded on demand based on conversation state. State machine classifies user intent without LLM calls. Token usage reduced from ~2000 to ~400 per turn.',
    L3: 'Full HAM algorithm description...',
    tags: ['memory', 'ham', 'retrieval', 'tokens', 'context'],
    lastAccessed: 0,
    accessCount: 0,
  });
  store.addChunk({
    topic: 'integrations',
    L0: 'Discord, web API, WhatsApp adapters',
    L1: 'AgentOS connects to Discord, provides a REST/SSE web API, and supports WhatsApp via adapter. All share the same conversation memory.',
    L2: 'Multi-channel support: Discord bot (slash commands, DMs, threads), Hono HTTP server (POST /chat/stream SSE, POST /chat, DELETE /conversations/:id), WhatsApp via Twilio. All channels share unified SQLite memory store.',
    L3: 'Full integrations documentation...',
    tags: ['discord', 'web', 'api', 'whatsapp', 'channel', 'integration'],
    lastAccessed: 0,
    accessCount: 0,
  });
  return store;
}

describe('HAMRetriever.retrieve', () => {
  let store: TieredStore;
  let retriever: HAMRetriever;

  beforeEach(() => {
    store = makeStore();
    retriever = new HAMRetriever(store);
  });

  it('always includes L0 headlines in activeMemory', async () => {
    const result = await retriever.retrieve('hello', [], 'conv-1');
    expect(result.activeMemory).toContain('Knowledge Index');
    expect(result.activeMemory).toContain('pricing');
    expect(result.activeMemory).toContain('memory');
    expect(result.activeMemory).toContain('integrations');
  });

  it('detects GENERAL state for vague message', async () => {
    const result = await retriever.retrieve('hello there', [], 'conv-2');
    expect(result.state).toBe('GENERAL');
  });

  it('detects CTA state and returns result', async () => {
    const result = await retriever.retrieve('what is the pricing?', [], 'conv-3');
    expect(result.state).toBe('CTA');
  });

  it('detects DEEP_DIVE state', async () => {
    const result = await retriever.retrieve('explain how the memory works in detail', [], 'conv-4');
    expect(result.state).toBe('DEEP_DIVE');
  });

  it('matches topic by keyword in message', async () => {
    const result = await retriever.retrieve('tell me about pricing', [], 'conv-5');
    expect(result.expandedTopics).toContain('pricing');
  });

  it('matches topic by tag in message', async () => {
    const result = await retriever.retrieve('how does the HAM algorithm work?', [], 'conv-6');
    expect(result.expandedTopics).toContain('memory');
  });

  it('includes active topic expansion at correct depth for PROBLEM', async () => {
    const result = await retriever.retrieve('I have a problem with memory usage', [], 'conv-7');
    // State → PROBLEM → L2 depth
    expect(result.state).toBe('PROBLEM');
    expect(result.activeMemory).toContain('Active Topic');
    expect(result.activeMemory).toContain('memory');
  });

  it('tokenCount is positive and within reasonable range', async () => {
    const result = await retriever.retrieve('tell me more about the discord integration', [], 'conv-8');
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(400);
  });

  it('state persists across calls for same conversationId', async () => {
    await retriever.retrieve('what is this?', [], 'conv-9');          // INTRO
    const r2 = await retriever.retrieve('tell me more', [], 'conv-9'); // DEEP_DIVE
    expect(r2.state).toBe('DEEP_DIVE');
  });

  it('different conversationIds have independent state', async () => {
    await retriever.retrieve('what is the price?', [], 'conv-A'); // CTA
    const r2 = await retriever.retrieve('hello', [], 'conv-B');   // GENERAL (fresh)
    expect(r2.state).toBe('GENERAL');
  });

  it('usedChunkIds populated when topic matched', async () => {
    const result = await retriever.retrieve('tell me about discord integrations', [], 'conv-10');
    expect(result.usedChunkIds.length).toBeGreaterThan(0);
  });

  it('usedChunkIds empty when no topic matched', async () => {
    const result = await retriever.retrieve('hello', [], 'conv-11');
    expect(result.usedChunkIds).toHaveLength(0);
  });
});
