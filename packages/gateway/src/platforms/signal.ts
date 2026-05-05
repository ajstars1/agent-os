/**
 * Signal platform adapter — bridges to signal-cli REST API.
 *
 * Requires signal-cli running with REST API mode:
 *   https://github.com/bbernhard/signal-cli-rest-api
 *
 * Required env:
 *   SIGNAL_CLI_URL      — e.g. http://localhost:8080
 *   SIGNAL_NUMBER       — your registered Signal number, e.g. +15551234567
 * Optional:
 *   SIGNAL_ALLOWED_NUMBERS — comma-separated phone numbers
 *   SIGNAL_POLL_INTERVAL_MS — polling interval (default 5000)
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber?: string;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId: string };
    };
  };
}

export class SignalAdapter extends PlatformAdapter {
  readonly name = 'signal';
  private running = false;
  private allowedNumbers: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedNumbers = new Set(
      (process.env['SIGNAL_ALLOWED_NUMBERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const url = process.env['SIGNAL_CLI_URL'];
    const number = process.env['SIGNAL_NUMBER'];

    if (!url || !number) {
      this.logger.warn('[Signal] SIGNAL_CLI_URL or SIGNAL_NUMBER not set — skipping');
      return;
    }

    this.running = true;
    this.logger.info({ url, number }, '[Signal] Starting poll loop');
    void this.pollLoop(url, number);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.logger.info('[Signal] Stopped');
  }

  async send(recipient: string, text: string): Promise<void> {
    const url = process.env['SIGNAL_CLI_URL'];
    const number = process.env['SIGNAL_NUMBER'];
    if (!url || !number) return;

    const chunks = this.chunk(text, 4000);
    for (const chunk of chunks) {
      await fetch(`${url}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number,
          recipients: [recipient],
          message: chunk,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch((err) => this.logger.error({ err }, '[Signal] send failed'));
    }
  }

  protected get maxMessageLength(): number { return 4000; }

  private async pollLoop(url: string, number: string): Promise<void> {
    const interval = parseInt(process.env['SIGNAL_POLL_INTERVAL_MS'] ?? '5000', 10);

    while (this.running) {
      try {
        const res = await fetch(`${url}/v1/receive/${encodeURIComponent(number)}`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          const messages = await res.json() as SignalMessage[];
          for (const msg of messages) {
            await this.handleMessage(msg, number).catch(() => {});
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.warn({ err }, '[Signal] Poll error');
        }
      }

      await sleep(interval);
    }
  }

  private async handleMessage(msg: SignalMessage, _myNumber: string): Promise<void> {
    const text = msg.envelope.dataMessage?.message;
    if (!text) return;

    const sender = msg.envelope.sourceNumber ?? msg.envelope.source;
    if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(sender)) return;

    const groupId = msg.envelope.dataMessage?.groupInfo?.groupId;
    const conversationId = groupId
      ? `signal-group-${groupId}`
      : `signal-dm-${sender}`;

    await this.runAndDeliver(conversationId, sender, text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
