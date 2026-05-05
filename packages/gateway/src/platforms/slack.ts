/**
 * Slack platform adapter — uses @slack/bolt.
 *
 * Required env:
 *   SLACK_BOT_TOKEN    — xoxb-... bot token
 *   SLACK_SIGNING_SECRET
 * Optional:
 *   SLACK_APP_TOKEN    — xapp-... for Socket Mode (no public URL needed)
 *   SLACK_PORT         — HTTP port for events (default 3001)
 *   SLACK_ALLOWED_CHANNELS — comma-separated channel IDs
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

export class SlackAdapter extends PlatformAdapter {
  readonly name = 'slack';
  private app: unknown = null;
  private allowedChannels: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedChannels = new Set(
      (process.env['SLACK_ALLOWED_CHANNELS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const token = process.env['SLACK_BOT_TOKEN'];
    const signingSecret = process.env['SLACK_SIGNING_SECRET'];

    if (!token || !signingSecret) {
      this.logger.warn('[Slack] SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET not set — skipping');
      return;
    }

    try {
      const { App } = await import('@slack/bolt');
      const appToken = process.env['SLACK_APP_TOKEN'];
      const port = parseInt(process.env['SLACK_PORT'] ?? '3001', 10);

      const app = new App({
        token,
        signingSecret,
        ...(appToken
          ? { socketMode: true, appToken }
          : { port }),
      });

      // Listen to messages (not from bots)
      app.message(async ({ message, say }) => {
        const msg = message as { text?: string; channel?: string; user?: string; bot_id?: string };
        if (msg.bot_id || !msg.text) return;

        const channelId = msg.channel ?? '';
        if (this.allowedChannels.size > 0 && !this.allowedChannels.has(channelId)) return;

        const userId = msg.user ?? 'unknown';
        const conversationId = `slack-channel-${channelId}-${userId}`;

        let response = '';
        for await (const chunk of this.engine.chat({ conversationId, message: msg.text })) {
          if (chunk.type === 'text' && chunk.content) response += chunk.content;
          if (chunk.type === 'done') break;
        }

        if (response.trim()) {
          const chunks = this.chunk(response, 3000);
          for (const chunk of chunks) {
            await say(chunk);
          }
        }
      });

      // Handle /ask slash command
      app.command('/ask', async ({ command, ack, respond }) => {
        await ack();
        const channelId = command.channel_id;
        const conversationId = `slack-channel-${channelId}-${command.user_id}`;

        let response = '';
        for await (const chunk of this.engine.chat({ conversationId, message: command.text })) {
          if (chunk.type === 'text' && chunk.content) response += chunk.content;
          if (chunk.type === 'done') break;
        }
        await respond(response || '(no response)');
      });

      this.app = app;
      if (appToken) {
        await app.start();
      } else {
        await app.start(port);
      }
      this.logger.info({ port: appToken ? 'socket' : port }, '[Slack] App started');
    } catch (err) {
      this.logger.error({ err }, '[Slack] Failed to start — is @slack/bolt installed?');
    }
  }

  async stop(): Promise<void> {
    try {
      const app = this.app as { stop?: () => Promise<void> } | null;
      await app?.stop?.();
    } catch { /* ignore */ }
    this.app = null;
    this.logger.info('[Slack] Stopped');
  }

  async send(channelId: string, text: string): Promise<void> {
    try {
      const app = this.app as { client?: { chat: { postMessage: (o: unknown) => Promise<unknown> } } } | null;
      if (!app?.client) return;
      const chunks = this.chunk(text, 3000);
      for (const chunk of chunks) {
        await app.client.chat.postMessage({ channel: channelId, text: chunk });
      }
    } catch (err) {
      this.logger.error({ err }, '[Slack] send failed');
    }
  }

  protected get maxMessageLength(): number { return 3000; }
}
