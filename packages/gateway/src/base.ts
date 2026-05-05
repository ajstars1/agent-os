/**
 * PlatformAdapter — base class for all gateway platform integrations.
 *
 * Each platform (Telegram, Discord, Slack, etc.) implements this interface
 * and is managed by GatewayDaemon.
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';

export interface SendOptions {
  /** Reply to a specific message (platform-specific ID). */
  replyToId?: string;
  /** Markdown formatting (if platform supports it). */
  markdown?: boolean;
}

export abstract class PlatformAdapter {
  abstract readonly name: string;

  constructor(
    protected readonly engine: AgentEngine,
    protected readonly logger: Logger,
  ) {}

  /** Start listening on this platform. */
  abstract start(): Promise<void>;

  /** Stop gracefully. */
  abstract stop(): Promise<void>;

  /** Send a message to a given channel/chat on this platform. */
  abstract send(channelId: string, text: string, opts?: SendOptions): Promise<void>;

  // ─── Shared helpers ───────────────────────────────────────────────────────

  /** Split long text into platform-safe chunks at newline boundaries. */
  protected chunk(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let cut = remaining.lastIndexOf('\n', maxLen);
      if (cut <= 0) cut = maxLen;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  /** Run the agent for an incoming message, stream output, then deliver via `send`. */
  protected async runAndDeliver(
    conversationId: string,
    channelId: string,
    userMessage: string,
    opts?: SendOptions,
  ): Promise<void> {
    let fullResponse = '';
    try {
      for await (const chunk of this.engine.chat({ conversationId, message: userMessage })) {
        if (chunk.type === 'text' && chunk.content) fullResponse += chunk.content;
        if (chunk.type === 'done') break;
      }
    } catch (err) {
      this.logger.error({ err, conversationId, platform: this.name }, 'Engine error');
      await this.send(channelId, `Error: ${err instanceof Error ? err.message : String(err)}`, opts).catch(() => {});
      return;
    }

    if (!fullResponse.trim()) return;

    // Deliver in chunks respecting platform message limits
    const parts = this.chunk(fullResponse, this.maxMessageLength);
    for (const part of parts) {
      await this.send(channelId, part, opts).catch((err) => {
        this.logger.error({ err, platform: this.name }, 'Failed to send chunk');
      });
    }
  }

  /** Override in subclasses to set platform-specific message length limits. */
  protected get maxMessageLength(): number {
    return 4000;
  }
}

/** Config shape for each platform entry in settings.json → gateway.platforms */
export interface PlatformConfig {
  enabled?: boolean;
  /** User/channel allowlist (empty = allow all). */
  allowedUsers?: string[];
  allowedChannels?: string[];
}
