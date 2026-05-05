/**
 * Email platform adapter — polls IMAP for new messages, replies via SMTP.
 *
 * Required env:
 *   EMAIL_IMAP_HOST    — e.g. imap.gmail.com
 *   EMAIL_IMAP_PORT    — e.g. 993
 *   EMAIL_SMTP_HOST    — e.g. smtp.gmail.com
 *   EMAIL_SMTP_PORT    — e.g. 587
 *   EMAIL_USER         — your email address
 *   EMAIL_PASSWORD     — app password (not your main password)
 * Optional:
 *   EMAIL_ALLOWED_SENDERS — comma-separated email addresses
 *   EMAIL_POLL_INTERVAL_MS — polling interval (default 60000 = 1 min)
 *   EMAIL_SUBJECT_PREFIX  — prefix to filter subjects (default: [aos])
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

export class EmailAdapter extends PlatformAdapter {
  readonly name = 'email';
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private allowedSenders: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedSenders = new Set(
      (process.env['EMAIL_ALLOWED_SENDERS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const host = process.env['EMAIL_IMAP_HOST'];
    const user = process.env['EMAIL_USER'];
    const pass = process.env['EMAIL_PASSWORD'];

    if (!host || !user || !pass) {
      this.logger.warn('[Email] Missing env vars — skipping (need EMAIL_IMAP_HOST, EMAIL_USER, EMAIL_PASSWORD)');
      return;
    }

    const interval = parseInt(process.env['EMAIL_POLL_INTERVAL_MS'] ?? '60000', 10);
    this.running = true;

    // Poll immediately then on interval
    void this.pollInbox();
    this.timer = setInterval(() => void this.pollInbox(), interval);
    this.logger.info({ user, interval }, '[Email] Polling started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.logger.info('[Email] Stopped');
  }

  async send(to: string, text: string, opts?: { replyToId?: string }): Promise<void> {
    const smtpHost = process.env['EMAIL_SMTP_HOST'];
    const smtpPort = parseInt(process.env['EMAIL_SMTP_PORT'] ?? '587', 10);
    const user = process.env['EMAIL_USER'];
    const pass = process.env['EMAIL_PASSWORD'];
    if (!smtpHost || !user || !pass) return;

    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user, pass },
      });

      const subject = opts?.replyToId
        ? `Re: ${opts.replyToId}`
        : `[aos] Response`;

      await transporter.sendMail({
        from: user,
        to,
        subject,
        text,
      });
    } catch (err) {
      this.logger.error({ err }, '[Email] send failed');
    }
  }

  private async pollInbox(): Promise<void> {
    if (!this.running) return;
    const host = process.env['EMAIL_IMAP_HOST'];
    const port = parseInt(process.env['EMAIL_IMAP_PORT'] ?? '993', 10);
    const user = process.env['EMAIL_USER'];
    const pass = process.env['EMAIL_PASSWORD'];
    const prefix = process.env['EMAIL_SUBJECT_PREFIX'] ?? '[aos]';
    if (!host || !user || !pass) return;

    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host,
        port,
        secure: port === 993,
        auth: { user, pass },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Fetch unseen messages with matching subject prefix
        for await (const msg of client.fetch('1:*', { envelope: true, bodyStructure: true, source: true }, { uid: true })) {
          const subject = msg.envelope?.subject ?? '';
          if (!subject.includes(prefix)) continue;

          const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
          if (this.allowedSenders.size > 0 && !this.allowedSenders.has(from)) continue;

          // Extract text body
          const source = msg.source?.toString('utf-8') ?? '';
          const body = extractTextFromEmail(source);
          if (!body.trim()) continue;

          const conversationId = `email-${from.replace(/[^a-z0-9]/g, '-')}`;
          let response = '';

          for await (const chunk of this.engine.chat({ conversationId, message: body })) {
            if (chunk.type === 'text' && chunk.content) response += chunk.content;
            if (chunk.type === 'done') break;
          }

          if (response.trim()) {
            await this.send(from, response, { replyToId: subject });
          }

          // Mark as seen
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      this.logger.warn({ err }, '[Email] Poll error');
    }
  }
}

function extractTextFromEmail(raw: string): string {
  // Very basic text extraction — strip headers and HTML
  const bodyStart = raw.indexOf('\r\n\r\n');
  const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}
