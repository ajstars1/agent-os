import type { Message as DiscordMessage } from 'discord.js';

const DISCORD_MAX_LENGTH = 1990;

/**
 * Split a long string into Discord-safe chunks, preferring \n boundaries.
 */
export function splitMessage(text: string, maxLen = DISCORD_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Derive a stable conversation ID from a Discord message context.
 * Threads use their own ID; DMs use user ID; guild channels use channel ID.
 */
export function getConversationId(message: DiscordMessage): string {
  if (message.channel.isThread()) {
    return `discord-thread-${message.channel.id}`;
  }
  if (message.channel.isDMBased()) {
    return `discord-dm-${message.author.id}`;
  }
  return `discord-channel-${message.channel.id}`;
}
