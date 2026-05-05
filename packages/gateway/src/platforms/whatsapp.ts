/**
 * WhatsApp platform adapter — uses Meta Cloud API (official).
 *
 * Required env:
 *   WHATSAPP_ACCESS_TOKEN     — permanent access token from Meta Business
 *   WHATSAPP_PHONE_NUMBER_ID  — phone number ID from Meta dashboard
 *   WHATSAPP_VERIFY_TOKEN     — webhook verification token (any string)
 * Optional:
 *   WHATSAPP_PORT             — webhook HTTP port (default 3002)
 *   WHATSAPP_ALLOWED_NUMBERS  — comma-separated phone numbers (e.g. +1234567890)
 *
 * Meta Cloud API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

interface WAEntry {
  id: string;
  changes: Array<{
    value: {
      messages?: Array<{
        from: string;
        id: string;
        text?: { body: string };
        type: string;
      }>;
    };
  }>;
}

export class WhatsAppAdapter extends PlatformAdapter {
  readonly name = 'whatsapp';
  private server: ReturnType<typeof createServer> | null = null;
  private allowedNumbers: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedNumbers = new Set(
      (process.env['WHATSAPP_ALLOWED_NUMBERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const accessToken = process.env['WHATSAPP_ACCESS_TOKEN'];
    const phoneNumberId = process.env['WHATSAPP_PHONE_NUMBER_ID'];
    const verifyToken = process.env['WHATSAPP_VERIFY_TOKEN'];

    if (!accessToken || !phoneNumberId || !verifyToken) {
      this.logger.warn('[WhatsApp] Missing env vars — skipping (need WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN)');
      return;
    }

    const port = parseInt(process.env['WHATSAPP_PORT'] ?? '3002', 10);

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res, accessToken, phoneNumberId, verifyToken);
    });

    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    this.logger.info({ port }, '[WhatsApp] Webhook server listening');
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
    this.logger.info('[WhatsApp] Stopped');
  }

  async send(to: string, text: string): Promise<void> {
    const accessToken = process.env['WHATSAPP_ACCESS_TOKEN'];
    const phoneNumberId = process.env['WHATSAPP_PHONE_NUMBER_ID'];
    if (!accessToken || !phoneNumberId) return;

    const chunks = this.chunk(text, 4000);
    for (const chunk of chunks) {
      await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: chunk },
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch((err) => this.logger.error({ err }, '[WhatsApp] send failed'));
    }
  }

  protected get maxMessageLength(): number { return 4000; }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    accessToken: string,
    phoneNumberId: string,
    verifyToken: string,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost`);

    // Webhook verification (GET)
    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === verifyToken && challenge) {
        res.writeHead(200);
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end('Forbidden');
      }
      return;
    }

    // Incoming message (POST)
    if (req.method === 'POST') {
      const body = await readBody(req);
      res.writeHead(200);
      res.end('OK');

      let payload: { entry?: WAEntry[] };
      try { payload = JSON.parse(body); } catch { return; }

      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const msg of change.value.messages ?? []) {
            if (msg.type !== 'text' || !msg.text?.body) continue;
            const from = msg.from; // phone number e.g. "15551234567"
            if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(from) && !this.allowedNumbers.has(`+${from}`)) continue;
            const conversationId = `whatsapp-${from}`;
            await this.runAndDeliver(conversationId, from, msg.text.body);
          }
        }
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
