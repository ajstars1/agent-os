import { Client, Events, GatewayIntentBits, Partials, } from 'discord.js';
import { handleMessage } from './handlers/message.js';
import { handleInteraction } from './handlers/interaction.js';
export function createBot(engine, config, logger) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message],
    });
    client.on(Events.ClientReady, (readyClient) => {
        logger.info({ tag: readyClient.user.tag }, 'Discord bot online');
    });
    client.on(Events.MessageCreate, (message) => {
        void handleMessage(message, engine, config, logger);
    });
    client.on(Events.InteractionCreate, (interaction) => {
        void handleInteraction(interaction, engine, logger);
    });
    client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
    });
    return client;
}
//# sourceMappingURL=bot.js.map