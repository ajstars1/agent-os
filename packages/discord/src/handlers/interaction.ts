import { type Interaction, type ChatInputCommandInteraction } from 'discord.js';
import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import {
  handleAsk,
  handleClear,
  handleModel,
} from '../commands/index.js';
import { getConversationId } from '../utils.js';
import type { Message as DiscordMessage } from 'discord.js';

export async function handleInteraction(
  interaction: Interaction,
  engine: AgentEngine,
  logger: Logger,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction as ChatInputCommandInteraction;

  // Build a pseudo-message to derive conversation ID
  // For slash commands, use channel ID directly
  const channelId = interaction.channelId ?? 'global';
  const conversationId = `discord-channel-${channelId}`;

  switch (cmd.commandName) {
    case 'ask':
      await handleAsk(cmd, engine, conversationId, logger);
      break;
    case 'clear':
      await handleClear(cmd, engine, conversationId);
      break;
    case 'model':
      await handleModel(cmd);
      break;
    default:
      logger.warn({ command: cmd.commandName }, 'Unknown slash command');
  }
}
