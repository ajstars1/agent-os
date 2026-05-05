export { GatewayDaemon } from './gateway.js';
export type { PlatformName } from './gateway.js';
export { PlatformAdapter } from './base.js';
export type { SendOptions, PlatformConfig } from './base.js';

// Platform adapters (for custom use)
export { TelegramAdapter } from './platforms/telegram.js';
export { DiscordAdapter } from './platforms/discord.js';
export { SlackAdapter } from './platforms/slack.js';
export { WhatsAppAdapter } from './platforms/whatsapp.js';
export { SignalAdapter } from './platforms/signal.js';
export { MatrixAdapter } from './platforms/matrix.js';
export { EmailAdapter } from './platforms/email.js';
