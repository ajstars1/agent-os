/**
 * Discord platform adapter — migrated from packages/discord/.
 *
 * Required env:
 *   DISCORD_TOKEN
 *   DISCORD_CLIENT_ID
 * Optional:
 *   DISCORD_GUILD_ID           — restrict slash command registration to one guild
 *   DISCORD_ALLOWED_CHANNELS   — comma-separated channel IDs (empty = all)
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
} from 'discord.js';
import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

export class DiscordAdapter extends PlatformAdapter {
  readonly name = 'discord';
  private client: Client | null = null;
  private allowedChannels: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedChannels = new Set(
      (process.env['DISCORD_ALLOWED_CHANNELS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const token = process.env['DISCORD_TOKEN'];
    if (!token) {
      this.logger.warn('[Discord] DISCORD_TOKEN not set — skipping');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on(Events.ClientReady, (c) => {
      this.logger.info({ tag: c.user.tag }, '[Discord] Bot online');
    });

    this.client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg);
    });

    this.client.on(Events.Error, (err) => {
      this.logger.error({ err }, '[Discord] Client error');
    });

    await this.client.login(token);
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    this.logger.info('[Discord] Stopped');
  }

  async send(channelId: string, text: string): Promise<void> {
    const channel = await this.client?.channels.fetch(channelId).catch(() => null);
    if (!channel || !('send' in channel)) return;
    const chunks = this.chunk(text, 1990);
    for (const chunk of chunks) {
      await (channel as SendableChannel).send(chunk).catch(() => {});
    }
  }

  protected get maxMessageLength(): number { return 1990; }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return;
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(message.channel.id)) return;

    const channelId = message.channel.id;
    const conversationId = message.channel.isThread()
      ? `discord-thread-${channelId}`
      : message.channel.isDMBased()
        ? `discord-dm-${message.author.id}`
        : `discord-channel-${channelId}`;

    try {
      await (message.channel as SendableChannel).sendTyping();
    } catch { /* ignore */ }

    await this.runAndDeliver(conversationId, channelId, message.content);
  }
}
