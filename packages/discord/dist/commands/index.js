import { REST, Routes, SlashCommandBuilder, } from 'discord.js';
export const commandDefinitions = [
    new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the agent a question')
        .addStringOption((option) => option
        .setName('prompt')
        .setDescription('Your question or request')
        .setRequired(true)),
    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear conversation history for this channel'),
    new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch the LLM model for this channel')
        .addStringOption((option) => option
        .setName('model')
        .setDescription('Model to use')
        .setRequired(true)
        .addChoices({ name: 'Claude (complex tasks)', value: 'claude' }, { name: 'Gemini (fast responses)', value: 'gemini' }, { name: 'Auto (smart routing)', value: 'auto' })),
].map((cmd) => cmd.toJSON());
export async function registerCommands(token, clientId, guildId, logger) {
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
                body: commandDefinitions,
            });
            logger?.info({ guildId }, 'Guild slash commands registered');
        }
        else {
            await rest.put(Routes.applicationCommands(clientId), {
                body: commandDefinitions,
            });
            logger?.info('Global slash commands registered');
        }
    }
    catch (err) {
        logger?.error({ err }, 'Failed to register slash commands');
        throw err;
    }
}
export async function handleAsk(interaction, engine, conversationId, logger) {
    await interaction.deferReply();
    const prompt = interaction.options.getString('prompt', true);
    try {
        let fullResponse = '';
        for await (const chunk of engine.chat({
            conversationId,
            message: prompt,
        })) {
            if (chunk.type === 'text' && chunk.content) {
                fullResponse += chunk.content;
            }
            else if (chunk.type === 'done') {
                break;
            }
        }
        const reply = fullResponse.trim() || 'No response generated.';
        // Discord edit reply max is 2000 chars
        await interaction.editReply(reply.slice(0, 2000));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, conversationId }, 'Error in /ask handler');
        await interaction.editReply(`Error: ${message}`);
    }
}
export async function handleClear(interaction, engine, conversationId) {
    engine.clearConversation(conversationId);
    await interaction.reply({ content: 'Context cleared for this channel.', ephemeral: true });
}
export async function handleModel(interaction) {
    const model = interaction.options.getString('model', true);
    await interaction.reply({
        content: `Model preference set to **${model}**. Use \`cc:\` prefix to force Claude or \`g:\` prefix to force Gemini in messages.`,
        ephemeral: true,
    });
}
//# sourceMappingURL=index.js.map