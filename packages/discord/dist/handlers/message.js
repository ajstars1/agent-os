import { splitMessage, getConversationId } from '../utils.js';
export async function handleMessage(message, engine, config, logger) {
    // Ignore bots
    if (message.author.bot)
        return;
    // Check allowed channels (empty = all channels allowed)
    const allowedChannels = config.DISCORD_ALLOWED_CHANNELS
        ? config.DISCORD_ALLOWED_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
    if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel.id)) {
        return;
    }
    const conversationId = getConversationId(message);
    const channel = message.channel;
    // Show typing indicator
    try {
        await channel.sendTyping();
    }
    catch {
        // Ignore typing indicator failures
    }
    let fullResponse = '';
    try {
        for await (const chunk of engine.chat({
            conversationId,
            message: message.content,
        })) {
            if (chunk.type === 'text' && chunk.content) {
                fullResponse += chunk.content;
            }
            else if (chunk.type === 'done') {
                break;
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, conversationId }, 'Error processing message');
        try {
            await channel.send(`Error: ${msg}`);
        }
        catch {
            // Ignore send failures
        }
        return;
    }
    if (!fullResponse.trim())
        return;
    // Split and send sequentially (respect rate limits)
    const parts = splitMessage(fullResponse);
    for (const part of parts) {
        try {
            await channel.send(part);
        }
        catch (err) {
            logger.error({ err }, 'Failed to send message part');
            break;
        }
    }
}
//# sourceMappingURL=message.js.map