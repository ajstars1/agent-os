/**
 * ProfileExtractor — silently learns from every exchange.
 *
 * After each user message + assistant response pair, this runs a lightweight
 * Gemini flash-lite pass to extract:
 *   1. Profile updates (name, role, stack, projects, style)
 *   2. Whether this exchange is a significant episode worth storing
 *
 * It is fully async and never blocks the chat response. If it fails,
 * the conversation continues normally — this is best-effort enrichment.
 */

import { GoogleGenAI } from '@google/genai';
import type { UserProfileStore, PartialUserProfile, UserProject } from './user-profile-store.js';
import type { EpisodicStore } from './episodic-store.js';
import type { EpisodeTone } from './episodic-store.js';

const EXTRACT_MODEL = 'gemini-3.1-flash-lite-preview';

interface ExtractedData {
  profile: PartialUserProfile;
  episode: {
    worthy: boolean;
    summary: string;
    topics: string[];
    importance: number;
    tone: EpisodeTone;
  } | null;
}

const EXTRACT_PROMPT = `You are a silent memory assistant. Analyze this conversation exchange and extract structured data.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "profile": {
    "name": string | null,
    "role": string | null,
    "location": string | null,
    "primaryStack": string[],
    "codingPreferences": string[],
    "communicationStyle": "concise" | "detailed" | "technical" | "casual" | null,
    "facts": Record<string, string>,
    "currentProjects": Array<{
      "name": string,
      "description": string,
      "stack": string[],
      "status": "active" | "paused" | "shipped" | "ideating"
    }>
  },
  "episode": {
    "worthy": boolean,
    "summary": string,
    "topics": string[],
    "importance": number,
    "tone": "positive" | "negative" | "neutral" | "frustrated" | "excited"
  } | null
}

Rules:
- "worthy" = true only if something significant happened (shipped something, hit a blocker, made a key decision, learned something major). Routine Q&A = false.
- "importance" ranges 0.0–1.0. Shipping/breakthroughs = 0.8–1.0. Debugging sessions = 0.4–0.6. Quick questions = 0.1–0.3.
- Only include fields you actually observed. Never invent. Use null/[] for unknowns.
- "summary" must be past-tense, 1-2 sentences, written from an observer's perspective.
- Extract stack items only if explicitly mentioned (e.g. "Next.js", "Supabase", "TypeScript").`;

export class ProfileExtractor {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly profileStore: UserProfileStore,
    private readonly episodicStore: EpisodicStore,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Fire-and-forget extraction after each exchange.
   * Call this; don't await it in the hot path.
   */
  extractAsync(
    userMessage: string,
    assistantResponse: string,
    conversationId: string,
    userId = 'default',
  ): void {
    this.extract(userMessage, assistantResponse, conversationId, userId).catch(() => {
      // Silent — extraction is best-effort
    });
  }

  private async extract(
    userMessage: string,
    assistantResponse: string,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const exchangeText =
      `User: ${userMessage.slice(0, 800)}\n\nAssistant: ${assistantResponse.slice(0, 800)}`;

    const response = await this.ai.models.generateContent({
      model: EXTRACT_MODEL,
      contents: `${EXTRACT_PROMPT}\n\n---\n\nExchange:\n${exchangeText}`,
    });

    const raw = (response.text ?? '').trim();
    // Strip markdown fences if model wraps in ```json
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    let data: ExtractedData;
    try {
      data = JSON.parse(jsonStr) as ExtractedData;
    } catch {
      return; // Malformed — skip silently
    }

    // ── Profile update ────────────────────────────────────────────────────────
    const profileUpdate = this.sanitizeProfileUpdate(data.profile);
    if (Object.keys(profileUpdate).length > 0) {
      this.profileStore.merge(profileUpdate, userId);
    }

    // ── Episode ───────────────────────────────────────────────────────────────
    if (data.episode?.worthy && data.episode.summary) {
      this.episodicStore.add({
        summary: data.episode.summary,
        topics: data.episode.topics ?? [],
        importance: Math.min(1, Math.max(0, data.episode.importance ?? 0.5)),
        tone: data.episode.tone ?? 'neutral',
        occurredAt: Date.now(),
        conversationId,
      });
    }
  }

  private sanitizeProfileUpdate(raw: ExtractedData['profile']): PartialUserProfile {
    if (!raw || typeof raw !== 'object') return {};

    const update: PartialUserProfile = {};

    if (typeof raw.name === 'string' && raw.name) update.name = raw.name;
    if (typeof raw.role === 'string' && raw.role) update.role = raw.role;
    if (typeof raw.location === 'string' && raw.location) update.location = raw.location;
    if (raw.communicationStyle) update.communicationStyle = raw.communicationStyle;

    if (Array.isArray(raw.primaryStack) && raw.primaryStack.length > 0) {
      update.primaryStack = raw.primaryStack.filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(raw.codingPreferences) && raw.codingPreferences.length > 0) {
      update.codingPreferences = raw.codingPreferences.filter((s): s is string => typeof s === 'string');
    }

    if (raw.facts && typeof raw.facts === 'object') {
      const facts: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.facts)) {
        if (typeof v === 'string') facts[k] = v;
      }
      if (Object.keys(facts).length > 0) update.facts = facts;
    }

    if (Array.isArray(raw.currentProjects) && raw.currentProjects.length > 0) {
      const now = Date.now();
      const projects: UserProject[] = raw.currentProjects
        .filter((p) => p && typeof p.name === 'string' && p.name)
        .map((p) => ({
          name: p.name,
          description: typeof p.description === 'string' ? p.description : '',
          stack: Array.isArray(p.stack) ? p.stack.filter((s): s is string => typeof s === 'string') : [],
          status: (['active', 'paused', 'shipped', 'ideating'] as const).includes(p.status)
            ? p.status
            : 'active',
          lastMentioned: now,
        }));
      if (projects.length > 0) update.currentProjects = projects;
    }

    return update;
  }
}
