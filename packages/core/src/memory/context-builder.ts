/**
 * ContextBuilder — assembles the companion memory block for each LLM call.
 *
 * Hard budget: TOTAL_TOKEN_BUDGET tokens. Priority order:
 *   1. User profile      (~350 tokens, always included)
 *   2. Recent episodes   (~600 tokens, last 14 days)
 *   3. Semantic (HAM)    (~800 tokens, existing retriever result)
 *   4. Older episodes    (~250 tokens, remainder if budget allows)
 *
 * Output is a structured string prepended to the system prompt.
 * Jarvis-style: grounded, personal, not encyclopedic.
 */

import type { UserProfile, UserProject } from './user-profile-store.js';
import type { Episode } from './episodic-store.js';

const TOTAL_TOKEN_BUDGET = 2_000;
const PROFILE_BUDGET     =   350;
const RECENT_EP_BUDGET   =   600;
const SEMANTIC_BUDGET    =   800;
const OLD_EP_BUDGET      =   250;

const CHARS_PER_TOKEN = 4;
const RECENT_CUTOFF_DAYS = 14;
const MS_PER_DAY = 86_400_000;

function tokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncate(text: string, budget: number): string {
  const maxChars = budget * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

function relativeTime(ms: number): string {
  const days = Math.floor((Date.now() - ms) / MS_PER_DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildProfileSection(profile: UserProfile, budget: number): string {
  const lines: string[] = ['## About You'];

  // Identity
  const identity = [profile.name, profile.role].filter(Boolean).join(', ');
  if (identity) lines.push(identity);
  if (profile.location) lines.push(`Location: ${profile.location}`);

  // Stack
  if (profile.primaryStack.length > 0) {
    lines.push(`Stack: ${profile.primaryStack.slice(0, 8).join(', ')}`);
  }

  // Active projects (top 3 by lastMentioned)
  const activeProjects = profile.currentProjects
    .filter((p): p is UserProject => p.status === 'active' || p.status === 'ideating')
    .slice(0, 3);

  if (activeProjects.length > 0) {
    lines.push('Current projects:');
    for (const p of activeProjects) {
      const stackNote = p.stack.length > 0 ? ` (${p.stack.slice(0, 4).join(', ')})` : '';
      lines.push(`  • ${p.name}${stackNote} — ${p.description.slice(0, 80)}`);
    }
  }

  // Style preference
  if (profile.communicationStyle && profile.communicationStyle !== 'unknown') {
    lines.push(`Communication style: ${profile.communicationStyle}`);
  }

  // Key facts (top 5)
  const factEntries = Object.entries(profile.facts).slice(0, 5);
  if (factEntries.length > 0) {
    for (const [k, v] of factEntries) {
      lines.push(`${k}: ${v}`);
    }
  }

  // Sessions
  if (profile.sessionCount > 1) {
    lines.push(`Sessions together: ${profile.sessionCount}`);
  }

  return truncate(lines.join('\n'), budget);
}

function buildEpisodesSection(episodes: Episode[], label: string, budget: number): string {
  if (episodes.length === 0) return '';

  const lines = [`## ${label}`];
  let used = tokens(lines[0]!);

  for (const ep of episodes) {
    const tone = ep.tone !== 'neutral' ? ` [${ep.tone}]` : '';
    const line = `• ${relativeTime(ep.occurredAt)}${tone}: ${ep.summary}`;
    const lineTokens = tokens(line);
    if (used + lineTokens > budget) break;
    lines.push(line);
    used += lineTokens;
  }

  return lines.join('\n');
}

// ── Main assembler ────────────────────────────────────────────────────────────

export interface ContextInput {
  profile: UserProfile;
  /** All episodes, sorted by decayScore descending. */
  episodes: Episode[];
  /** Already-retrieved HAM semantic memory string (from HAMRetriever). */
  semanticMemory: string;
  /** Topics extracted from the current user message (for episode boosting). */
  currentTopics?: string[];
}

export interface BuiltContext {
  /** The full companion context block to prepend to the system prompt. */
  contextBlock: string;
  /** Token count of the assembled block. */
  tokenCount: number;
  /** Whether we had meaningful personal memory to inject. */
  hasPersonalMemory: boolean;
}

export function buildContext(input: ContextInput): BuiltContext {
  const { profile, episodes, semanticMemory, currentTopics } = input;

  const now = Date.now();
  const recentCutoff = now - RECENT_CUTOFF_DAYS * MS_PER_DAY;

  const recentEpisodes = episodes.filter((ep) => ep.occurredAt >= recentCutoff);
  const olderEpisodes  = episodes.filter((ep) => ep.occurredAt < recentCutoff);

  const parts: string[] = [];
  let usedTokens = 0;

  // 1. Profile (always)
  const hasProfile = profile.primaryStack.length > 0
    || (profile.currentProjects.length > 0)
    || !!profile.name
    || !!profile.role;

  if (hasProfile) {
    const profileSection = buildProfileSection(profile, PROFILE_BUDGET);
    parts.push(profileSection);
    usedTokens += tokens(profileSection);
  }

  // 2. Recent episodes
  if (recentEpisodes.length > 0) {
    const recentSection = buildEpisodesSection(recentEpisodes, 'Recent Memory', RECENT_EP_BUDGET);
    if (recentSection) {
      parts.push(recentSection);
      usedTokens += tokens(recentSection);
    }
  }

  // 3. Semantic HAM memory
  const semanticBudget = Math.min(SEMANTIC_BUDGET, TOTAL_TOKEN_BUDGET - usedTokens - OLD_EP_BUDGET);
  if (semanticMemory && semanticBudget > 50) {
    const truncatedSemantic = truncate(semanticMemory, semanticBudget);
    parts.push(truncatedSemantic);
    usedTokens += tokens(truncatedSemantic);
  }

  // 4. Older episodes (remaining budget)
  const oldBudget = Math.min(OLD_EP_BUDGET, TOTAL_TOKEN_BUDGET - usedTokens);
  if (olderEpisodes.length > 0 && oldBudget > 50) {
    // Boost relevance if topics match current message
    const boosted = olderEpisodes
      .map((ep) => {
        const boost = currentTopics?.some((t) => ep.topics.includes(t)) ? 2 : 1;
        return { ep, score: ep.decayScore * boost };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.ep);

    const oldSection = buildEpisodesSection(boosted, 'Older Memory', oldBudget);
    if (oldSection) {
      parts.push(oldSection);
      usedTokens += tokens(oldSection);
    }
  }

  if (parts.length === 0) {
    return { contextBlock: '', tokenCount: 0, hasPersonalMemory: false };
  }

  const contextBlock = [
    '<!-- COMPANION MEMORY — treat as verified personal context -->',
    parts.join('\n\n'),
    '<!-- END COMPANION MEMORY -->',
  ].join('\n');

  return {
    contextBlock,
    tokenCount: tokens(contextBlock),
    hasPersonalMemory: hasProfile || recentEpisodes.length > 0,
  };
}
