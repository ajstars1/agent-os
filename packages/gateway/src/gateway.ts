/**
 * GatewayDaemon — starts all enabled platform adapters and shares one AgentEngine.
 *
 * Platform enablement is determined by the presence of required env vars.
 * No platform is forced on or off — if the token exists, it starts.
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import type { PlatformAdapter } from './base.js';
import { TelegramAdapter } from './platforms/telegram.js';
import { DiscordAdapter } from './platforms/discord.js';
import { SlackAdapter } from './platforms/slack.js';
import { WhatsAppAdapter } from './platforms/whatsapp.js';
import { SignalAdapter } from './platforms/signal.js';
import { MatrixAdapter } from './platforms/matrix.js';
import { EmailAdapter } from './platforms/email.js';

export type PlatformName = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal' | 'matrix' | 'email';

export class GatewayDaemon {
  private readonly adapters: PlatformAdapter[] = [];

  constructor(
    private readonly engine: AgentEngine,
    private readonly logger: Logger,
    /** Optionally restrict which platforms to start (empty = all with valid env). */
    only?: PlatformName[],
  ) {
    const all: [PlatformName, () => PlatformAdapter][] = [
      ['telegram', () => new TelegramAdapter(engine, logger)],
      ['discord', () => new DiscordAdapter(engine, logger)],
      ['slack', () => new SlackAdapter(engine, logger)],
      ['whatsapp', () => new WhatsAppAdapter(engine, logger)],
      ['signal', () => new SignalAdapter(engine, logger)],
      ['matrix', () => new MatrixAdapter(engine, logger)],
      ['email', () => new EmailAdapter(engine, logger)],
    ];

    for (const [name, factory] of all) {
      if (only && only.length > 0 && !only.includes(name)) continue;
      this.adapters.push(factory());
    }
  }

  /** Start all adapters concurrently. Each adapter skips itself if its env vars are missing. */
  async start(): Promise<void> {
    const results = await Promise.allSettled(this.adapters.map((a) => a.start()));
    let started = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const name = this.adapters[i]!.name;
      if (r.status === 'rejected') {
        this.logger.error({ err: r.reason, platform: name }, '[Gateway] Failed to start platform');
      } else {
        started++;
      }
    }
    this.logger.info({ started, total: this.adapters.length }, '[Gateway] Started');
  }

  /** Stop all adapters gracefully. */
  async stop(): Promise<void> {
    await Promise.allSettled(this.adapters.map((a) => a.stop()));
    this.logger.info('[Gateway] All platforms stopped');
  }

  /** Names of all registered adapters. */
  get platformNames(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
