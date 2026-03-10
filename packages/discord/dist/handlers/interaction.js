import { handleAsk, handleClear, handleModel, } from '../commands/index.js';
export async function handleInteraction(interaction, engine, logger) {
    if (!interaction.isChatInputCommand())
        return;
    const cmd = interaction;
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
//# sourceMappingURL=interaction.js.map