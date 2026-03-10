import type { Message as DiscordMessage } from 'discord.js';
/**
 * Split a long string into Discord-safe chunks, preferring \n boundaries.
 */
export declare function splitMessage(text: string, maxLen?: number): string[];
/**
 * Derive a stable conversation ID from a Discord message context.
 * Threads use their own ID; DMs use user ID; guild channels use channel ID.
 */
export declare function getConversationId(message: DiscordMessage): string;
//# sourceMappingURL=utils.d.ts.map