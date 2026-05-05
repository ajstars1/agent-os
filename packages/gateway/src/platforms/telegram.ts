/**
 * Telegram platform adapter — pure fetch, no extra npm package.
 *
 * Uses long-polling against the Telegram Bot API.
 * Set TELEGRAM_BOT_TOKEN in .env to enable.
 *
 * Optional env vars:
 *   TELEGRAM_ALLOWED_USERS  — comma-separated user IDs or usernames
 *   TELEGRAM_ALLOWED_CHATS  — comma-separated chat IDs
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  voice?: { file_id: string };
  document?: { file_id: string; file_name?: string };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

export class TelegramAdapter extends PlatformAdapter {
  readonly name = 'telegram';

  private token: string;
  private apiBase: string;
  private offset = 0;
  private running = false;
  private allowedUsers: Set<string>;
  private allowedChats: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.token = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.allowedUsers = new Set(
      (process.env['TELEGRAM_ALLOWED_USERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    this.allowedChats = new Set(
      (process.env['TELEGRAM_ALLOWED_CHATS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    if (!this.token) {
      this.logger.warn('[Telegram] TELEGRAM_BOT_TOKEN not set — skipping');
      return;
    }
    this.running = true;
    this.logger.info('[Telegram] Starting long-poll loop');
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.info('[Telegram] Stopped');
  }

  async send(chatId: string, text: string, _opts?: object): Promise<void> {
    const chunks = this.chunk(text, 4000);
    for (const chunk of chunks) {
      await this.tgFetch('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
    }
  }

  protected get maxMessageLength(): number { return 4000; }

  private async tgFetch(method: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json() as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.tgFetch('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'channel_post'],
        }) as TgUpdate[];

        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message ?? update.channel_post;
          if (msg) await this.handleMessage(msg).catch(() => {});
        }
      } catch (err) {
        if (this.running) {
          this.logger.warn({ err }, '[Telegram] Poll error — retrying in 5s');
          await sleep(5000);
        }
      }
    }
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    if (msg.from?.is_bot) return;
    if (!msg.text) return; // skip voice/docs for now

    const userId = String(msg.from?.id ?? '');
    const chatId = String(msg.chat.id);

    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId) && !this.allowedUsers.has(msg.from?.username ?? '')) return;
    if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) return;

    // Show "typing..."
    await this.tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    const conversationId = msg.chat.type === 'private'
      ? `telegram-dm-${userId}`
      : `telegram-chat-${chatId}`;

    await this.runAndDeliver(conversationId, chatId, msg.text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
